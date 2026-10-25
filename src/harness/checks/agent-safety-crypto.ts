// Agent Safety Checks — Cross-language crypto / TLS / filesystem safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { nonNull } from "../../lib/non-null.js";
import { isWeakHashSignatureAt, stringOpensMessageCall, stripWeakHashNonCalls } from "./crypto-scan-exemptions.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Shared helpers for the crypto / TLS content scans
// ===========================================

/** Prose-only extensions: a doc that NAMES an anti-pattern is not code that uses it. */
const PROSE_DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

/**
 * Blank the interior of Python triple-quoted strings (multi-line docstrings),
 * keeping line count. The shared lexer fallback only blanks SINGLE-line
 * docstrings, so a docstring that mentions `verify=False` or `hashlib.md5(`
 * across lines reached the regexes as code. Applied to `.py` only.
 */
function blankPythonTripleQuoted(content: string, filePath: string): string {
	if (getExtension(filePath) !== ".py") return content;
	return content.replace(/("""|''')[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * True when `re` matches somewhere inside the brace-delimited literal that
 * encloses position `at` on line `i` (the Go struct / JS object literal the
 * flagged property belongs to). Walks outward from the match, counting braces
 * on the strings-blanked lines, and stops at the literal's own `{` / `}` so a
 * SIBLING literal never vouches for this one. Bounded to 60 lines each way.
 */
function enclosingLiteralHas(lines: string[], i: number, at: number, re: RegExp): boolean {
	const start = Math.max(0, i - 60);
	const text = lines.slice(start, i + 61).join("\n");
	const offset = lines.slice(start, i).reduce((length, line) => length + line.length + 1, 0) + at;
	let depth = 0;
	let open = -1;
	for (let j = offset - 1; j >= 0; j--) {
		if (text[j] === "}") depth++;
		else if (text[j] === "{") {
			if (depth === 0) { open = j; break; }
			depth--;
		}
	}
	if (open < 0) return false;
	let ownMembers = "";
	for (let j = open + 1; j < text.length; j++) {
		const ch = text[j] ?? "";
		if (ch === "{") depth++;
		else if (ch === "}") {
			if (depth === 0) return re.test(ownMembers);
			depth--;
		}
		ownMembers += depth === 0 && ch !== "}" ? ch : " ";
	}
	return false;
}

// ===========================================
// Row 24 — `ubs_tls_verify_disabled` (cross-language)
// ===========================================

const TLS_ENV_VAR = "NODE_TLS_REJECT_UNAUTHORIZED";
/** A plain `=` — not the `=` inside `==` / `===` / `!=` / `<=` / `>=`. */
const ASSIGN_EQ = "(?<![=!<>])=(?!=)";
/** The env-var name as a code identifier (strings-blanked view). */
const TLS_ENV_NAME_RE = new RegExp(`\\b${TLS_ENV_VAR}\\b`);
/** Code-level assignment to 0: `process.env.X = "0"`, shell `X=0`, Dockerfile `ENV X=0`, `.env`. */
const TLS_ENV_ASSIGN_RE = new RegExp(`\\b${TLS_ENV_VAR}\\b[\\s\\S]{0,20}?${ASSIGN_EQ}\\s*["']?0\\b`);
/** Subscript assignment with the name as a string key: `process.env["X"] = "0"`, `os.environ["X"] = "0"`. */
const TLS_ENV_BRACKET_RE = new RegExp(`["']${TLS_ENV_VAR}["']\\s*\\]\\s*${ASSIGN_EQ}\\s*["']?0\\b`);
/** A shell command carried in a string, where the assignment LEADS the string: a package.json
 *  script, `execSync("X=0 node …")`, `cross-env X=0 …`. Prose that merely names `X=0`
 *  mid-sentence (a guard's error message) does not have this shape. */
const TLS_ENV_SHELL_STRING_RE = new RegExp(
	`["'\`]\\s*(?:(?:export|env|cross-env|set)\\s+)?(?:[A-Za-z_]\\w*=\\S*\\s+)*${TLS_ENV_VAR}=["']?0\\b`,
);
/** The shell-string shape, minus a string that opens a logger / error call:
 *  `console.warn("X=0 detected …")` is a guard's message, not a command. */
function tlsEnvShellStringFires(line: string): boolean {
	const m = TLS_ENV_SHELL_STRING_RE.exec(line);
	return m !== null && !stringOpensMessageCall(line, m.index);
}
/** Python / Go shapes that have no legitimate same-literal companion. The
 *  `_create_unverified_context` arm skips `is` / `is not` / `==` / `!=`
 *  comparisons: a guard that DETECTS the monkeypatch names the symbol too. */
const TLS_CODE_RE =
	/\bverify\s*=\s*False\b|\bcheck_hostname\s*=\s*False\b|(?<!\bis\s+(?:not\s+)?|[=!]=\s*)\bssl\._create_unverified_context\b/;
/** Go `InsecureSkipVerify: true` — exempt when the SAME `tls.Config` literal installs its own
 *  verifier (`VerifyPeerCertificate` / `VerifyConnection`): the documented pinning idiom. */
const TLS_INSECURE_SKIP_RE = /\bInsecureSkipVerify\s*:\s*true\b/;
const TLS_GO_CUSTOM_VERIFIER_RE = /\bVerify(?:PeerCertificate|Connection)\s*:/;
/** Node `rejectUnauthorized: false` — exempt when the SAME options literal carries
 *  `requestCert: true` (a SERVER asking for an optional client cert; the server still
 *  presents its own cert, so no MitM vector). The `(?!\s*;)` skips a TS type literal
 *  member (`{ rejectUnauthorized: false; reason: string }`), which has no runtime value. */
const TLS_REJECT_UNAUTH_RE = /\brejectUnauthorized\s*:\s*false\b(?!\s*;)/;
const TLS_REQUEST_CERT_RE = /\brequestCert\s*:\s*true\b/;

/**
 * Detect TLS verification disabled across languages.
 *
 * Catches the common Python (`requests` / `httpx` / stdlib `ssl`), Go
 * (`tls.Config{}`), and Node (`https.request` / `tls.connect` / env var)
 * idioms for turning off the TLS peer-cert check. Each is a man-in-the-middle
 * vector unless the call sits behind a controlled proxy with a documented
 * justification.
 *
 * Shapes covered:
 *   - `verify=False`                          (Python requests / httpx)
 *   - `InsecureSkipVerify: true`              (Go crypto/tls)
 *   - `rejectUnauthorized: false`             (Node https / tls)
 *   - `NODE_TLS_REJECT_UNAUTHORIZED=0`        (Node env var)
 *   - `ssl._create_unverified_context()`      (Python stdlib bypass)
 *   - `check_hostname=False`                  (Python stdlib / httpx)
 *
 * Exempt (2026-10-21 adversarial review): test files (a test against its own
 * self-signed fixture server, or asserting `verify=False` was forwarded),
 * prose docs, Python docstrings, env-var COMPARISONS (`=== "0"`) and prose
 * strings that name `X=0` (a guard's warning), Go pinning (`InsecureSkipVerify`
 * beside `VerifyPeerCertificate` / `VerifyConnection` in the same literal),
 * a Node server's optional-client-cert options (`requestCert: true` in the
 * same literal), and identity/equality comparisons against
 * `ssl._create_unverified_context`.
 */
export function checkTlsVerifyDisabled(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (PROSE_DOC_EXTS.has(getExtension(filePath))) return [];
	const source = blankPythonTripleQuoted(content, filePath);
	const originalLines = content.split("\n");
	// Code-level shapes must NOT fire inside string literals (`const msg =
	// "verify=False is unsafe"` is documentation), so they scan the
	// strings-blanked view. The env-var value lives in a string (`= "0"`), so
	// those shapes scan the comment-only-stripped view (strings preserved).
	const strippedLines = stripCommentsAndStrings(source).split("\n");
	const commentStrippedLines = stripComments(source).split("\n");

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const code = strippedLines[i] ?? "";
		const withStrings = commentStrippedLines[i] ?? "";
		const skipAt = code.search(TLS_INSECURE_SKIP_RE);
		const rejectAt = code.search(TLS_REJECT_UNAUTH_RE);
		const fired =
			TLS_CODE_RE.test(code) ||
			(skipAt >= 0 && !enclosingLiteralHas(strippedLines, i, skipAt, TLS_GO_CUSTOM_VERIFIER_RE)) ||
			(rejectAt >= 0 && !enclosingLiteralHas(strippedLines, i, rejectAt, TLS_REQUEST_CERT_RE)) ||
			(TLS_ENV_NAME_RE.test(code) && TLS_ENV_ASSIGN_RE.test(withStrings)) ||
			TLS_ENV_BRACKET_RE.test(withStrings) ||
			tlsEnvShellStringFires(withStrings);
		if (fired) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// ===========================================
// Row 26 — `ubs_weak_hash` (cross-language)
// ===========================================

/**
 * `ubs_aes_ecb_mode` — AES in ECB mode leaks plaintext structure: identical
 * 16-byte blocks encrypt to identical ciphertext, so an attacker can detect
 * patterns and substitute ciphertext blocks. The safe replacements are GCM
 * (AEAD; integrity + confidentiality) or CBC with a separately-derived HMAC.
 * pre_warn / error.
 *
 * Cross-language shapes:
 *   - Python `pycryptodome`:  `AES.MODE_ECB`
 *   - Python `cryptography`:  `modes.ECB(`
 *   - Node `createCipheriv`:  string `"aes-128-ecb"` / `"aes-256-ecb"` / etc.
 *   - Go `crypto/aes`:        `cipher.NewECBEncrypter` (rare; flag for review)
 *
 * Node algorithm strings live inside literals, so the Node shape needs the
 * comment-stripped (but string-preserving) view rather than the strip-strings
 * pass.
 */
export function checkAesEcbMode(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const commentOnlyStripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const commentOnlyLines = commentOnlyStripped.split("\n");

	const codeRe = /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|\bcipher\.NewECB(?:En|De)crypter\b/;
	const stringRe = /["'`]aes-\d{2,4}-ecb["'`]/i;

	const matches: InlineMatch[] = [];
	const flagged = new Set<number>();
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const fired =
			codeRe.test(strippedLines[i] ?? "") || stringRe.test(commentOnlyLines[i] ?? "");
		if (fired && !flagged.has(i)) {
			flagged.add(i);
			matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
		}
	}
	return matches;
}

// Form 1: `\b(?:md5|sha1)\s*\(` case-insensitive — catches `md5(buf)`,
// `MD5(buf)`, `hashlib.md5(...)` where the algorithm name is a code
// identifier. (The Go `md5.New()` form has a `.` before the paren and is NOT
// matched — a known gap, recorded rather than widened here.)
const WEAK_HASH_DIRECT_RE = /\b(?:md5|sha1)\s*\(/i;
// Form 2: Node `crypto.createHash("md5")` / `createHash('sha1')` /
// `createHash(\`md5\`)`. The algorithm lives inside a string literal, so this
// form scans the comment-stripped (but string-preserving) view.
const WEAK_HASH_CREATE_RE = /\bcreateHash\s*\(\s*["'`](?:md5|sha1)["'`]/i;
/** A DECLARATION named md5/sha1 is not a call: `function md5(`, `def sha1(`,
 *  Go `func md5(`, Rust `fn md5(`. The use sites still fire. */
const WEAK_HASH_DECL_KEYWORD_RE = /\b(?:function|def|func|fn)\s+(?:md5|sha1)\s*\(/i;
/** Python's own non-security marker (3.9+, PEP 644 / FIPS): `hashlib.md5(x, usedforsecurity=False)`.
 *  bandit B324 honours it too. Looked for on the call's line and the 5 lines after it
 *  (a multi-line call carries the keyword later). */
const USED_FOR_SECURITY_FALSE_RE = /\busedforsecurity\s*=\s*False\b/;
/** Gravatar REQUIRES an MD5 of the e-mail; there is no stronger alternative. */
const GRAVATAR_RE = /gravatar/i;

/**
 * Detect weak cryptographic hash usage (MD5, SHA-1) across languages.
 *
 * Plan 04 §4.1 regex: `\b(?:md5|sha1)\s*\(` (case-insensitive).
 *
 * Both MD5 and SHA-1 are broken for collision resistance. Acceptable for
 * non-security checksums (cache keys, file hashing) but fired anywhere a
 * literal call appears so the agent considers the choice. Test files are
 * exempt because checksum fixtures and golden hashes routinely embed MD5
 * outputs.
 *
 * Exempt (2026-10-21 adversarial review): prose docs and Python docstrings,
 * declarations named md5/sha1 (keyword-led and member signatures), calls that
 * carry Python's `usedforsecurity=False`, and a call on a line (or under a
 * line) naming Gravatar. Protocol-mandated uses with no lexical marker (git
 * object ids, S3 `Content-MD5`) still fire; use the inline directive there.
 */
export function checkWeakHash(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (PROSE_DOC_EXTS.has(getExtension(filePath))) return [];

	const source = blankPythonTripleQuoted(content, filePath);
	const originalLines = content.split("\n");
	const strippedLines = stripCommentsAndStrings(source).split("\n");
	// Comment-only strip preserves string contents so we can match Node's
	// `crypto.createHash("md5")` form, where the algorithm name lives inside
	// a string literal that `stripCommentsAndStrings` would have blanked.
	// Comments still get blanked so `// createHash("md5") example` doesn't
	// fire a false positive.
	const commentStrippedLines = stripComments(source).split("\n");

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const code = stripWeakHashNonCalls(strippedLines[i] ?? "", filePath);
		const directCall =
			WEAK_HASH_DIRECT_RE.test(code) &&
			!WEAK_HASH_DECL_KEYWORD_RE.test(code) &&
			!isWeakHashSignatureAt(strippedLines, i);
		if (!directCall && !WEAK_HASH_CREATE_RE.test(commentStrippedLines[i] ?? "")) continue;
		if (USED_FOR_SECURITY_FALSE_RE.test(strippedLines.slice(i, i + 6).join("\n"))) continue;
		if (GRAVATAR_RE.test(`${originalLines[i - 1] ?? ""}\n${originalLines[i] ?? ""}`)) continue;
		matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
	}
	return matches;
}

// ===========================================
// `ubs_weak_random_security` (cross-language) — DW test-adoption P0.5 flagship
// ===========================================

/** Security-context terms that, when present on the same line as a weak RNG
 *  call, turn "harmless jitter/sampling" into "a secret from a predictable
 *  PRNG". Matched against a CAMEL/SNAKE-NORMALIZED line (see
 *  {@link lineHasSecurityContext}) so `resetToken`, `apiKey`, `sessionId` all
 *  expose their term. `seed` is absent (seeding is a determinism idiom); bare
 *  `key` is absent (FP on `primaryKey`/`keyboard`) — only the `api key` /
 *  `private key` / `secret key` compounds count. */
const SECURITY_TERMS_RE =
	/\b(?:secret|token|password|passwd|passphrase|nonce|salt|otp|csrf|credential|apikey|api key|private key|secret key|session token|session id|sessionid|iv)\b/;

/** True when a code line's identifiers carry a security-context term. Splits
 *  camelCase and snake/kebab into words first so compound identifiers match. */
function lineHasSecurityContext(codeLine: string): boolean {
	const normalized = codeLine
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.toLowerCase();
	return SECURITY_TERMS_RE.test(normalized);
}

/**
 * `ubs_weak_random_security` — Python's `random.*` module used to generate a
 * security-bearing value (token / key / nonce / salt / password / OTP / IV).
 * `random.*` is a Mersenne-Twister PRNG seeded from predictable state, so an
 * attacker who observes a few outputs can predict the rest — fine for jitter or
 * sampling, unsafe for anything the security model relies on.
 *
 * SCOPE: Python only. The JS `Math.random()`-for-security case is owned by the
 * A3 content-quality write-guard (`evaluator/write-content-guards-content-quality.ts`,
 * `collectInsecureRandomWarning`) — matching it here too would double-warn.
 * This closes the Python gap A3 never covered AND gives it a `verify` surface.
 *
 * FP control: fires ONLY when a `random.<weakFn>()` call AND a security-context
 * term share a line (post / warning / default). `secrets.*` and
 * `random.SystemRandom()` (the secure forms) are not matched. Test files are
 * exempt (fixtures generate throwaway ids freely). Companion: the secure
 * replacement is the `secrets` module.
 */
export function checkWeakRandom(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (getExtension(filePath) !== ".py") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	// Python module-level `random.<weakFn>()`. `secrets.*` and
	// `random.SystemRandom()` (the secure forms) are not matched.
	const weakRandomRe =
		/\brandom\.(?:random|randint|randrange|choice|choices|getrandbits|sample|shuffle|uniform)\s*\(/;

	const matches: InlineMatch[] = [];
	const flagged = new Set<number>();
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i] ?? "";
		if (weakRandomRe.test(line) && lineHasSecurityContext(line) && !flagged.has(i)) {
			flagged.add(i);
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

type WalkerDecl = { name: string; line: number };

/**
 * Find every function/method declaration in the strings-blanked source, as a
 * `{ name, line }` list. Used by {@link checkRecursiveWalkerLstat} to seed the
 * body scan. Internal helper — recognizes the three declaration shapes
 * (`function f(`, `const f = (`/`function`, and class-method headers) while
 * excluding control-flow keywords from the method form.
 */
function collectWalkerDecls(sLines: string[]): WalkerDecl[] {
	const decls: WalkerDecl[] = [];
	const declRe1 = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/;
	const declRe2 =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\()/;
	const declRe3 =
		/^\s+(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?!(?:if|for|while|switch|catch|do|with|return|new|typeof|throw|delete|void|await|yield)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{\s*$/;
	for (let i = 0; i < sLines.length; i++) {
		const m1 = nonNull(sLines[i]).match(declRe1);
		if (m1) {
			decls.push({ name: nonNull(m1[1]), line: i });
			continue;
		}
		const m2 = nonNull(sLines[i]).match(declRe2);
		if (m2) {
			decls.push({ name: nonNull(m2[1]), line: i });
			continue;
		}
		const m3 = nonNull(sLines[i]).match(declRe3);
		if (m3) decls.push({ name: nonNull(m3[1]), line: i });
	}
	return decls;
}

/**
 * Locate the byte offset just inside the first `{` at or after `startLine`.
 * Returns the absolute index of the brace, or -1 if no `{` is found before the
 * end of file. `linePrefixLen[i]` is the cumulative byte length of lines `0..i-1`
 * (each terminated by one `\n`), so the returned offset indexes into the joined
 * `stripped` source. Internal helper for {@link checkRecursiveWalkerLstat}.
 */
function findWalkerBodyOpen(
	sLines: string[],
	linePrefixLen: number[],
	startLine: number,
): number {
	for (let i = startLine; i < sLines.length; i++) {
		const idx = nonNull(sLines[i]).indexOf("{");
		if (idx !== -1) return nonNull(linePrefixLen[i]) + idx;
	}
	return -1;
}

/**
 * Given the open-brace offset of a function body in `stripped`, find the
 * matching close-brace offset via depth counting. Returns -1 if unbalanced.
 * Internal helper for {@link checkRecursiveWalkerLstat}.
 */
function findWalkerBodyClose(stripped: string, bodyOpen: number): number {
	let depth = 0;
	for (let i = bodyOpen; i < stripped.length; i++) {
		const c = stripped[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Decide whether one declaration's body is an unsafe recursive walker and, if
 * so, return the {@link InlineMatch} pointing at its `statSync(` call. Returns
 * `null` when the body is balanced-but-safe or when any of the four conditions
 * fails. Internal helper for {@link checkRecursiveWalkerLstat}; takes the
 * pre-computed `stripped` source plus the body span so the orchestrator stays a
 * thin loop.
 */
function walkerLstatMatch(
	decl: WalkerDecl,
	stripped: string,
	oLines: string[],
	sLines: string[],
	linePrefixLen: number[],
): InlineMatch | null {
	const bodyOpen = findWalkerBodyOpen(sLines, linePrefixLen, decl.line);
	if (bodyOpen < 0) return null;
	const bodyClose = findWalkerBodyClose(stripped, bodyOpen);
	if (bodyClose < 0) return null;
	const body = stripped.slice(bodyOpen + 1, bodyClose);

	if (!/\breaddirSync\s*\(/.test(body)) return null;
	const selfRe = new RegExp("(?:\\bthis\\.)?\\b" + decl.name + "\\b\\s*\\(");
	if (!selfRe.test(body)) return null;
	if (!/\bstatSync\s*\(/.test(body)) return null;
	if (/\blstatSync\s*\(/.test(body)) return null;

	const sm = body.match(/\bstatSync\s*\(/);
	if (!sm || sm.index === undefined) return null;
	const absStat = bodyOpen + 1 + sm.index;
	const lineNum = stripped.slice(0, absStat).split("\n").length;
	return {
		line: lineNum,
		text: (oLines[lineNum - 1] ?? "").trim().slice(0, 150),
	};
}

/**
 * Detect recursive directory walkers that gate recursion on `statSync(...)`
 * instead of `lstatSync(...)`. Without lstat, the walker follows symlinks —
 * leaving the project tree, or looping indefinitely on a cycle.
 *
 * A function fires this check when ALL hold inside its body:
 *   1. calls `readdirSync(...)`             (it is listing a directory)
 *   2. calls itself or `this.<name>(...)`   (it recurses)
 *   3. calls `statSync(...)`                (the unsafe stat)
 *   4. does NOT also call `lstatSync(...)`  (no symlink awareness)
 */
export function checkRecursiveWalkerLstat(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bstatSync\s*\(/.test(content)) return [];
	if (!/\breaddirSync\s*\(/.test(content)) return [];

	const stripped = stripCommentsAndStrings(content);
	const sLines = stripped.split("\n");
	const oLines = content.split("\n");

	const linePrefixLen: number[] = [0];
	for (const ln of sLines) {
		linePrefixLen.push(nonNull(linePrefixLen[linePrefixLen.length - 1]) + ln.length + 1);
	}

	const decls = collectWalkerDecls(sLines);

	const matches: InlineMatch[] = [];
	for (const d of decls) {
		if (matches.length >= 10) break;
		const m = walkerLstatMatch(d, stripped, oLines, sLines, linePrefixLen);
		if (m) matches.push(m);
	}
	return matches;
}
