// Function complexity checks.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripForBraceScan,
} from "./shared.js";

// ===========================================
// Check: Function Complexity
// ===========================================

/**
 * Detect functions with high complexity indicators:
 * - 6+ parameters
 * - Nesting depth 5+ (nested braces inside function body)
 * - 15+ branching statements (if/else if/case/ternary)
 *
 * Supports TypeScript, JavaScript, Python, Go, Rust.
 * Skips test files.
 */
export function checkFunctionComplexity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
		// Strip strings/comments BEFORE counting braces. Without this, a string
		// literal containing `{` (e.g. `slice.indexOf("{")`) increments the
		// nesting depth and reports false-positive complexity warnings.
		const strippedLines = stripForBraceScan(content).split("\n");
		checkComplexityBrace(lines, strippedLines, matches);
	} else if (ext === ".py") {
		checkComplexityPython(lines, matches);
	} else if (ext === ".go" || ext === ".rs" || ext === ".swift") {
		const strippedLines = stripForBraceScan(content).split("\n");
		checkComplexityBrace(lines, strippedLines, matches);
	}

	return matches;
}

// Regex patterns to match function declarations (brace-delimited languages).
const BRACE_FUNC_PATTERNS = [
	// function name( or async function name(
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	// const name = ( or const name = async (
	/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
	// Go: func name( or func (receiver) name(
	/func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
	// Rust: fn name(
	/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
];

/** First function name matched by any declaration pattern on `trimmed`, else null. */
function matchBraceFuncName(trimmed: string): string | null {
	for (const pat of BRACE_FUNC_PATTERNS) {
		const m = trimmed.match(pat);
		if (m) return nonNull(m[1]);
	}
	return null;
}

/**
 * If the function declared at `lines[i]` has 6+ parameters, return a finding for
 * it; otherwise null. `trimmed` is the stripped signature line for the message.
 */
function braceParamOverflow(lines: string[], i: number, trimmed: string): InlineMatch | null {
	const paramSig = collectFunctionSignature(lines, i);
	const paramMatch = paramSig.match(/\(([^)]*)\)/);
	if (!paramMatch) return null;
	const paramStr = nonNull(paramMatch[1]).trim();
	if (paramStr.length === 0) return null;
	const paramCount = countTopLevelCommas(paramStr);
	if (paramCount < 6) return null;
	return { line: i + 1, text: `[${paramCount} parameters] ${trimmed.slice(0, 120)}` };
}

/** Index of the first line at/after `i` (within a 10-line window) containing `{`, or -1. */
function findBraceLine(lines: string[], i: number): number {
	for (let k = i; k < Math.min(i + 10, lines.length); k++) {
		if (nonNull(lines[k]).includes("{")) return k;
	}
	return -1;
}

/** Mutable running state threaded through `processBraceBodyLine` by `analyzeBraceBody`. */
interface BraceBodyState {
	depth: number;
	maxDepth: number;
	branchCount: number;
	bodyStarted: boolean;
}

/**
 * Update `state` in place for one line of a function body: track brace depth,
 * record the max nesting depth once the body has started, and tally branching
 * statements (if/else-if, nested case labels, ternaries). Returns true once the
 * function body has closed (`state.depth` returns to/below 0), signalling the
 * caller to stop iterating — mirrors the original loop's `break` condition.
 */
function processBraceBodyLine(bodyLine: string, state: BraceBodyState): boolean {
	for (const ch of bodyLine) {
		if (ch === "{") {
			state.depth++;
			if (state.bodyStarted && state.depth > state.maxDepth) state.maxDepth = state.depth;
			state.bodyStarted = true;
		}
		if (ch === "}") state.depth--;
	}
	if (state.bodyStarted && state.depth <= 0) return true;

	// Count branching statements
	if (/^\s*(if|else\s+if)\s*[\s(]/.test(bodyLine)) state.branchCount++;
	// Only count case labels when nested (depth >= 3).
	// A flat switch (depth 1-2) with many cases is readable;
	// nested switch/case is genuinely complex.
	if (state.depth >= 3 && /\bcase\s+/.test(bodyLine.trim())) state.branchCount++;
	// Ternary operator (rough heuristic)
	const ternaries = bodyLine.match(/[^?]\?[^?:]/g);
	if (ternaries) state.branchCount += ternaries.length;
	return false;
}

/**
 * Walk a function body from its opening-brace line, returning the maximum nesting
 * depth (relative to the function's own brace) and the count of branching
 * statements (if/else-if, nested case labels, ternaries). `lines` must be the
 * comment/string-stripped variant so braces inside literals don't inflate depth.
 */
function analyzeBraceBody(
	lines: string[],
	braceLineIdx: number,
): { nestingDepth: number; branchCount: number } {
	const state: BraceBodyState = { depth: 0, maxDepth: 0, branchCount: 0, bodyStarted: false };

	for (let j = braceLineIdx; j < lines.length; j++) {
		if (processBraceBodyLine(nonNull(lines[j]), state)) break;
	}

	// maxDepth is relative to the function's opening brace depth.
	// Subtract 1 because the function's own brace adds 1.
	return { nestingDepth: state.maxDepth - 1, branchCount: state.branchCount };
}

/**
 * Classify an analyzed function body into a finding (nesting first, then branch
 * count) keyed to line `i`, or null when it is within both thresholds.
 */
function braceBodyFinding(
	i: number,
	trimmed: string,
	body: { nestingDepth: number; branchCount: number },
): InlineMatch | null {
	if (body.nestingDepth >= 5) {
		return { line: i + 1, text: `[nesting depth ${body.nestingDepth}] ${trimmed.slice(0, 120)}` };
	}
	if (body.branchCount >= 15) {
		return {
			line: i + 1,
			text: `[${body.branchCount} branches — high complexity] ${trimmed.slice(0, 100)}`,
		};
	}
	return null;
}

/**
 * Check function complexity for brace-delimited languages (TS/JS/Go/Rust).
 *
 * @param rawLines      Original lines (unused now that the human-readable
 *                      signature is taken from the stripped line; kept for the
 *                      established call shape).
 * @param strippedLines Lines with comments and string literals replaced by
 *                      whitespace — used for brace counting and branch
 *                      detection so a `{` inside `"..."` doesn't inflate
 *                      the measured nesting depth.
 */
function checkComplexityBrace(
	_rawLines: string[],
	strippedLines: string[],
	matches: InlineMatch[],
): void {
	const lines = strippedLines;

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 15) break;
		const trimmed = nonNull(lines[i]).trim();

		const funcName = matchBraceFuncName(trimmed);
		if (!funcName) continue;

		// Check parameter count: collect the full parameter list.
		const paramFinding = braceParamOverflow(lines, i, trimmed);
		if (paramFinding) {
			matches.push(paramFinding);
			continue;
		}

		// Find the opening brace and analyze the function body.
		const braceLineIdx = findBraceLine(lines, i);
		if (braceLineIdx === -1) continue;

		const finding = braceBodyFinding(i, trimmed, analyzeBraceBody(lines, braceLineIdx));
		if (finding) matches.push(finding);
	}
}

/**
 * If the Python `def` at `lines[i]` declares 6+ parameters (excluding self/cls),
 * return a finding; otherwise null. Joins continuation lines to span multi-line
 * signatures. `trimmed` is the def line for the message.
 */
function pythonParamOverflow(lines: string[], i: number, trimmed: string): InlineMatch | null {
	let paramLine = trimmed;
	let j = i;
	while (!paramLine.includes(")") && j < Math.min(i + 10, lines.length - 1)) {
		j++;
		paramLine += ` ${nonNull(lines[j]).trim()}`;
	}
	const paramMatch = paramLine.match(/\(([^)]*)\)/);
	if (!paramMatch) return null;
	const params = nonNull(paramMatch[1])
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0 && p !== "self" && p !== "cls");
	if (params.length < 6) return null;
	return { line: i + 1, text: `[${params.length} parameters] ${trimmed.slice(0, 120)}` };
}

/**
 * Walk an indent-delimited Python function body (lines after the `def` at
 * `headIndent`), returning max nesting depth (4-space units) and branch count
 * (if/elif/case). Shares the {nestingDepth, branchCount} shape with the brace
 * analyzer so both feed `braceBodyFinding`.
 */
function analyzePythonBody(
	lines: string[],
	i: number,
	headIndent: number,
): { nestingDepth: number; branchCount: number } {
	let branchCount = 0;
	let maxNesting = 0;

	for (let k = i + 1; k < lines.length; k++) {
		const bodyLine = nonNull(lines[k]);
		if (bodyLine.trim() === "") continue;
		const indent = bodyLine.search(/\S/);
		if (indent <= headIndent) break;

		// Nesting depth relative to function body
		const relIndent = indent - headIndent;
		const nestLevel = Math.floor(relIndent / 4);
		if (nestLevel > maxNesting) maxNesting = nestLevel;

		if (/^\s*(if|elif)\s+/.test(bodyLine)) branchCount++;
		if (/^\s*case\s+/.test(bodyLine)) branchCount++;
	}

	return { nestingDepth: maxNesting, branchCount };
}

/**
 * Check function complexity for Python (indent-delimited).
 */
function checkComplexityPython(lines: string[], matches: InlineMatch[]): void {
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 15) break;
		const trimmed = nonNull(lines[i]).trim();
		const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
		if (!defMatch) continue;

		// Check parameter count.
		const paramFinding = pythonParamOverflow(lines, i, trimmed);
		if (paramFinding) {
			matches.push(paramFinding);
			continue;
		}

		// Analyze function body (indent-delimited).
		const headIndent = nonNull(lines[i]).search(/\S/);
		if (headIndent < 0) continue;

		const finding = braceBodyFinding(i, trimmed, analyzePythonBody(lines, i, headIndent));
		if (finding) matches.push(finding);
	}
}

/**
 * Count top-level parameter items, respecting nested angle brackets, parens, and braces.
 * Returns the number of comma-separated items at the top level.
 */
function countTopLevelCommas(paramStr: string): number {
	let depth = 0;
	let count = 1;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	return count;
}
