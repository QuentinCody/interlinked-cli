// B-Series PostToolUse inline checks: suppression density, hardcoded
// credentials, and unguarded self-recursion.
// Split out of b-series.ts (which re-exports these for back-compat).

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	isVendoredOrFixturePath,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Detect files with high suppression directive density.
 * A file where >2% of lines are @ts-expect-error / eslint-disable / biome-ignore
 * indicates systematic suppression rather than targeted exception handling.
 */
export function checkSuppressionDensity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	// 139-repo audit: generator output frequently emits high-density
	// suppression headers (e.g. OpenAPI's DefaultApi.ts). Density is
	// expected, not a bug; flagging it produces 66 FPs in one file.
	if (isGeneratedFile(content)) return [];

	const lines = content.split("\n");
	if (lines.length < 20) return []; // Too small to judge density

	const pattern = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore/;
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count++;
	}

	const density = count / lines.length;
	if (density > 0.02 && count >= 3) {
		return [
			{
				line: 1,
				text: `High suppression density: ${count} directives in ${lines.length} lines (${(density * 100).toFixed(1)}%). Fix the underlying issues instead of suppressing them.`,
			},
		];
	}

	return [];
}

/**
 * Detect hardcoded credentials in source code.
 * Patterns like `password = "..."`, `apiKey = "..."` with literal string values.
 */
/** Prefixes/values that indicate placeholder/demo data, not real secrets */
const SAFE_VALUE_PREFIXES = [
	"example",
	"test",
	"mock",
	"demo",
	"placeholder",
	"changeme",
	"your-",
	"your_",
	"xxx",
	"dummy",
	"fake",
	"sample",
	"replace",
	"insert",
	"todo",
	"fixme",
];
const SAFE_VALUE_EXACT = new Set([
	"disabled",
	"none",
	"null",
	"undefined",
	"empty",
	"redacted",
	"change_me",
	"change-me",
	"password",
	"secret",
]);

/** Variable name suffixes that indicate the variable describes a credential, not holds one */
const DESCRIPTIVE_SUFFIX_RE =
	/(?:Pattern|Regex|Format|Validator|Schema|Label|Field|Name|Header|Hint|Placeholder|Rule|Length|Min|Max|Type|Key|Column|Prop|Attr)$/i;

/** Values that are type annotations / schema definitions, not secret values */
const TYPE_ANNOTATION_RE =
	/^(?:z\.|string|String|number|Number|boolean|Boolean|Buffer|Uint8Array|any|unknown|object)/;

/** A hardcoded-credential scan is skipped for test, vendored/fixture, and
 *  generated files. Everywhere else the `name = "value"` shape is scanned
 *  regardless of language. */
function isCredScanExempt(content: string, filePath: string): boolean {
	return isTestFile(filePath) || isVendoredOrFixturePath(filePath) || isGeneratedFile(content);
}

export function checkHardcodedCredentials(content: string, filePath: string): InlineMatch[] {
	// No extension gate — credential assignment looks identical across every
	// language and config format (ungated 2026-06-12; a hardcoded key is a leak
	// in Python/Go/PHP/Ruby/YAML/.env just as much as in JS/TS).
	if (isCredScanExempt(content, filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// `(?::=|[:=])` matches `=` (most langs), `:` (YAML / struct fields), and
	// Go's `:=` walrus. `==` can't match — the trailing `=` leaves no quote.
	const credPattern =
		/\b(password|passwd|secret|api_?key|api_?secret|auth_?token|access_?token|private_?key)(\w*)\s*(?::=|[:=])\s*["']([^"']{4,})["']/i;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = nonNull(strippedLines[i]).match(credPattern);
		if (!m) continue;

		const varSuffix = m[2]; // e.g., "Validator" from "passwordValidator"
		const value = nonNull(m[3]); // the string value between quotes
		const valueLower = value.toLowerCase();

		// Skip if variable name has a descriptive suffix (passwordPattern, secretName, etc.)
		if (varSuffix && DESCRIPTIVE_SUFFIX_RE.test(varSuffix)) continue;

		// Skip known placeholder/demo values
		if (SAFE_VALUE_EXACT.has(valueLower)) continue;
		if (SAFE_VALUE_PREFIXES.some((p) => valueLower.startsWith(p))) continue;

		// Skip type annotations and schema definitions (z.string(), string, etc.)
		if (TYPE_ANNOTATION_RE.test(value)) continue;

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Net brace delta for one line: how much `{`/`}` on this line shifts an
 * outer running brace-depth counter. Used to track whether a scan position
 * is still inside a function body.
 */
function lineBraceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		if (ch === "}") delta--;
	}
	return delta;
}

/**
 * Does this line look like a base-case guard (explicit control flow, a
 * ternary, a logical operator, a length/size check, or a comparison)?
 * Heuristic only — used to suppress a self-call match when a guard was
 * seen anywhere between the function definition and the self-call.
 */
function lineLooksLikeGuard(line: string): boolean {
	return (
		/^(if|switch|return|while|for)\b/.test(line) ||
		/\?\s*\S/.test(line) ||
		/\b(&&|\|\|)\b/.test(line) ||
		/\.(length|size)\b/.test(line) ||
		/[!=]==?/.test(line) ||
		/[<>]=?/.test(line)
	);
}

/**
 * Scan forward from a function definition (already known to span multiple
 * lines) for a self-call that has no preceding guard, stopping at 15 lines
 * ahead or once the function body closes — whichever comes first.
 * Returns the first unguarded self-call found, or null.
 */
function findUnguardedSelfCall(
	strippedLines: string[],
	originalLines: string[],
	defLineIdx: number,
	funcName: string,
	initialBraceDepth: number,
): InlineMatch | null {
	// Build a self-call test that doesn't use dynamic RegExp (avoid ReDoS risk)
	const selfCallNeedle = `${funcName}(`;
	const selfCallNeedleSpace = `${funcName} (`;

	let fnBraceDepth = initialBraceDepth;
	let hasGuard = false;

	for (let j = defLineIdx + 1; j < Math.min(defLineIdx + 15, strippedLines.length); j++) {
		const line = nonNull(strippedLines[j]).trim();
		// Track brace depth — stop when we leave the function body
		fnBraceDepth += lineBraceDelta(nonNull(strippedLines[j]));
		if (fnBraceDepth <= 0) break; // Exited the function body

		if (lineLooksLikeGuard(line)) {
			hasGuard = true;
		}
		// Check for self-call using string matching (no dynamic RegExp)
		if (line.includes(selfCallNeedle) || line.includes(selfCallNeedleSpace)) {
			if (!hasGuard) {
				return {
					line: j + 1,
					text: nonNull(originalLines[j]).trim().slice(0, 150),
				};
			}
			break;
		}
	}

	return null;
}

/**
 * Detect functions that call themselves without a visible base case guard.
 * Heuristic: function definition followed by a self-call without an if/switch/return guard.
 * Uses stripped content for self-call detection to avoid matching function names in comments/strings.
 */
export function checkInfiniteRecursion(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const matches: InlineMatch[] = [];
	const originalLines = content.split("\n");
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const funcNameRegex =
		/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])*=>)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const funcMatch = nonNull(strippedLines[i]).match(funcNameRegex);
		if (!funcMatch) continue;
		const funcName = funcMatch[1] || funcMatch[2];
		if (!funcName) continue;

		// Track brace depth to ensure self-call is inside the function body.
		// If braces already balanced on the definition line, it's a one-liner — skip.
		const initialBraceDepth = lineBraceDelta(nonNull(strippedLines[i]));
		if (initialBraceDepth <= 0) continue;

		const found = findUnguardedSelfCall(strippedLines, originalLines, i, funcName, initialBraceDepth);
		if (found) matches.push(found);
	}

	return matches;
}
