// Scalar cyclomatic complexity per function — JS/TS/Python/Go/Rust.
//
// Complements `complexity.ts` (flag-based, returns InlineMatch[]) by returning
// structured per-function CC scores that downstream metrics (CRAP, PreToolUse
// budget line) can compose with per-function coverage data.
//
// Decision points counted (CC = 1 + decisions):
//   common:     if, for, while, case, catch/except, ternary (? :), &&/and, ||/or
//   js/ts:      also `else if` (via `if` match)
//   python:     elif, `x if cond else y` (ternary expr), `except`
//   go:         `case` (switch + select), no ternaries
//   rust:       `match` arms (`=>` tokens), `if let`, `while let`, `?` operator
//
// Coverage data availability is language-dependent (istanbul is JS/TS-only),
// so CRAP surfaces as complexity-only for languages without a coverage reader.
// The PreToolUse budget line still works — it just drops the `cov=N%` term.

import { nonNull } from "../../lib/non-null.js";
import { computeCyclomaticAst } from "./cyclomatic-ast.js";
import {
	getExtension,
	isTestFile,
	JS_TS_EXTS,
	stripForBraceScan,
} from "./shared.js";

// Extensions hoisted to module scope so the per-language dispatch reads as
// intent rather than a magic-literal comparison, and so the literal braces
// in walker patterns don't get counted as function-body nesting by the
// existing flag-based complexity checker.
const PYTHON_EXT = ".py";
const GO_EXT = ".go";
const RUST_EXT = ".rs";
const OPEN_BRACE = "{";

export interface FunctionComplexityEntry {
	name: string;
	/** 1-based line of the function declaration. */
	line: number;
	/** 1-based line of the closing brace / final indented body line. */
	endLine: number;
	/** 1 + count of decision points inside the function body. */
	cyclomatic: number;
	/** Language the entry was parsed from (for downstream filtering). */
	language: "js_ts" | "python" | "go" | "rust";
}

/**
 * Compute cyclomatic complexity per function for the supported languages.
 * Consumer: CRAP scorer + PreToolUse budget line.
 *
 * Returns `[]` for unsupported extensions and test files.
 */
export function computeCyclomaticComplexity(
	content: string,
	filePath: string,
): FunctionComplexityEntry[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);

	if (JS_TS_EXTS.has(ext)) {
		// Prefer the AST pass: per-function scope (inline closures counted as
		// their own units, not rolled into the parent) + `??`, validated to match
		// a real TS AST exactly. Falls back to the regex walker only when the
		// optional `typescript` dep is absent (minimal installs).
		const ast = computeCyclomaticAst(content, filePath);
		if (ast) return ast;
		return walkJsTs(stripForBraceScan(content).split("\n"));
	}

	// Non-JS/TS: the regex walker on brace-balanced source. A strip that
	// unbalanced braces would make walkBraceBody run off the file — see
	// stripForBraceScan.
	const lines = stripForBraceScan(content).split("\n");
	if (ext === PYTHON_EXT) return walkPython(lines);
	if (ext === GO_EXT) return walkGo(lines);
	if (ext === RUST_EXT) return walkRust(lines);
	return [];
}

// ==================================================================
// JS / TS
// ==================================================================

const JS_NAMED_FUNCTION =
	/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;

const JS_ARROW_ASSIGNED =
	/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/;

const JS_METHOD_LINE =
	/^(\s+)(?:async\s+|static\s+|public\s+|private\s+|protected\s+|readonly\s+|override\s+)*(?:(?:get|set)\s+)?(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;

const JS_RESERVED_HEAD_WORDS = new Set([
	"function",
	"if",
	"for",
	"while",
	"switch",
	"return",
	"typeof",
	"new",
	"await",
	"throw",
	"yield",
	"case",
	"default",
	"break",
	"continue",
	"do",
	"else",
	"try",
	"catch",
	"finally",
	"void",
	"delete",
	"const",
	"let",
	"var",
	"class",
	"extends",
	"implements",
	"interface",
	"type",
	"enum",
	"import",
	"export",
	"from",
	"as",
	"in",
	"of",
	"true",
	"false",
	"null",
	"undefined",
]);

function walkJsTs(lines: string[]): FunctionComplexityEntry[] {
	const entries: FunctionComplexityEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const funcName = detectJsFunctionName(nonNull(lines[i]));
		if (!funcName) continue;

		const braceLineIdx = findOpeningBrace(lines, i);
		if (braceLineIdx === -1) continue;

		const walk = walkBraceBody(lines, braceLineIdx, countJsDecisions);
		// Unbalanced strip → unreliable span + inflated count: skip, don't emit.
		if (!walk.closed) continue;
		entries.push({
			name: funcName,
			line: i + 1,
			endLine: walk.endLine + 1,
			cyclomatic: walk.cyclomatic,
			language: "js_ts",
		});
	}
	return entries;
}

function detectJsFunctionName(line: string): string | null {
	const named = JS_NAMED_FUNCTION.exec(line);
	if (named) return nonNull(named[1]);

	const arrow = JS_ARROW_ASSIGNED.exec(line);
	if (arrow) return nonNull(arrow[1]);

	const method = JS_METHOD_LINE.exec(line);
	if (method) {
		const candidate = nonNull(method[2]);
		if (!JS_RESERVED_HEAD_WORDS.has(candidate)) return candidate;
	}
	return null;
}

const JS_DECISION_KEYWORD = /\b(?:if|for|while|catch)\s*\(/g;
const JS_CASE_LABEL = /\bcase\s+/g;
// Ternary `? :` — exclude `??` (nullish coalescing) and `?.` (optional chaining).
const JS_TERNARY = /[^?]\?[^?:.]/g;
const LOGICAL_AND_SYMBOL = /&&/g;
const LOGICAL_OR_SYMBOL = /\|\|/g;

function countJsDecisions(bodyLine: string): number {
	let count = 0;
	const keywords = bodyLine.match(JS_DECISION_KEYWORD);
	if (keywords) count += keywords.length;
	const cases = bodyLine.match(JS_CASE_LABEL);
	if (cases) count += cases.length;
	const ternaries = bodyLine.match(JS_TERNARY);
	if (ternaries) count += ternaries.length;
	const ands = bodyLine.match(LOGICAL_AND_SYMBOL);
	if (ands) count += ands.length;
	const ors = bodyLine.match(LOGICAL_OR_SYMBOL);
	if (ors) count += ors.length;
	return count;
}

// ==================================================================
// Python
// ==================================================================

const PY_DEF = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/;

function walkPython(lines: string[]): FunctionComplexityEntry[] {
	const entries: FunctionComplexityEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = PY_DEF.exec(nonNull(lines[i]));
		if (!m) continue;

		const headIndent = nonNull(m[1]).length;
		const funcName = nonNull(m[2]);

		// Walk forward while lines are more indented than the `def` line,
		// skipping blank lines. First non-blank line with indent <= headIndent
		// ends the body.
		let cyclomatic = 1;
		let endLine = i;
		for (let k = i + 1; k < lines.length; k++) {
			const bodyLine = nonNull(lines[k]);
			if (bodyLine.trim() === "") {
				endLine = k;
				continue;
			}
			const indent = bodyLine.search(/\S/);
			if (indent <= headIndent) break;
			endLine = k;
			cyclomatic += countPythonDecisions(bodyLine);
		}

		entries.push({
			name: funcName,
			line: i + 1,
			endLine: endLine + 1,
			cyclomatic,
			language: "python",
		});
	}
	return entries;
}

const PY_DECISION_KEYWORD = /^\s*(?:if|elif|for|while|except)\b/;
const PY_CASE = /^\s*case\s+/;
// Ternary expression: `x if cond else y` on a single line.
const PY_TERNARY_EXPR = /\bif\b.*\belse\b/;
const PY_AND = /\band\b/g;
const PY_OR = /\bor\b/g;

function countPythonDecisions(bodyLine: string): number {
	let count = 0;
	if (PY_DECISION_KEYWORD.test(bodyLine)) count++;
	if (PY_CASE.test(bodyLine)) count++;

	// Ternary: only count when `if` and `else` appear on the same line AND
	// the `if` is not a statement opener. Opener was already counted above,
	// so check there's text before `if`.
	const ternaryMatch = bodyLine.match(PY_TERNARY_EXPR);
	if (ternaryMatch) {
		const ifIdx = bodyLine.indexOf("if");
		const beforeIf = bodyLine.slice(0, ifIdx).trim();
		// If there's meaningful text before `if`, this is a ternary, not a statement.
		if (beforeIf.length > 0 && !/:\s*$/.test(beforeIf)) count++;
	}

	const ands = bodyLine.match(PY_AND);
	if (ands) count += ands.length;
	const ors = bodyLine.match(PY_OR);
	if (ors) count += ors.length;

	return count;
}

// ==================================================================
// Go
// ==================================================================

// `func name(` or `func (receiver) name(`
const GO_FUNC = /^\s*func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/;

function walkGo(lines: string[]): FunctionComplexityEntry[] {
	const entries: FunctionComplexityEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = GO_FUNC.exec(nonNull(lines[i]));
		if (!m) continue;
		const funcName = nonNull(m[1]);

		const braceLineIdx = findOpeningBrace(lines, i);
		if (braceLineIdx === -1) continue;

		const walk = walkBraceBody(lines, braceLineIdx, countGoDecisions);
		// Unbalanced strip → unreliable span + inflated count: skip, don't emit.
		if (!walk.closed) continue;
		entries.push({
			name: funcName,
			line: i + 1,
			endLine: walk.endLine + 1,
			cyclomatic: walk.cyclomatic,
			language: "go",
		});
	}
	return entries;
}

// Go decision keywords: if, for, case (switch + select).
// Go has no ternary; short-circuit `&&`/`||` still count.
const GO_DECISION_KEYWORD = /\b(?:if|for)\s*[(\s]/g;
const GO_CASE_LABEL = /^\s*case\s+/;

function countGoDecisions(bodyLine: string): number {
	let count = 0;
	const keywords = bodyLine.match(GO_DECISION_KEYWORD);
	if (keywords) count += keywords.length;
	if (GO_CASE_LABEL.test(bodyLine)) count++;
	const ands = bodyLine.match(LOGICAL_AND_SYMBOL);
	if (ands) count += ands.length;
	const ors = bodyLine.match(LOGICAL_OR_SYMBOL);
	if (ors) count += ors.length;
	return count;
}

// ==================================================================
// Rust
// ==================================================================

// `fn name(`, `pub fn name(`, `pub(crate) fn name(`, `async fn name(`, etc.
const RUST_FN =
	/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;

function walkRust(lines: string[]): FunctionComplexityEntry[] {
	const entries: FunctionComplexityEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = RUST_FN.exec(nonNull(lines[i]));
		if (!m) continue;
		const funcName = nonNull(m[1]);

		const braceLineIdx = findOpeningBrace(lines, i);
		if (braceLineIdx === -1) continue;

		const walk = walkBraceBody(lines, braceLineIdx, countRustDecisions);
		// Unbalanced strip → unreliable span + inflated count: skip, don't emit.
		if (!walk.closed) continue;
		entries.push({
			name: funcName,
			line: i + 1,
			endLine: walk.endLine + 1,
			cyclomatic: walk.cyclomatic,
			language: "rust",
		});
	}
	return entries;
}

// Rust: if, if let, while, while let, for, `match` arms (`=>`).
// `?` operator (try) is a branch (Err short-circuit) — count it.
const RUST_DECISION_KEYWORD = /\b(?:if|while|for)\b/g;
// `match` arms are matched via `=>` in body; closures (`|x| expr`) also use
// `=>` occasionally in older code, but modern Rust uses `|x|` for closures.
// Simple heuristic: count `=>` tokens. May slightly overcount for nested
// closures written as `|x| { x => ... }` (rare).
const RUST_ARROW = /=>/g;
// Try operator: `expr?`. In Rust `?` is the try operator almost everywhere
// except trait-bound relaxation like `T: ?Sized`. Excluding `?` when followed
// by a letter/underscore handles `?Sized` and `?Send` without needing to
// parse the surrounding context.
const RUST_TRY_OPERATOR = /\?(?![A-Za-z_])/g;

function countRustDecisions(bodyLine: string): number {
	let count = 0;
	const keywords = bodyLine.match(RUST_DECISION_KEYWORD);
	if (keywords) count += keywords.length;
	const arrows = bodyLine.match(RUST_ARROW);
	if (arrows) count += arrows.length;
	const tries = bodyLine.match(RUST_TRY_OPERATOR);
	if (tries) count += tries.length;
	const ands = bodyLine.match(LOGICAL_AND_SYMBOL);
	if (ands) count += ands.length;
	const ors = bodyLine.match(LOGICAL_OR_SYMBOL);
	if (ors) count += ors.length;
	return count;
}

// ==================================================================
// Shared brace walker
// ==================================================================

function findOpeningBrace(lines: string[], fromIdx: number): number {
	const limit = Math.min(fromIdx + 10, lines.length);
	for (let k = fromIdx; k < limit; k++) {
		if (nonNull(lines[k]).includes(OPEN_BRACE)) return k;
	}
	return -1;
}

interface BraceWalkResult {
	cyclomatic: number;
	endLine: number;
	/**
	 * True when the body's braces balanced back to ≤0 before EOF. False means the
	 * scan ran off the end of the file without closing — which happens when the
	 * upstream strip left braces unbalanced (a stripper defect — see
	 * `stripCommentsAndStrings`) or on genuinely malformed source. When false,
	 * `endLine` collapses to the start line and `cyclomatic` over-counts every
	 * decision point through EOF, so callers MUST discard the entry rather than
	 * emit a wildly-wrong score (which then squares into CRAP).
	 */
	closed: boolean;
}

function walkBraceBody(
	lines: string[],
	braceLineIdx: number,
	countDecisions: (line: string) => number,
): BraceWalkResult {
	let depth = 0;
	let bodyStarted = false;
	let cyclomatic = 1;
	let endLine = braceLineIdx;
	let closed = false;

	for (let j = braceLineIdx; j < lines.length; j++) {
		const bodyLine = nonNull(lines[j]);
		for (const ch of bodyLine) {
			if (ch === "{") {
				depth++;
				bodyStarted = true;
			} else if (ch === "}") {
				depth--;
			}
		}
		if (bodyStarted && depth <= 0) {
			endLine = j;
			closed = true;
			break;
		}
		cyclomatic += countDecisions(bodyLine);
	}

	return { cyclomatic, endLine, closed };
}
