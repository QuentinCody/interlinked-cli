// Taste checks — opinionated code quality (naming, complexity, design smells).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	collectFunctionSignature,
	countTopLevelCommas,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Taste Checks — Opinionated Code Quality
// ===========================================
// These checks encode design opinions, not correctness rules.
// Each flags a pattern that makes code harder to understand, maintain,
// or extend — even when technically correct. They run as PostToolUse
// suggestions and should produce actionable guidance.

/**
 * Detect function calls with 2+ boolean literal arguments at the top level.
 * `createUser("alice", true, false)` forces readers to jump to the definition
 * to understand what those booleans mean.
 *
 * Suggests using an options object instead:
 *   `createUser("alice", { admin: true, verified: false })`
 *
 * Only runs on JS/TS files. Skips test files.
 */
export function checkBooleanTrap(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]);

		// Must have a function call on this line
		if (!/\w\s*\(/.test(line)) continue;

		// Count boolean literals at top-level argument positions
		if (countTopLevelBooleanArgs(line) < 2) continue;

		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

/** Count boolean literal arguments at the top level of any function call on a line */
function countTopLevelBooleanArgs(line: string): number {
	let maxBoolCount = 0;
	const callPattern = /\w\s*\(/g;

	for (
		let callMatch = callPattern.exec(line);
		callMatch !== null;
		callMatch = callPattern.exec(line)
	) {
		const start = callMatch.index + callMatch[0].length;
		let depth = 0;
		let boolCount = 0;
		let argStart = start;

		for (let j = start; j < line.length; j++) {
			const ch = line[j];
			if (ch === "(" || ch === "[" || ch === "{") {
				depth++;
			} else if (ch === ")" || ch === "]" || ch === "}") {
				if (depth === 0) {
					const arg = line.slice(argStart, j).trim();
					if (arg === "true" || arg === "false") boolCount++;
					break;
				}
				depth--;
			} else if (ch === "," && depth === 0) {
				const arg = line.slice(argStart, j).trim();
				if (arg === "true" || arg === "false") boolCount++;
				argStart = j + 1;
			}
		}

		maxBoolCount = Math.max(maxBoolCount, boolCount);
	}

	return maxBoolCount;
}

/**
 * Detect functions with more than 4 parameters (taste threshold).
 * Long parameter lists indicate the function either does too much
 * or needs an options object.
 *
 * Distinct from checkFunctionComplexity (which flags >=6 as complexity).
 * This is a lower threshold for design taste.
 *
 * Skips: test files, destructured single-param functions, Go (threshold 6).
 */
export function checkFunctionArity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	const isGo = ext === ".go";
	const threshold = isGo ? 6 : 5; // Go idiomatically uses more params

	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".go", ".rs"].includes(ext))
		return [];

	const funcPatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
		/func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
		/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(lines[i]).trim();

		let funcName: string | null = null;
		for (const pat of funcPatterns) {
			const m = trimmed.match(pat);
			if (m) {
				funcName = nonNull(m[1]);
				break;
			}
		}
		if (!funcName) continue;

		const paramSig = collectFunctionSignature(lines, i);
		const paramMatch = paramSig.match(/\(([^)]*)\)/);
		if (!paramMatch) continue;

		const paramStr = nonNull(paramMatch[1]).trim();
		if (paramStr.length === 0) continue;

		// Skip destructured single-param: function f({ a, b, c, d, e })
		if (/^\s*\{/.test(paramStr) && countTopLevelCommas(paramStr) === 1) continue;
		// Also skip if only param is an object pattern (no top-level commas outside braces)
		if (/^\s*\{[^}]*\}\s*$/.test(paramStr)) continue;

		const paramCount = countTopLevelCommas(paramStr);
		if (paramCount >= threshold) {
			matches.push({
				line: i + 1,
				text: `[${paramCount} params → consider options object] ${trimmed.slice(0, 100)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect function signatures with a positional optional boolean parameter.
 *
 * `function setUser(name: string, force?: boolean)` — callers write
 * `setUser("alice", true)` and a cold reader can't tell what `true` means
 * without jumping to the definition. This is the signature-side twin of
 * `checkBooleanTrap`, which fires at call sites with 2+ literal booleans.
 * The signature-level catch is broader: a single positional optional
 * boolean is still opaque at every call site, even when only one bool is
 * passed.
 *
 * Fires on three shapes:
 *   - `flag?: boolean`              (TS optional marker)
 *   - `flag: boolean = false`       (typed default)
 *   - `flag = false`                (inferred default)
 *
 * Skips:
 *   - Booleans inside an options-object parameter (`opts: { flag?: boolean }`)
 *     — splitTopLevelParams treats the object as one param.
 *   - Required positional booleans (`flag: boolean`) — checkBooleanTrap
 *     catches the multi-arg form at call sites.
 *   - Union types (`flag?: boolean | null`) — kept narrow to avoid FP on
 *     genuinely tri-state configs.
 *   - Test files, non-JS/TS files.
 */
export function checkPositionalOptionalBoolean(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!JS_TS_FUNC_PATTERNS.some((pat) => pat.test(trimmed))) continue;

		const sig = collectFunctionSignature(strippedLines, i);
		const paramStr = extractParamStr(sig);
		if (paramStr === null) continue;

		const params = splitTopLevelParams(paramStr);
		for (const raw of params) {
			const offender = findPositionalOptionalBoolean(raw);
			if (offender !== null) {
				matches.push({
					line: i + 1,
					text: `[positional optional boolean: ${offender}] ${nonNull(originalLines[i]).trim().slice(0, 120)}`,
				});
				break; // one match per function is enough
			}
		}
	}

	return matches;
}

/**
 * Detect function signatures with 3+ optional parameters.
 *
 * Each optional param doubles the call-shape surface: N optionals = 2^N
 * call shapes that nobody tests in combination, and a default change is a
 * silent semantic API break. The cure is an options object — one param,
 * named fields, defaults visible at the schema level.
 *
 * "Optional" = `?:` (TS optional marker) OR `=` default value at top level
 * within the param's expression. Rest params (`...args`) are excluded —
 * one rest is a single knob (variadic), not a combinatorial knob.
 *
 * Skips: test files, non-JS/TS files. Distinct from `checkFunctionArity`,
 * which counts total params regardless of optionality.
 */
export function checkManyOptionalParams(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!JS_TS_FUNC_PATTERNS.some((pat) => pat.test(trimmed))) continue;

		const sig = collectFunctionSignature(strippedLines, i);
		const paramStr = extractParamStr(sig);
		if (paramStr === null) continue;

		const params = splitTopLevelParams(paramStr);
		const optionalCount = params.filter((p) => isOptionalParam(p)).length;
		if (optionalCount >= 3) {
			matches.push({
				line: i + 1,
				text: `[${optionalCount} optional params → consider options object] ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

// === Shared helpers: positional_optional_boolean + many_optional_params ===

const JS_TS_FUNC_PATTERNS: RegExp[] = [
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
];

/** Extract the (...) body from a collected function signature. Skips a leading <generic> block. */
function extractParamStr(sig: string): string | null {
	let angleDepth = 0;
	let start = -1;
	for (let i = 0; i < sig.length; i++) {
		const ch = sig[i];
		if (ch === "<") angleDepth++;
		else if (ch === ">") angleDepth--;
		else if (ch === "(" && angleDepth === 0) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < sig.length; i++) {
		const ch = sig[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return sig.slice(start + 1, i);
		}
	}
	return null;
}

/** Split a parameter string at top-level commas, respecting <>(){}[]. */
function splitTopLevelParams(paramStr: string): string[] {
	const result: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < paramStr.length; i++) {
		const ch = paramStr[i];
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			result.push(paramStr.slice(start, i));
			start = i + 1;
		}
	}
	result.push(paramStr.slice(start));
	return result.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Return the param name if this is a positional optional boolean, else null. */
function findPositionalOptionalBoolean(param: string): string | null {
	const stripped = param.replace(/^(public|private|protected|readonly|static)\s+/, "").trim();
	if (stripped.startsWith("{") || stripped.startsWith("[") || stripped.startsWith("...")) {
		return null;
	}
	const idMatch = stripped.match(/^(\w+)([\s\S]*)$/);
	if (!idMatch) return null;
	const name = nonNull(idMatch[1]);
	const rest = nonNull(idMatch[2]).trim();
	// `?: boolean` (no union — narrow to avoid FP on tri-state configs)
	if (/^\?\s*:\s*boolean\s*$/.test(rest)) return name;
	// `: boolean = (true|false)`
	if (/^:\s*boolean\s*=\s*(?:true|false)\s*$/.test(rest)) return name;
	// `= (true|false)` (no annotation — TS infers boolean from literal)
	if (/^=\s*(?:true|false)\s*$/.test(rest)) return name;
	return null;
}

/** True if a param string is optional (TS `?:` marker or top-level `=` default). Rest params excluded. */
function isOptionalParam(param: string): boolean {
	const stripped = param.replace(/^(public|private|protected|readonly|static)\s+/, "").trim();
	if (stripped.startsWith("...")) return false;
	let depth = 0;
	for (let i = 0; i < stripped.length; i++) {
		const d = bracketDelta(stripped[i]);
		if (d !== 0) depth += d;
		else if (depth === 0 && isOptionalMarkerAt(stripped, i)) return true;
	}
	return false;
}

/** Depth delta for one char: +1 for an opener, -1 for a closer, 0 otherwise. */
function bracketDelta(ch: string | undefined): number {
	if (ch === "<" || ch === "(" || ch === "{" || ch === "[") return 1;
	if (ch === ">" || ch === ")" || ch === "}" || ch === "]") return -1;
	return 0;
}

/** True if `stripped[i]` starts a top-level `?:` marker or a non-arrow, non-`==` `=` default. */
function isOptionalMarkerAt(stripped: string, i: number): boolean {
	const ch = stripped[i];
	if (ch === "?" && stripped[i + 1] === ":") return true;
	return ch === "=" && stripped[i + 1] !== ">" && stripped[i + 1] !== "=";
}

/**
 * Net `{`/`}` count over `line[startCol..]`, plus whether any `{` was seen —
 * the single question the body-collection loop below needs per scanned line.
 */
function braceDelta(line: string, startCol: number): { delta: number; sawOpen: boolean } {
	let delta = 0;
	let sawOpen = false;
	for (let k = startCol; k < line.length; k++) {
		if (line[k] === "{") {
			sawOpen = true;
			delta++;
		}
		if (line[k] === "}") delta--;
	}
	return { delta, sawOpen };
}

/**
 * Collect a catch block's body text (up to 8 lines), starting from the catch
 * header line's opening brace, tracking brace depth to find the matching close.
 * Returns both the comment-stripped body (for logging/rethrow detection) and
 * the original-source body (for explanatory-comment detection).
 */
function collectCatchBody(
	strippedLines: string[],
	originalLines: string[],
	startLine: number,
	catchOpenBrace: number,
): { bodyText: string; originalBodyText: string } {
	const bodyLines: string[] = [];
	const originalBodyLines: string[] = [];
	let braceDepth = 0;
	let started = false;

	for (let j = startLine; j < Math.min(startLine + 8, strippedLines.length); j++) {
		const line = nonNull(strippedLines[j]);
		const startCol = j === startLine ? catchOpenBrace : 0;
		const { delta, sawOpen } = braceDelta(line, startCol);
		started = started || sawOpen;
		braceDepth += delta;
		if (started) {
			bodyLines.push(j === startLine ? line.slice(catchOpenBrace) : line);
			originalBodyLines.push(
				j === startLine
					? nonNull(originalLines[j]).slice(catchOpenBrace)
					: nonNull(originalLines[j]),
			);
		}
		if (started && braceDepth === 0) break;
	}

	return { bodyText: bodyLines.join("\n"), originalBodyText: originalBodyLines.join("\n") };
}

/**
 * True if a catch body already handles its error (logging/rethrow/emit) or
 * carries an explanatory comment in the original source — either means the
 * default-return pattern below should NOT be flagged.
 */
function isHandledCatchBody(bodyText: string, originalBodyText: string): boolean {
	// Body has logging, rethrowing, or emitting.
	// Use loose prefix matching so reportError, logWarning, etc. are caught.
	if (
		/\b(console\.\w+|log\w*|logger|throw|emit|warn\w*|error|report\w*|notify)\b/i.test(bodyText)
	) {
		return true;
	}
	// Original body has explanatory comments.
	return /\/\/|\/\*/.test(originalBodyText);
}

/**
 * Detect catch blocks that silently swallow errors by returning a default value.
 * Extends checkSilentCatch — that flags empty catch blocks, this catches the
 * more insidious pattern where the error is discarded via a default return.
 *
 * `catch(e) { return null }` pretends everything is fine.
 * At minimum, log the error or rethrow.
 *
 * Skips: catch blocks with logging/rethrow, catch blocks with explanatory comments.
 */
export function checkCatchAndIgnore(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripComments(content).split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;

		// Find catch blocks
		const catchLine = nonNull(strippedLines[i]);
		if (!/\bcatch\s*(?:\([^)]*\))?\s*\{/.test(catchLine)) continue;

		// Find the catch block's opening brace (skip the } from try block)
		const catchIdx = catchLine.search(/\bcatch\b/);
		const catchOpenBrace = catchLine.indexOf("{", catchIdx);

		const { bodyText, originalBodyText } = collectCatchBody(
			strippedLines,
			originalLines,
			i,
			catchOpenBrace,
		);

		if (isHandledCatchBody(bodyText, originalBodyText)) continue;

		// Check if body is just a return of a default value
		const returnMatch = bodyText.match(
			/\breturn\s+(null|undefined|false|true|''|""|``|\[\]|\{\}|0|-1|void\s+0)\s*;?\s*\}?\s*$/,
		);
		if (!returnMatch) continue;

		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

// Leaf taste checks live in a sibling to keep this module under the line cap.
// Re-exported here so the public surface (and the generic-checks barrel) is unchanged.
export {
	checkGodFile,
	checkNarrativeNaming,
	checkTestDescriptionQuality,
} from "./taste-leaf-checks.js";
