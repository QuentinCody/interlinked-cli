// CLASS: differently titled tests repeat the same body under equivalent setup.
// FIRES WHEN: normalized bodies match (comments/code whitespace and async ignored),
// titles differ, body length is at least 30, and an expect call is present.
// Each later duplicate gets a finding naming the first occurrence.
// DOES NOT FIRE: different literals/identifiers/calls, same titles (owned by
// duplicate_test_names), each rows, skip/todo calls, absent assertions, or different
// setup at any suite level. Setup includes all direct statements and hooks, even
// after tests, normalized with an AST so whitespace inside literals is preserved.
// CALIBRATION (2026-09-07, this tree; historical passes differ in corpus scope):
// | pass | hits/files | inspected precision | correction |
// | builder 1/2/3 | 210/91 -> 66/43 -> 28/20 | last sample 3/3 TP | setup exemptions |
// | review | 32/23 | not independently measured | late hooks and literal whitespace |
// KNOWN GAPS: body normalization still uses a quote-aware textual walker; regex
// literals, nested templates, helper dataflow, and parameterized ancestor suites
// are incomplete. Equal bodies are a redundancy hint, not proof that a title lies.
// Setup parsing requires optional TypeScript; no type checker is constructed.
// HOW TO EXTEND: change normalizeBody or setup comparison with P/N fixtures.
// Census: scripts/scan-test-discrimination.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isStrictTestFile, JS_TS_EXTS } from "./shared.js";
import { findCallSpan, IT_TEST_OPEN_RE } from "./test-hygiene-shared.js";
import { isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { collectSetupTexts, type DescribeRange, findDescribeRanges, setupKeyAt } from "./test-duplicate-body-scope.js";
import { parseTestQuality, qualityBlocks } from "./test-quality-ast.js";

const MAX_MATCHES = 10;
const MAX_TEXT_LEN = 200;
const MIN_BODY_LEN = 30;

/** True when `c` is a word character (`[A-Za-z0-9_$]`); used to bound the
 *  `async` keyword so `asyncFoo`/`myasync` never partially match. */
function isWordChar(c: string | undefined): boolean {
	return c !== undefined && /[\w$]/.test(c);
}

/** True when the literal keyword `async` starts at `body[i]`, bounded by
 *  non-word characters on both sides (so `asyncFoo` never matches). */
function isAsyncKeywordAt(body: string, i: number): boolean {
	return !isWordChar(body[i - 1]) && body.slice(i, i + 5) === "async" && !isWordChar(body[i + 5]);
}

/** Index just past a `//` line comment starting at `i` — the newline itself
 *  is left for the caller; an unterminated comment runs to the end of `body`. */
function skipLineComment(body: string, i: number): number {
	let j = i;
	while (j < body.length && body[j] !== "\n") j++;
	return j;
}

/** Index just past a block comment (`/star ... star/`) starting at `i`; an
 *  unterminated block comment runs to the end of `body`. */
function skipBlockComment(body: string, i: number): number {
	let j = i + 2;
	while (j < body.length && !(body[j] === "*" && body[j + 1] === "/")) j++;
	return Math.min(j + 2, body.length);
}

/** Index just past a run of whitespace starting at `i` (at least one char). */
function skipWhitespaceRun(body: string, i: number): number {
	let j = i;
	while (j < body.length && /\s/.test(nonNull(body[j]))) j++;
	return j;
}

interface NormalizerStep {
	text: string;
	next: number;
}

/** One step of the quote-aware normalizer while OUTSIDE a string: the text
 *  to keep, the next index, and the quote char to enter (or null to stay in
 *  code). Comments and the `async` keyword are dropped entirely; a
 *  whitespace run collapses to one space; everything else passes through.
 *  Unlike the shared `stripComments` helper — which is NOT quote-aware for
 *  block comments and would wrongly blank a string literal that merely
 *  LOOKS like one (`"/star a star b star/c"`, see the module CALIBRATION
 *  note) — this only ever treats a `/star`/`//` OUTSIDE a string as a
 *  comment. */
function stepOutsideQuote(body: string, i: number): NormalizerStep & { enterQuote: '"' | "'" | "`" | null } {
	const ch = nonNull(body[i]);
	if (ch === '"' || ch === "'" || ch === "`") return { text: ch, next: i + 1, enterQuote: ch };
	if (ch === "/" && body[i + 1] === "/") return { text: "", next: skipLineComment(body, i), enterQuote: null };
	if (ch === "/" && body[i + 1] === "*") return { text: "", next: skipBlockComment(body, i), enterQuote: null };
	if (isAsyncKeywordAt(body, i)) return { text: "", next: i + 5, enterQuote: null };
	if (/\s/.test(ch)) return { text: " ", next: skipWhitespaceRun(body, i), enterQuote: null };
	return { text: ch, next: i + 1, enterQuote: null };
}

/** One step while INSIDE a string literal: copy verbatim (backslash escapes
 *  included), closing on the matching unescaped delimiter. A string's
 *  contents are data, never scanned for a comment opener or `async`. */
function stepInsideQuote(body: string, i: number, quote: string): NormalizerStep & { closed: boolean } {
	const ch = nonNull(body[i]);
	if (ch === "\\" && i + 1 < body.length) return { text: body.slice(i, i + 2), next: i + 2, closed: false };
	return { text: ch, next: i + 1, closed: ch === quote };
}

/** Walk `body` char-by-char, quote-aware, dispatching each position to
 *  {@link stepInsideQuote} or {@link stepOutsideQuote} and concatenating the
 *  kept text. The comment/`async`/whitespace RULES live in those two step
 *  functions; this is purely the drive loop. */
function runQuoteAwareNormalizer(body: string): string {
	let out = "";
	let quote: '"' | "'" | "`" | null = null;
	let i = 0;
	while (i < body.length) {
		if (quote !== null) {
			const step = stepInsideQuote(body, i, quote);
			out += step.text;
			if (step.closed) quote = null;
			i = step.next;
			continue;
		}
		const step = stepOutsideQuote(body, i);
		out += step.text;
		quote = step.enterQuote;
		i = step.next;
	}
	return out;
}

/** Comments stripped (quote-aware for both `//` and block comments), the
 *  `async` keyword dropped, and every remaining run of whitespace OUTSIDE a
 *  string literal collapsed to one space — trimmed. Two bodies that differ
 *  only by formatting, comments, or the presence of `async` normalize
 *  identically; any differing literal/identifier/call — including a
 *  whitespace difference INSIDE a string argument — still survives. */
function normalizeBody(body: string): string {
	return runQuoteAwareNormalizer(body).trim();
}

/** True when a `test.each`/`it.each` modifier appears on the call opener —
 *  the parameter table carries the difference between rows, so identical
 *  row bodies are by design (exemption b). */
function isEachCall(openerText: string): boolean {
	return /\.\s*each\b/.test(openerText);
}

/** One candidate `it(`/`test(` block: its title, normalized body, source
 *  line, and the `setupKeyAt` value at its declaration offset. Null when
 *  the call should be skipped outright (each/skip/todo/unbalanced/no
 *  title) or its body doesn't clear the shape this check targets. */
interface Candidate {
	title: string;
	bodyNorm: string;
	line: number;
	setupKey: string;
}

/** Extract one `it(`/`test(` call's title + normalized body, or null if the
 *  call is exempt (each/skip/todo), the argument list never balances, or
 *  the body doesn't have a leading title string. */
function candidateAt(
	content: string,
	masked: string,
	m: RegExpExecArray,
	describeRanges: readonly DescribeRange[],
	setupMap: ReturnType<typeof collectSetupTexts>,
): Candidate | null {
	if (isEachCall(m[0]) || isSkippedOrTodoCall(m[0])) return null;
	const argsStart = m.index + m[0].length;
	const span = findCallSpan(masked, argsStart);
	if (span === null) return null;
	const firstComma = span.topLevelCommas[0];
	if (firstComma === undefined) return null;
	const titleMatch = content.slice(argsStart, firstComma).match(/["'`]([^"'`]*)["'`]/);
	if (!titleMatch) return null;
	const bodyText = content.slice(firstComma + 1, span.end);
	const bodyNorm = normalizeBody(bodyText);
	if (bodyNorm.length < MIN_BODY_LEN) return null;
	if (!bodyNorm.includes("expect(")) return null;
	const line = (masked.slice(0, m.index).match(/\n/g) ?? []).length + 1;
	const setupKey = setupKeyAt(m.index, describeRanges, setupMap);
	return { title: nonNull(titleMatch[1]), bodyNorm, line, setupKey };
}

/** Collect every candidate `it()`/`test()` block in source order. */
function collectCandidates(content: string, masked: string, filePath: string): Candidate[] {
	const parsed = parseTestQuality(content, filePath);
	if (!parsed) return [];
	const active = new Set(qualityBlocks(parsed).filter((block) => block.kind === "test").map((block) => block.call.getStart(parsed.sf)));
	const describeRanges = findDescribeRanges(content);
	const setupMap = collectSetupTexts(content);
	const candidates: Candidate[] = [];
	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(masked);
	while (m !== null) {
		const c = active.has(m.index) ? candidateAt(content, masked, m, describeRanges, setupMap) : null;
		if (c !== null) candidates.push(c);
		m = IT_TEST_OPEN_RE.exec(masked);
	}
	return candidates;
}

/** Build the warning message for a block whose body duplicates `first`'s. */
function buildMessage(first: { title: string; line: number }): string {
	return `duplicate_test_body: body is identical to "${first.title}" at line ${first.line} — one of the two cannot be testing what its title says. Change the input or expected value that the title promises, or delete the copy.`.slice(
		0,
		MAX_TEXT_LEN,
	);
}

/**
 * Flags `it()`/`test()` blocks whose title differs from an earlier block in
 * the file but whose body is identical after normalization (and shares
 * equivalent enclosing `beforeEach`/`beforeAll` setup) — the copy-paste
 * whose input was never changed, or pure redundancy. See the module header
 * for the full FIRES-WHEN / DOES-NOT-FIRE contract.
 */
export function checkDuplicateTestBody(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = maskCommentsAndStrings(content);
	const candidates = collectCandidates(content, masked, filePath);

	// Group key: normalized body + setup key (exemption d) — title is
	// deliberately excluded from the key (same title is duplicate_test_names'
	// job, see N12) but IS required to differ for a finding to fire.
	const seen = new Map<string, { title: string; line: number }>();
	const matches: InlineMatch[] = [];
	for (const c of candidates) {
		const key = `${c.setupKey} ${c.bodyNorm}`;
		const first = seen.get(key);
		if (first === undefined) {
			seen.set(key, { title: c.title, line: c.line });
			continue;
		}
		if (first.title === c.title) continue; // same title+body: not this check's job
		matches.push({ line: c.line, text: buildMessage(first) });
		if (matches.length >= MAX_MATCHES) break;
	}
	return matches;
}
