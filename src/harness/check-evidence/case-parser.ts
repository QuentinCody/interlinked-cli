// Check Evidence Contract — parse labeled test cases out of a check's
// companion test file.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// Two labeling conventions are recognized, so the 13 files already following
// the informal convention count without edits:
//
//   1. A `describe(...)` whose title names a direction — "positive (must fire)"
//      / "negative (must not fire)". Every `it()` / `test()` inside inherits it.
//   2. A per-test prefix — `it("P1: ...")` / `it("N3: ...")`. Overrides the
//      enclosing describe, so a stray counter-example inside a positive block
//      is still counted correctly.
//
// Line-scanning rather than AST: the labels live in string literals at
// statement starts, brace depth is the only structure needed, and this runs in
// a meta-test over ~250 files where a TS program-per-file would dominate
// runtime. The `typescript` dep is also optional (`--omit=optional`).

import type { CaseDirection, LabeledCase } from "./types.js";

/**
 * Matches a `describe(` / `it(` / `test(` opener plus its title, including
 * `.each(...)` / `.skip` forms. Global + capturing the keyword so a line
 * carrying BOTH a describe and its test (`describe("...", () => { it("...")`)
 * is read in source order rather than keyword-priority order — reading it
 * describe-last would drop the label the test inherits.
 */
const BLOCK_RE = /\b(describe|it|test)(?:\.\w+)?\s*(?:\([^)]*\))?\s*\(\s*(['"`])([\s\S]*?)\2/g;

/** Per-test direction prefix: `P1:`, `N12 -`, `P3 —`. */
const CASE_PREFIX_RE = /^\s*([PN])\d+\s*[:.\-—]/;

/**
 * Classify a title as asserting a direction, or null when it names neither.
 *
 * Negative is tested first: "must not fire" must never be read as a positive
 * by a looser "fire" match.
 */
export function directionFromTitle(title: string): CaseDirection | null {
	const t = title.toLowerCase();
	const prefix = CASE_PREFIX_RE.exec(title);
	if (prefix) return prefix[1] === "N" ? "negative" : "positive";

	// Each phrase accepts a hyphen wherever a space is written: 9 suites label
	// with the hyphenated dialect (`MUST-NOT-FIRE:`), and an explicit label in a
	// spelling variant is evidence, not an inference. Negative stays first, so
	// the `fire` tail of `must-not-fire` can never read as positive.
	if (/must[ -]not[ -]fire|does[ -]not[ -]fire|no[ -]match|negative|must[ -]stay[ -]silent|silent/.test(t)) {
		return "negative";
	}
	if (/must[ -]fire|does[ -]fire|positive|detects|flags/.test(t)) return "positive";
	return null;
}

/** Count `{` minus `}` on a line, ignoring braces inside string literals crudely. */
function braceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		else if (ch === "}") delta--;
	}
	return delta;
}

interface DescribeFrame {
	direction: CaseDirection | null;
	/** Brace depth at which this describe block closes. */
	closesAt: number;
}

/** One `describe` / `it` / `test` opener found on a line, in source order. */
interface BlockOpener {
	kind: "describe" | "test";
	title: string;
}

/** Every block opener on a line, in the order they appear. */
function scanBlockOpeners(line: string): BlockOpener[] {
	const found: BlockOpener[] = [];
	BLOCK_RE.lastIndex = 0;
	let m: RegExpExecArray | null = BLOCK_RE.exec(line);
	while (m) {
		found.push({ kind: m[1] === "describe" ? "describe" : "test", title: m[3] ?? "" });
		m = BLOCK_RE.exec(line);
	}
	return found;
}

/** True for lines that are entirely comment, so disabled tests are not counted. */
function isCommentLine(trimmed: string): boolean {
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Drop describe frames whose block has closed at the current brace depth. */
function popClosedFrames(stack: DescribeFrame[], depth: number): void {
	while (stack.length > 0 && depth <= (stack[stack.length - 1]?.closesAt ?? 0)) {
		stack.pop();
	}
}

/** The direction a test inherits from the innermost labeled describe, if any. */
function inheritedDirection(stack: readonly DescribeFrame[]): CaseDirection | null {
	return stack.length > 0 ? stack[stack.length - 1]?.direction ?? null : null;
}

/** Mutable scan state threaded line-by-line through {@link parseLabeledCases}. */
interface ParseState {
	readonly stack: DescribeFrame[];
	readonly cases: LabeledCase[];
	depth: number;
}

/** Apply every block opener found on one line to the running parse state. */
function applyLineOpeners(line: string, lineNumber: number, state: ParseState): void {
	for (const opener of scanBlockOpeners(line)) {
		if (opener.kind === "describe") {
			state.stack.push({ direction: directionFromTitle(opener.title), closesAt: state.depth });
			continue;
		}
		const direction = directionFromTitle(opener.title) ?? inheritedDirection(state.stack);
		if (direction) state.cases.push({ direction, title: opener.title, line: lineNumber });
	}
}

/**
 * Extract every labeled test case from test-file source.
 *
 * Unlabeled tests are ignored rather than guessed at — an unlabeled test is
 * not evidence of a direction, and inferring one would manufacture compliance.
 */
export function parseLabeledCases(source: string): LabeledCase[] {
	const lines = source.split("\n");
	const state: ParseState = { stack: [], cases: [], depth: 0 };

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		popClosedFrames(state.stack, state.depth);

		if (!isCommentLine(line.trim())) {
			applyLineOpeners(line, i + 1, state);
		}

		state.depth += braceDelta(line);
	}

	return state.cases;
}

/**
 * Every `it()`/`test()` case-opener line in `source`, regardless of P/N
 * labeling — the raw walker output before direction filtering. Reuses the
 * same {@link scanBlockOpeners} + comment-skipping the labeled-case parser
 * above uses, so both stay in agreement about what counts as a "case
 * opener" line.
 *
 * Consumers that need "how many test cases exist" independent of the
 * check-evidence P/N labeling convention (e.g. the mutation-kill-evidence
 * Stop nudge, which counts case INTRODUCTION rather than direction) use this
 * instead of {@link parseLabeledCases}, which silently drops every unlabeled
 * case — true of almost every mutation-directed test file, which name kill
 * targets ("kills the >= to > mutant"), not P1/N1 evidence directions.
 */
export function countTestCaseOpeners(source: string): number {
	const lines = source.split("\n");
	let count = 0;
	for (const line of lines) {
		if (isCommentLine(line.trim())) continue;
		for (const opener of scanBlockOpeners(line)) {
			if (opener.kind === "test") count++;
		}
	}
	return count;
}

/** Tally parsed cases by direction. */
export function countCases(cases: readonly LabeledCase[]): {
	positive: number;
	negative: number;
} {
	let positive = 0;
	let negative = 0;
	for (const c of cases) {
		if (c.direction === "positive") positive++;
		else negative++;
	}
	return { positive, negative };
}
