// Test-file hygiene checks — test-quality family (Batch 2).
//
// The "the test is weak" group: detectors that fire on test files where a case
// duplicates another, the file never imports its own SUT, the test mocks the
// thing it claims to verify, every assertion checks only mock interactions, or
// the whole file only ever asserts a success path. All are <1ms regex-based.
//
// Public symbols are re-exported from the `test-hygiene.ts` barrel, so the check registry and every importer stay unchanged.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";
import { blankRange, isCodeMatch, isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { findCallSpan } from "./test-hygiene-shared.js";

/** Comments stripped, then all whitespace runs collapsed to one space and
 *  trimmed — two case bodies that differ only by formatting/comments hash to
 *  the same normalized string. Used to tell a genuine copy-paste duplicate
 *  (same title AND equivalent body) from a same-title collision whose bodies
 *  actually diverged (a naming bug — rename, don't delete). */
function normalizeBody(body: string): string {
	return stripComments(body).replace(/\s+/g, " ").trim();
}

export { checkMockOnlyTest } from "./test-hygiene-quality-mock-only.js";
export {
	checkMockingTheSutSelf,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality-sut.js";

// `(?<![.\w$])` (not plain `\b`) so member calls like `re.test("foo.ts")` /
// `obj.it('x')` never read as test declarations — `\b` matches after a dot.
const TEST_BLOCK_INTRO_RE =
	/(?<![.\w$])(?:it|test|specify)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*(["'`])([^"'`]*)\1/g;

/** Length-preserving code mask for checkDuplicateTestNames: blanks TS comments
 *  AND string-literal interiors with spaces, keeping every offset aligned with
 *  the original `content`. stripComments is length-preserving but KEEPS strings;
 *  stripStrings blanks strings but COLLAPSES them (`"dup"` → `""`), which shifts
 *  every downstream offset. We need both blanked AND offset-stable so a regex
 *  match on the raw content can be asked "is this `it(` real code, or does it
 *  live inside a comment / string literal?" — the latter is the
 *  duplicate_test_names FP (doc examples like `it.skip(`, and test fixtures like
 *  `writeFileSync(f, "it('x')")`). */
function codeOnlyMask(content: string): string {
	let mask = stripComments(content);
	const blank = (m: string) => " ".repeat(m.length);
	mask = mask.replace(/"(?:[^"\\]|\\.)*"/g, blank);
	mask = mask.replace(/'(?:[^'\\]|\\.)*'/g, blank);
	mask = mask.replace(/`(?:[^`\\]|\\.)*`/g, blank);
	return mask;
}

// ==========================================================================
// 1. Duplicate test names within a file
// ==========================================================================
// `it("returns 404")` declared twice in the same file. Catches the
// copy-paste-then-edit-half-of-it bug — both blocks pass, reviewers see
// two test names that look identical and assume one is a typo, but in
// fact the assertions diverged.

// Refinement (2026-05): account for the parent `describe()` scope.
// `it("x")` in `describe("A", ...)` and `it("x")` in `describe("B", ...)` are
// NOT duplicates — vitest reports them as `A > x` and `B > x` and the
// reporter is unambiguous. The pre-refinement check ignored describe nesting
// and FP'd on any sibling describes that happened to use the same test
// name (the canonical case: three "does NOT fire for test files" tests in
// tdd-cycle.test.ts, each under a different SUT's describe block).
const DESCRIBE_INTRO_RE = /\bdescribe(?:\.(?:each|only|skip|skipIf|runIf|sequential))*\s*\(/g;

/**
 * Build the offset of each describe() body in the ORIGINAL content. Each entry
 * says: "from `bodyStart` to `bodyEnd`, this describe's body extends." Operates
 * on `content` directly, not on `stripCommentsAndStrings`-cleaned content,
 * because the stripper COMPACTS quoted strings — `"checkA"` becomes `""` —
 * so offsets in `stripped` diverge from offsets in `content`. The walker
 * tracks inline quote state so a `{` inside a string literal doesn't move
 * brace depth. Returns describes in source order.
 *
 * The second `_stripped` parameter is retained for signature stability across
 * the refactor and is intentionally unused.
 */
function findDescribeRanges(
	content: string,
	_stripped: string,
): Array<{ bodyStart: number; bodyEnd: number }> {
	void _stripped;
	const ranges: Array<{ bodyStart: number; bodyEnd: number }> = [];
	DESCRIBE_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = DESCRIBE_INTRO_RE.exec(content);
	while (m !== null) {
		// Find the callback body's opening `{`, skipping any `{`/`}` that
		// sit inside string literals (e.g. `describe("a {b} c", ...)`).
		const open = scanForOpenBraceSkippingStrings(content, m.index + m[0].length);
		if (open < 0) {
			m = DESCRIBE_INTRO_RE.exec(content);
			continue;
		}
		const end = findMatchingCloseBraceSkippingStrings(content, open);
		if (end > open) ranges.push({ bodyStart: open, bodyEnd: end });
		m = DESCRIBE_INTRO_RE.exec(content);
	}
	return ranges;
}

/** Yields every index from `start` onward whose character sits in CODE — i.e.
 *  outside any `"…"` / `'…'` / `` `…` `` string literal (escapes honored).
 *  The single quote-state walker both brace scanners below share, so neither
 *  has to re-implement "is this brace real?". */
function* codeCharIndices(content: string, start: number): Generator<number> {
	let inQuote: '"' | "'" | "`" | null = null;
	for (let i = start; i < content.length; i++) {
		const ch = content[i];
		if (inQuote) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === inQuote) inQuote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inQuote = ch;
			continue;
		}
		yield i;
	}
}

/** Skip forward to the next top-level `{` after `start`, ignoring any `{`
 *  that appears inside a `"…"` / `'…'` / `` `…` `` string. -1 if none. */
function scanForOpenBraceSkippingStrings(content: string, start: number): number {
	for (const i of codeCharIndices(content, start)) {
		if (content[i] === "{") return i;
	}
	return -1;
}

/** Walk balanced braces from `openIdx` (where `content[openIdx] === '{'`),
 *  ignoring any `{` / `}` inside string literals. Returns the index of the
 *  matching `}`, or -1 if unbalanced. */
function findMatchingCloseBraceSkippingStrings(content: string, openIdx: number): number {
	let depth = 0;
	for (const i of codeCharIndices(content, openIdx)) {
		const ch = content[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Innermost describe range that contains `offset`. Returns `null` for an
 * `it()` at file root (no enclosing describe). Used as the dedup-scope key:
 * two `it()`s with the same name share a key only when they sit inside the
 * same describe body.
 */
function innermostDescribeAt(
	offset: number,
	ranges: ReadonlyArray<{ bodyStart: number; bodyEnd: number }>,
): { bodyStart: number; bodyEnd: number } | null {
	let best: { bodyStart: number; bodyEnd: number } | null = null;
	for (const r of ranges) {
		if (offset > r.bodyStart && offset < r.bodyEnd) {
			// More-deeply-nested wins (smaller body → strictly inside).
			if (!best || r.bodyStart > best.bodyStart) best = r;
		}
	}
	return best;
}

/** One `it()` / `test()` declaration, with the dedup scope it belongs to.
 *  `scopeKey` is the bodyStart of the enclosing describe, or "" for file-root.
 *  `bodyNorm` is the call's argument list (everything after the name string,
 *  up to the closing paren) with comments stripped and whitespace collapsed —
 *  the equivalence key that separates a genuine copy-paste duplicate from a
 *  same-title collision whose cases actually diverged. */
type TestDeclaration = { name: string; scopeKey: string; lineIdx: number; bodyNorm: string };

/** The call body text for the `it(`/`test(` match at `m` — everything from
 *  just after the name string through the call's closing paren — or "" if
 *  the call span can't be resolved (unbalanced/pathological; equivalence
 *  then falls back to "always different", the safe direction: it never
 *  turns a real duplicate into a silent non-finding, it only ever demotes a
 *  duplicate to a rename-suggestion). `codeMask` (comments/strings blanked,
 *  length-preserving) is what the balance scan walks so a paren/brace inside
 *  a string never miscounts; `content` (raw) is what gets sliced for text. */
function declarationBody(content: string, codeMask: string, m: RegExpExecArray): string {
	const openParen = content.indexOf("(", m.index);
	if (openParen === -1) return "";
	const span = findCallSpan(codeMask, openParen + 1);
	if (span === null) return "";
	return content.slice(m.index + m[0].length, span.end);
}

/**
 * Every named `it()` / `test()` declaration in source order. Matches on RAW
 * content — the test name is a string literal we must read intact — but skips
 * any `it(` whose opener is blanked in the length-preserving `codeMask`, i.e.
 * it lives inside a comment or a string. Unnamed cases are dropped.
 */
function collectTestDeclarations(
	content: string,
	codeMask: string,
	describeRanges: ReadonlyArray<{ bodyStart: number; bodyEnd: number }>,
): TestDeclaration[] {
	const declarations: TestDeclaration[] = [];
	TEST_BLOCK_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TEST_BLOCK_INTRO_RE.exec(content);
	while (m !== null) {
		const offset = m.index;
		const name = nonNull(m[2]).trim();
		if (codeMask[offset] !== " " && name.length > 0) {
			const enclosing = innermostDescribeAt(offset, describeRanges);
			declarations.push({
				name,
				scopeKey: enclosing ? String(enclosing.bodyStart) : "",
				lineIdx: (content.slice(0, offset).match(/\n/g) || []).length,
				bodyNorm: normalizeBody(declarationBody(content, codeMask, m)),
			});
		}
		m = TEST_BLOCK_INTRO_RE.exec(content);
	}
	return declarations;
}

/** The per-scope `seen` map for `scopeKey`, created on first use. */
function scopeSeenMap(
	seenByScope: Map<string, Map<string, { lineIdx: number; bodyNorm: string }>>,
	scopeKey: string,
): Map<string, { lineIdx: number; bodyNorm: string }> {
	let scope = seenByScope.get(scopeKey);
	if (!scope) {
		scope = new Map();
		seenByScope.set(scopeKey, scope);
	}
	return scope;
}

/** Public API — flags duplicate `it()` / `test()` names within the SAME
 *  enclosing `describe()` scope. Sibling describes can reuse a test name. */
export function checkDuplicateTestNames(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const describeRanges = findDescribeRanges(content, stripped);
	const codeMask = codeOnlyMask(content);

	// Per-scope `seen` map gives us "same name in the same describe" while
	// allowing the same name across sibling describes.
	const seenByScope = new Map<string, Map<string, { lineIdx: number; bodyNorm: string }>>();
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 10;

	for (const decl of collectTestDeclarations(content, codeMask, describeRanges)) {
		const scope = scopeSeenMap(seenByScope, decl.scopeKey);
		const prev = scope.get(decl.name);
		if (prev === undefined) {
			scope.set(decl.name, { lineIdx: decl.lineIdx, bodyNorm: decl.bodyNorm });
			continue;
		}
		const truncatedName = decl.name.slice(0, 80);
		// Equal bodies (after whitespace/comment normalization) → a genuine
		// copy-paste duplicate: same title, same behavior, one case is
		// redundant. Different bodies → the title was reused for a case that
		// actually diverged — a naming collision, not a duplicate; the fix
		// is to rename one title, not to delete either case.
		const text =
			decl.bodyNorm.length > 0 && decl.bodyNorm === prev.bodyNorm
				? `duplicate test name "${truncatedName}" — first declared on line ${prev.lineIdx + 1} in the same describe scope, with an equivalent body. Rename one or merge the cases.`
				: `test name "${truncatedName}" reused on line ${prev.lineIdx + 1} in the same describe scope, but the case bodies differ — this is a naming collision, not a duplicate. Rename one of the two titles so the reporter output stays unambiguous.`;
		matches.push({ line: decl.lineIdx + 1, text });
		if (matches.length >= MAX_MATCHES) break;
	}
	return matches;
}

// ==========================================================================
// 9. Happy-path-only test file — never asserts a failure path
// ==========================================================================
// A test file with three or more cases that never once asserts a negative
// outcome: no `.not.*`, no toThrow / `.rejects`, no false/null/undefined
// assertion, no error-handling case, and no test/describe NAMED for a
// failure path. A suite that can only observe success still passes when a
// regression breaks the error path. Any single negative assertion OR
// failure-named case clears the file — the escape hatch is one line.

const MIN_CASES_FOR_HAPPY_PATH = 3;

// A negative-outcome assertion anywhere in the (stripped) file.
const NEGATIVE_ASSERTION_RE =
	/\.\s*not\s*\.|\btoThrow(?:Error)?\s*\(|\.\s*rejects\b|\btoReject\w*\s*\(|\bto(?:BeFalsy|BeNull|BeUndefined|BeNaN)\s*\(|\bto(?:Be|Equal|StrictEqual)\s*\(\s*(?:false|null|undefined|NaN)\s*\)|\btoBeInstanceOf\s*\(\s*[A-Za-z_$][\w$]*Error|\binstanceof\s+[A-Za-z_$][\w$]*Error\b|\bcatch\s*[({]/;

// Failure-intent words in an it()/test()/describe() name. Deliberately broad:
// a single failure-named case is proof the file is not happy-path-only, so a
// wide net here only ever PREVENTS a finding — it cannot cause a false one.
const NEGATIVE_NAME_RE =
	/\b(?:error|errors|throw|throws|throwing|reject|rejects|rejected|fail|fails|failing|failure|invalid|malformed|missing|absent|empty|not|no|without|negative|guard|guards|block|blocks|blocked|deny|denies|denied|forbidden|unauthorized|refuse|refuses|crash|crashes|abort|aborts|edge|bad|wrong|conflict|unsupported|null|undefined|false|exception|raises?|catch|404|500|nonexistent)\b/i;

const DESCRIBE_NAME_RE =
	/\bdescribe(?:\.(?:each|only|skip|skipIf|runIf))?\s*\(\s*(["'`])([^"'`]*)\1/g;


function blankNonExecutingTestCalls(content: string, maskedContent: string): string {
	const chars = content.split("");
	for (const re of [TEST_BLOCK_INTRO_RE, DESCRIBE_NAME_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null = re.exec(content);
		while (m !== null) {
			if (isCodeMatch(maskedContent, m.index) && isSkippedOrTodoCall(m[0])) {
				const openParen = content.indexOf("(", m.index);
				const span = openParen === -1 ? null : findCallSpan(maskedContent, openParen + 1);
				blankRange(chars, m.index, span === null ? m.index + m[0].length : span.end + 1);
			}
			m = re.exec(content);
		}
	}
	return chars.join("");
}

/** Public API — flags test files whose every case asserts only success. */
export function checkHappyPathOnlyTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Count cases and collect their names from the original content — the
	// names ARE string literals, so they must not be stripped.
	const maskedContent = maskCommentsAndStrings(content);
	const executableContent = blankNonExecutingTestCalls(content, maskedContent);
	const executableMaskedContent = maskCommentsAndStrings(executableContent);
	const names: string[] = [];
	let caseCount = 0;
	let firstCaseLine = 1;
	TEST_BLOCK_INTRO_RE.lastIndex = 0;
	let t: RegExpExecArray | null = TEST_BLOCK_INTRO_RE.exec(executableContent);
	while (t !== null) {
		if (!isCodeMatch(executableMaskedContent, t.index)) {
			t = TEST_BLOCK_INTRO_RE.exec(executableContent);
			continue;
		}
		if (caseCount === 0) {
			firstCaseLine = (executableContent.slice(0, t.index).match(/\n/g) || []).length + 1;
		}
		caseCount++;
		names.push(nonNull(t[2]));
		t = TEST_BLOCK_INTRO_RE.exec(executableContent);
	}
	if (caseCount < MIN_CASES_FOR_HAPPY_PATH) return [];

	DESCRIBE_NAME_RE.lastIndex = 0;
	let d: RegExpExecArray | null = DESCRIBE_NAME_RE.exec(executableContent);
	while (d !== null) {
		if (isCodeMatch(executableMaskedContent, d.index)) {
			names.push(nonNull(d[2]));
		}
		d = DESCRIBE_NAME_RE.exec(executableContent);
	}

	// A failure-named case or block means the file exercises a negative path.
	if (names.some((name) => NEGATIVE_NAME_RE.test(name))) return [];
	// A negative assertion in the code means the same.
	if (NEGATIVE_ASSERTION_RE.test(stripCommentsAndStrings(executableContent))) return [];

	return [
		{
			line: firstCaseLine,
			text: `this test file has ${caseCount} cases but never asserts a failure path — no .not.* matcher, no toThrow, no .rejects, no false/null/undefined assertion, no error-handling case, no failure-named test. A suite that only checks success passes even when the error path regresses. Add at least one negative case — an invalid input, a thrown error, a rejected promise — or name a case for the failure it covers.`,
		},
	];
}
