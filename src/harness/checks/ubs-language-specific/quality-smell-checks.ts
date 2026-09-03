// UBS language-specific detectors — generic quality / code-smell checks.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Each function returns InlineMatch[]. Multi-language; ext-gated per check.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isScriptOrCliPath,
	isTestFile,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile, isPyFile, MATCH_LIMIT } from "./_shared.js";
import { findDeeplyNestedCallbackLines } from "./callback-nesting.js";

/**
 * `ubs_string_concat_in_loop` — `result += chunk` inside a loop is O(n²) in
 * languages with immutable strings (Java, JS-pre-rope). post / warning.
 *
 * Heuristic: scan for `+=` on an identifier inside a `for`/`while` body.
 * Gates Java + JS/TS only — Python and Go are already covered by the older,
 * indent-aware `checks/performance.ts:checkStringConcatInLoop` (which uses
 * `getLoopBodies()`). Without this language gate, both detectors fire on
 * the same line with different `(name, message)` pairs and the post-event
 * dedup (which keys on `(file, line, normalizedMessage)`) won't collapse
 * them — agents see two warnings for one issue.
 */
/**
 * Names initialized to a numeric literal anywhere in the file. `n += expr` on
 * such a name is integer addition, not string building — skip it. Kills the FP
 * on byte/count accumulators (e.g. `let total = 0; total += len`). Internal.
 */
function collectNumericVars(strippedLines: string[]): Set<string> {
	const numericVars = new Set<string>();
	for (const sl of strippedLines) {
		for (const nm of sl.matchAll(/\b([A-Za-z_$]\w*)\s*=\s*-?\d/g)) {
			numericVars.add(nonNull(nm[1]));
		}
	}
	return numericVars;
}

// Conventionally-numeric accumulator/index/offset names. A `+=` target whose
// bare identifier or dotted-path LAST segment matches this list (e.g.
// `cursor.offset`, `acc.count`) is integer/byte accumulation, not string
// building — `collectNumericVars` alone can't see member-expression targets
// (`obj.offset`), only bare identifiers assigned a numeric literal.
const NUMERIC_NAME_RE =
	/^(?:offset|pos|position|index|idx|count|total|sum|len|length|size|n|i|j|k|cursor|bytes|width|height|depth|level|score|weight|ms|seconds|elapsed|delta)$/i;

/** Internal: does `name` read as a conventionally-numeric accumulator name? */
function isNumericName(name: string): boolean {
	return NUMERIC_NAME_RE.test(name);
}

/**
 * Internal: does the `+=` target itself look numeric — either the bare
 * identifier, or the last segment of a dotted member expression
 * (`cursor.offset` -> `offset`)?
 */
function targetLooksNumeric(target: string): boolean {
	const parts = target.split(".");
	const last = parts[parts.length - 1];
	return last !== undefined && isNumericName(last);
}

/**
 * Internal: does the `+=` right-hand side read as numeric evidence — a
 * numeric literal, a `.length`/`.size`/`.byteLength` read, a name already
 * known numeric (`numericVars`), a conventionally-numeric name, or an
 * arithmetic expression built only from those? A quote/backtick anywhere
 * disqualifies it immediately (string literal present -> string building).
 */
function rhsLooksNumeric(rhs: string, numericVars: Set<string>): boolean {
	const trimmed = rhs.trim().replace(/;\s*$/, "");
	if (trimmed === "" || /["'`]/.test(trimmed)) return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return true;
	if (/\.(?:length|size|byteLength)\b/.test(trimmed)) return true;
	if (!/^[\w.\s+\-*/()]+$/.test(trimmed)) return false;
	const idents = trimmed.match(/[A-Za-z_$]\w*/g) || [];
	return idents.length > 0 && idents.every((id) => numericVars.has(id) || isNumericName(id));
}

/**
 * Internal: combines target- and RHS-side numeric evidence to decide whether
 * a `+=` is integer/byte accumulation rather than string building. Kills the
 * `cursor.offset += pathLen` FP (target-side) while still catching
 * `total += len` (already handled via `numericVars`/name-list) and leaving
 * `s += chunk` / `html += "<li>" + x` flagged (neither side is numeric).
 */
function isNumericAccumulation(target: string, rhs: string, numericVars: Set<string>): boolean {
	if (numericVars.has(target) || targetLooksNumeric(target)) return true;
	return rhsLooksNumeric(rhs, numericVars);
}

// Loop-carried state for the brace-tracked (JS/TS/Java) concat scan.
interface BraceLoopState {
	loopDepth: number;
}

/**
 * Brace-tracked arm of `checkUbsStringConcatInLoop`: advances `state.loopDepth`
 * for the current line and pushes a match when a string-building `+=` fires
 * inside a loop. Internal helper; mutates `state` and `matches`.
 */
function scanBraceConcatLine(
	line: string,
	idx: number,
	originalLines: string[],
	numericVars: Set<string>,
	state: BraceLoopState,
	matches: InlineMatch[],
): void {
	const openCount = (line.match(/\{/g) || []).length;
	const closeCount = (line.match(/\}/g) || []).length;

	if (/\b(?:for|while)\b[^{]*\{/.test(line)) {
		state.loopDepth++;
	}
	const concat =
		state.loopDepth > 0
			? line.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\+=\s*([A-Za-z_$"'`].*)/)
			: null;
	if (
		concat &&
		!isNumericAccumulation(nonNull(concat[1]), nonNull(concat[2]), numericVars)
	) {
		matches.push({ line: idx + 1, text: nonNull(originalLines[idx]).trim().slice(0, 150) });
	}
	// Roughly pop loop depth when braces close — heuristic only.
	if (state.loopDepth > 0 && closeCount > openCount) {
		state.loopDepth = Math.max(0, state.loopDepth - (closeCount - openCount));
	}
}

export function checkUbsStringConcatInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = ext === ".java" || isJsTsFile(ext);
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const numericVars = collectNumericVars(strippedLines);
	const state: BraceLoopState = { loopDepth: 0 };

	for (const [i, sl] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		scanBraceConcatLine(sl, i, originalLines, numericVars, state, matches);
	}
	return matches;
}

/**
 * `ubs_numeric_comparison_chain` — Java `instanceof` chain or `compareTo`
 * cascade — typically a sign of missing polymorphism. Flags 3+ consecutive
 * `instanceof` lines or `compareTo` lines in the same scope. post / warning.
 */
/** Internal: does this stripped line carry `instanceof` or a `compareTo(` call? */
function isComparisonChainLine(sl: string): boolean {
	return /\binstanceof\b/.test(sl) || /\bcompareTo\s*\(/.test(sl);
}

/**
 * Internal: line indices (0-based, ascending) that start a run of 3+ consecutive
 * comparison lines. Blank or brace-only lines are tolerated inside a run;
 * anything else ends it.
 */
function findComparisonChainRunStarts(strippedLines: string[]): number[] {
	const runStarts: number[] = [];
	let runStart = -1;
	let runLen = 0;
	for (const [i, sl] of strippedLines.entries()) {
		if (isComparisonChainLine(sl)) {
			if (runStart === -1) runStart = i;
			runLen++;
			continue;
		}
		if (/^\s*[}\s]*$/.test(sl)) continue;
		if (runLen >= 3 && runStart !== -1) runStarts.push(runStart);
		runStart = -1;
		runLen = 0;
	}
	if (runLen >= 3 && runStart !== -1) runStarts.push(runStart);
	return runStarts;
}

export function checkNumericComparisonChain(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const runStarts = findComparisonChainRunStarts(stripped.split("\n"));

	return runStarts.slice(0, MATCH_LIMIT).map((runStart) => ({
		line: runStart + 1,
		text: nonNull(originalLines[runStart]).trim().slice(0, 150),
	}));
}

/**
 * `ubs_print_debug_leak` — `console.log` / Python `print(...)` / Go
 * `fmt.Println` left in non-test code. Often a debug breadcrumb forgotten
 * before commit. post / warning.
 *
 * Skips test files, CLI/command files (where stdout is the product), and
 * files where the call is wrapped in `if (process.env.DEBUG)` style guards.
 */
export function checkPrintDebugLeak(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) || isPyFile(ext) || ext === ".go";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];
	// CLI/commands: stdout is the product; consoleStatements check covers them.
	if (filePath.includes("/commands/") || filePath.includes("/cmd/") || filePath.includes("/bin/")) {
		return [];
	}
	// 139-repo audit: mcpbr's `scripts/sync_version.py` had 194 print()
	// hits — all CLI output. Supermodel's `cli/internal/setup/wizard.go`
	// had 13 fmt.Println — interactive setup wizard. Path-segment gate
	// covers `scripts/`, `script/`, `cli/`, `tools/`, `tool/`,
	// `tutorial[s]/` — all places where stdout IS the product.
	if (isScriptOrCliPath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\b(?:console\.log|print|fmt\.Println)\s*\(/;

	for (const [i, sl] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(sl)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_magic_number_no_const` — numeric literals (other than 0/1/-1/2 and
 * obvious unit conversions) used in expressions without being assigned to a
 * named constant first. post / warning.
 *
 * Heuristic: detect `<numeric-literal-3+digits>` or `<numeric>.<numeric>`
 * appearing in an expression context (not a var/const initializer). Skips
 * test files. Significant FP rate; advisory.
 */
export function checkMagicNumberNoConst(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".swift";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// 3+ digit integer or fractional numeric literal — flag if NOT preceded by
	// `const`/`let`/`var`/`final` (the assignment-to-constant case).
	// Swift uses `let`/`var` like JS; `static let` is the named-constant idiom.
	const re = /\b(?:const|let|var|final)\b\s*\w+\s*=\s*\d+/;
	const magicRe = /(?<![\w.])\d{3,}(?:\.\d+)?\b/;

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!magicRe.test(line)) continue;
		if (re.test(line)) continue; // declaration with literal — fine
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

// Shared body-line threshold for `ubs_large_function` (Python + C-family).
const LARGE_FUNCTION_LINE_LIMIT = 80;

/**
 * Python arm of `checkLargeFunction`: scan for `def NAME(...)`, then count
 * contiguous body lines at strictly greater indent. Internal helper.
 */
function scanPyLargeFunctions(
	strippedLines: string[],
	originalLines: string[],
): InlineMatch[] {
	const matches: InlineMatch[] = [];
	for (const [i, sl] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		const m = sl.match(/^(\s*)def\s+\w+\s*\(/);
		if (!m) continue;
		const headerIndent = nonNull(m[1]).length;
		const bodyLines = countPyBodyLines(strippedLines, i, headerIndent);
		if (bodyLines >= LARGE_FUNCTION_LINE_LIMIT) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Count contiguous Python body lines following a `def` at `startIdx`, counting
 * blank lines and lines indented strictly deeper than `headerIndent`. Internal.
 */
function countPyBodyLines(
	strippedLines: string[],
	startIdx: number,
	headerIndent: number,
): number {
	let bodyLines = 0;
	for (let j = startIdx + 1; j < strippedLines.length; j++) {
		const inner = nonNull(strippedLines[j]);
		if (inner.trim() === "") {
			bodyLines++;
			continue;
		}
		const indent = inner.search(/\S/);
		if (indent <= headerIndent) break;
		bodyLines++;
	}
	return bodyLines;
}

/**
 * C-family arm of `checkLargeFunction`: scan for function headers, then count
 * lines until the matching `}`. Heuristic; no full parser. Internal helper.
 */
function scanCFamilyLargeFunctions(
	strippedLines: string[],
	originalLines: string[],
): InlineMatch[] {
	const headerRe = /\b(?:function\s+\w+|fn\s+\w+|func\s+\w+|\w+\s*=\s*\([^)]*\)\s*=>)/;
	const matches: InlineMatch[] = [];
	for (const [i, sl] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!headerRe.test(sl)) continue;
		const openIdx = findOpeningBrace(strippedLines, i);
		if (openIdx === -1) continue;
		const endIdx = findBraceBalanceEnd(strippedLines, openIdx);
		if (endIdx === -1) continue;
		const bodyLines = endIdx - openIdx;
		if (bodyLines >= LARGE_FUNCTION_LINE_LIMIT) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Find the first line index containing `{` from `startIdx` within a 5-line
 * lookahead window. Returns -1 if none. Internal helper.
 */
function findOpeningBrace(strippedLines: string[], startIdx: number): number {
	for (let k = startIdx; k < Math.min(startIdx + 5, strippedLines.length); k++) {
		if (nonNull(strippedLines[k]).includes("{")) return k;
	}
	return -1;
}

/**
 * Walk forward from `openIdx`, counting braces until depth balances. Returns
 * the line index that closes the block, or -1 if unbalanced. Internal helper.
 */
function findBraceBalanceEnd(strippedLines: string[], openIdx: number): number {
	let depth = 0;
	for (let k = openIdx; k < strippedLines.length; k++) {
		const sl = nonNull(strippedLines[k]);
		const opens = (sl.match(/\{/g) || []).length;
		const closes = (sl.match(/\}/g) || []).length;
		depth += opens - closes;
		if (depth === 0 && k > openIdx) return k;
	}
	return -1;
}

/**
 * `ubs_large_function` — function whose body spans 80+ lines. Heuristic; uses
 * brace-counting for C-family / `def` indent for Python. post / warning.
 */
export function checkLargeFunction(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp" ||
		ext === ".swift";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Python uses indent-based scanning; everything else uses brace balancing.
	return isPyFile(ext)
		? scanPyLargeFunctions(strippedLines, originalLines)
		: scanCFamilyLargeFunctions(strippedLines, originalLines);
}

/**
 * `ubs_deeply_nested_callback` — JS/TS file with a callback nested 4+ levels
 * deep. Sign of callback hell that's hard to read and test. post / warning.
 *
 * Heuristic: track `function`/`=>` opener lines and count how many are open
 * at the same time using brace depth.
 */
export function checkDeeplyNestedCallback(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const nestedLines = findDeeplyNestedCallbackLines(stripped.split("\n"), MATCH_LIMIT);

	return nestedLines.map((i) => ({
		line: i + 1,
		text: nonNull(originalLines[i]).trim().slice(0, 150),
	}));
}

/**
 * `ubs_time_format_locale_dep` — `Date.toLocaleString()` (JS) /
 * `DateTimeFormatter.ofLocalizedXxx` (Java) without an explicit locale.
 * Locale-dependent formatting drifts by environment. post / warning.
 */
export function checkTimeFormatLocaleDep(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = isJsTsFile(ext) || ext === ".java";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// JS: toLocaleString / toLocaleDateString / toLocaleTimeString called with no args.
	const jsRe = /\.toLocale(?:String|DateString|TimeString)\s*\(\s*\)/;
	// Java: DateTimeFormatter.ofLocalizedDate(...) without `.withLocale(`.
	const javaRe = /\bDateTimeFormatter\.ofLocalized\w+\s*\([^)]*\)(?!\s*\.withLocale)/;

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= MATCH_LIMIT) break;
		if (ext === ".java" ? !javaRe.test(line) : !jsRe.test(line)) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}
