// Swift / iOS security checks: weak crypto, insecure URLs, secret storage,
// ATS bypass in Info.plist.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

const MATCH_LIMIT = 10;

/**
 * Detect MD5 / SHA-1 / DES usage in Swift. Three sources:
 *   1. CommonCrypto C bindings: `CC_MD5`, `CC_SHA1`, `kCCAlgorithmDES`,
 *      `kCCAlgorithm3DES`.
 *   2. CryptoKit's deliberately-named `Insecure.MD5` / `Insecure.SHA1`
 *      legacy-interop wrappers.
 *   3. Bridged Foundation: `CommonHMACAlgorithm.MD5`.
 *
 * MD5 is collision-broken (2004), SHA-1 is collision-broken (2017), DES is
 * brute-forceable in seconds on modern hardware. The only legitimate uses
 * are bug-for-bug interop with legacy protocols.
 */
export function checkSwiftWeakCrypto(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\b(?:CC_MD5|CC_SHA1|CC_MD2|CC_MD4|kCCAlgorithmDES|kCCAlgorithm3DES|Insecure\.(?:MD5|SHA1))\b/,
		MATCH_LIMIT,
	);
}

/**
 * Detect plain HTTP URL literals in Swift source. Skips:
 *   - localhost / 127.0.0.1 / 0.0.0.0 / [::1]
 *   - *.local (Bonjour / mDNS, explicitly ATS-permitted)
 *   - 192.168.*.* / 10.*.*.* / 172.16-31.*.*  (RFC 1918 private)
 *   - comment lines
 *
 * Two pass: we scan the original lines (NOT the stripped version) because the
 * URL literal lives inside a string and `stripCommentsAndStrings` would blank
 * it. We skip lines that begin with comment markers via a separate check.
 */
export function checkSwiftHttpUrlLiteral(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// `"http://<host>..."` where host is NOT a recognized local form.
	const re =
		/["']http:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|[\w-]+\.local(?:\b|[:/])))[^"']+["']/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = nonNull(originalLines[i]);
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
			continue;
		}
		if (re.test(line)) {
			matches.push({ line: i + 1, text: line.trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect storage of a sensitive value in `UserDefaults` or `@AppStorage`.
 *
 * Sensitive keys (regex on key NAME, not value): password, passwd, pwd,
 * secret, token, api[_-]?key, apikey, private[_-]?key, access[_-]?token,
 * refresh[_-]?token, auth[_-]?token, credential, authorization, session[_-]?id.
 *
 * Both styles are detected:
 *   - `UserDefaults.standard.set(value, forKey: "password")`
 *   - `UserDefaults(suiteName: "x").set(value, forKey: "apiKey")`
 *   - `UserDefaults.standard["password"] = ...`
 *   - `@AppStorage("authToken") var authToken: String = ""`
 */
const SENSITIVE_KEY_RE =
	/\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|credential|authorization|session[_-]?id)\b/i;

const USER_DEFAULTS_CALL_RE = /\bUserDefaults\s*(?:\.[A-Za-z_]\w*|\([^)]*\))/;
const APP_STORAGE_RE = /@AppStorage\s*\(\s*["']([^"']+)["']/;

/**
 * Decide whether one Swift line stores a sensitive value in `UserDefaults` or
 * `@AppStorage`, returning the match to record (or null for a miss). Comment
 * lines never match.
 */
function secretUserDefaultsMatch(line: string, lineNumber: number): InlineMatch | null {
	const trimmed = line.trimStart();
	if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
		return null;
	}
	const hit: InlineMatch = { line: lineNumber, text: line.trim().slice(0, 150) };

	const ap = APP_STORAGE_RE.exec(line);
	if (ap && SENSITIVE_KEY_RE.test(nonNull(ap[1]))) return hit;

	if (!USER_DEFAULTS_CALL_RE.test(line)) return null;

	const forKey = /forKey\s*:\s*["']([^"']+)["']/.exec(line);
	if (forKey && SENSITIVE_KEY_RE.test(nonNull(forKey[1]))) return hit;

	const subscript = /\[\s*["']([^"']+)["']\s*\]\s*=/.exec(line);
	if (subscript && SENSITIVE_KEY_RE.test(nonNull(subscript[1]))) return hit;

	return null;
}

export function checkSwiftUserDefaultsForSecret(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (getExtension(filePath) !== ".swift") return [];
	if (isTestFile(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const hit = secretUserDefaultsMatch(nonNull(originalLines[i]), i + 1);
		if (hit) matches.push(hit);
	}
	return matches;
}

/**
 * Detect `NSAllowsArbitraryLoads` / `NSExceptionAllowsInsecureHTTPLoads` set
 * to true (or YES) in an Info.plist (or any `*.plist`).
 *
 * `NSAllowsArbitraryLoads = true` is a global ATS bypass — every HTTP request
 * becomes insecure. The scoped form `NSExceptionAllowsInsecureHTTPLoads = true`
 * under `NSExceptionDomains.<host>` is narrower (one host) but still grants
 * cleartext for that host; both deserve a flag, leaving the dev to choose
 * scoping intentionally.
 */
const ATS_TRUE_RE = /<true\s*\/>|<string>\s*YES\s*<\/string>/i;
const ATS_FALSE_RE = /<false\s*\/>|<string>\s*NO\s*<\/string>/i;
const ATS_KEY_RE =
	/<key>\s*(?:NSAllowsArbitraryLoads|NSExceptionAllowsInsecureHTTPLoads|NSAllowsArbitraryLoadsInWebContent|NSAllowsArbitraryLoadsForMedia)\s*<\/key>/;

/**
 * Read the value that follows an ATS key on the next 1–3 lines (the indented
 * plist flavor). The first true/false marker wins; nothing found means false.
 */
function atsValueOnFollowingLines(lines: string[], keyIndex: number): boolean {
	for (let j = keyIndex + 1; j < Math.min(keyIndex + 4, lines.length); j++) {
		const next = nonNull(lines[j]);
		if (ATS_TRUE_RE.test(next)) return true;
		if (ATS_FALSE_RE.test(next)) return false;
	}
	return false;
}

/**
 * Decide whether the line at `keyIndex` is an ATS bypass key set to true.
 * Plist formatting comes in two flavors: indented (`<key>...</key>` on one
 * line, value on the next) and compact (everything on one line), so the
 * current line is checked first, then the next 1–3.
 */
function atsBypassEnabledAt(lines: string[], keyIndex: number): boolean {
	const line = nonNull(lines[keyIndex]);
	if (!ATS_KEY_RE.test(line)) return false;
	if (ATS_TRUE_RE.test(line)) return true;
	if (ATS_FALSE_RE.test(line)) return false;
	return atsValueOnFollowingLines(lines, keyIndex);
}

export function checkSwiftAtsArbitraryLoads(content: string, filePath: string): InlineMatch[] {
	const lower = filePath.toLowerCase();
	if (!lower.endsWith(".plist")) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!atsBypassEnabledAt(originalLines, i)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}
