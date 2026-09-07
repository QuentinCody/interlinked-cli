// Test-name / matcher mismatch — test-quality family.
//
// Falsifier corpus u032: "the test name promises stable ordering; the
// assertion pins a value no mutation of that arm can change." The static
// proxy: an it()/test() whose TITLE claims one of a handful of concrete
// outcomes (throws, returns null, returns undefined, empty result, callback
// invoked) while the BODY carries no matcher from that outcome's family. The
// title and the assertion have drifted apart — the case still passes, but it
// no longer tests what its own name says it tests.
//
// Precision-first, verb-first (second calibration round): a title only
// carries a claim when the claim verb is the FIRST word of the title (after
// an optional "P1:"/"N2:"-style case-label prefix). Calibration round 1
// matched the verb anywhere in the title and was swamped by subordinate
// clauses ("skips an entry whose statSync throws", "falls back when
// readLocalConfig returns null") and parenthetical asides ("(throws ->
// catch -> outputError)") that describe a MOCKED DEPENDENCY or an
// implementation detail, not the SUT's own outcome — 0/8 clean true
// positives on two successive samples. Anchoring to the title's head word
// removes that class outright: a subordinate/parenthetical mention can never
// be title-initial. A body that delegates to an in-file
// `assert*`/`expect*`/`verify*` helper, or checks the claim via a text
// matcher / captured mock-call array, is treated as satisfying any family —
// see `bodySatisfiesClaim`.
//
// Determinism: partially_deterministic (title vocabulary + matcher regex,
// not behavior-verified) → `[heuristic]` tag.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";
import { isCodeMatch, isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";
import { findCallSpan } from "./test-hygiene-shared.js";

const MAX_MATCHES = 15;
const MAX_LINE_TEXT = 150;

// `it`/`test` (with the usual modifier chain), capturing the string-literal
// title. `.each` with a preceding table argument (`it.each(table)("t", fn)`)
// is not matched — same trade-off as test-hygiene-quality's sibling regex:
// those blocks are simply not examined, never misclassified.
const TEST_INTRO_RE =
	/(?<![.\w$])(?:it|test)(?:\.(?:each|only|skip|concurrent|skipIf|runIf|todo|failing|sequential))*\s*\(\s*(["'`])([^"'`]*)\1/g;

interface ClaimFamily {
	name: string;
	titleRe: RegExp;
	bodyRe: RegExp;
}

// Optional case-label prefix used by this repo's own evidence convention
// ("P1: …" / "N3: …") — stripped before the verb-first anchor is tested, so
// a labeled case's claim is still read from its real first word.
const CASE_PREFIX_RE = /^[PN]\d+[:\s-]+/i;

function stripCasePrefix(title: string): string {
	return title.replace(CASE_PREFIX_RE, "").trimStart();
}

// Four families only (round 2): "returns [an] empty …" collapses "empty
// result" and "no X" phrasings into one returns-empty claim; "calls"/
// "invokes" is the calls-invokes family. Every titleRe is ANCHORED (`^`) —
// the claim must be the title's head word, never a subordinate clause or a
// parenthetical aside.
const FAMILIES: ClaimFamily[] = [
	{
		name: "throws",
		// `rejects` is deliberately NOT in this family: in this repo "rejects X"
		// is the idiom for input-validation rejection observed through an exit
		// code, stderr, or a return value, not a Promise rejection — two
		// calibration rounds (2026-09-06) measured it at 0/8 precision.
		titleRe: /^throws?\b/i,
		bodyRe: /toThrow(?:Error)?\s*\(|rejects\s*\.|\.catch\s*\(|expect\.assertions|toBeInstanceOf\s*\(\s*[A-Za-z]*Error/,
	},
	{
		name: "returns null",
		titleRe: /^(?:returns null|is null)\b/i,
		bodyRe: /toBeNull\s*\(|toBe\s*\(\s*null\s*\)|toEqual\s*\(\s*null\s*\)|toStrictEqual\s*\(\s*null\s*\)/,
	},
	{
		name: "returns undefined",
		titleRe: /^(?:returns undefined|is undefined)\b/i,
		bodyRe: /toBeUndefined\s*\(|toBe\s*\(\s*undefined\s*\)/,
	},
	{
		name: "returns empty",
		titleRe: /^(?:returns (?:null|undefined|\[\]|an? empty|nothing)|is empty)\b/i,
		bodyRe:
			/toEqual\s*\(\s*\[\s*\]\s*\)|toStrictEqual\s*\(\s*\[\s*\]\s*\)|toHaveLength\s*\(\s*0\s*\)|toEqual\s*\(\s*\{\s*\}\s*\)|toBe\s*\(\s*0\s*\)|\.length\s*\)\s*\.\s*toBe\s*\(\s*0\s*\)|toBeNull\s*\(|toBeUndefined\s*\(|not\s*\.\s*toHaveBeenCalled/,
	},
	{
		name: "calls",
		titleRe: /^(?:calls|invokes)\b/i,
		bodyRe: /toHaveBeenCalled(?:With|Times)?\s*\(|mock\.calls/,
	},
];

// Widened body evidence (round 2): a text matcher naming the outcome, or a
// captured-args/mock-calls pattern, is treated as proof the claim was
// checked even when no family-specific matcher is present — both are
// legitimate ways to verify "empty"/"null"/"called" that a structural regex
// alone would miss.
const TEXT_ASSERTION_RE =
	/\b(?:toMatch|toContain)\s*\(\s*(?:\/[^/]*\b(?:empty|null|none|no)\b[^/]*\/|["'`][^"'`]*\b(?:empty|null|none|no)\b[^"'`]*["'`])/i;
const CAPTURED_ARGS_RE = /\bcalls\.push\s*\(|\.mock\.calls\b|\bargs\s*=/;

// Declarations of file-local `assert*`/`expect*`/`verify*` helpers. A body
// that calls one is treated as satisfying whatever family the title claims —
// the helper's own body is where the real matcher lives, and inlining every
// helper's implementation to re-check it would just move the FP surface.
const ASSERT_HELPER_DECL_RE = /\bfunction\s+(assert\w*|expect\w*|verify\w*)\s*\(|\bconst\s+(assert\w*|expect\w*|verify\w*)\s*=/g;

function collectAssertHelperNames(masked: string): Set<string> {
	const names = new Set<string>();
	ASSERT_HELPER_DECL_RE.lastIndex = 0;
	let m: RegExpExecArray | null = ASSERT_HELPER_DECL_RE.exec(masked);
	while (m !== null) {
		const name = m[1] ?? m[2];
		if (name) names.add(name);
		m = ASSERT_HELPER_DECL_RE.exec(masked);
	}
	return names;
}

function bodyDelegatesToHelper(body: string, helperNames: Set<string>): boolean {
	for (const name of helperNames) {
		const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`);
		if (re.test(body)) return true;
	}
	return false;
}

/** True when `body` has any acceptable evidence for `family`'s claim: its own
 *  structural matcher, a text-based matcher naming the outcome, a captured
 *  mock-call/args pattern, or delegation to an in-file assert/verify helper. */
function bodySatisfiesClaim(family: ClaimFamily, body: string, helperNames: Set<string>): boolean {
	if (family.bodyRe.test(body)) return true;
	if (TEXT_ASSERTION_RE.test(body)) return true;
	if (CAPTURED_ARGS_RE.test(body)) return true;
	return bodyDelegatesToHelper(body, helperNames);
}

/** First family the title's HEAD WORD claims but the body carries no
 *  acceptable evidence for, or null when the title makes no head-word claim
 *  or the body already satisfies it. */
function findMismatch(title: string, body: string, helperNames: Set<string>): ClaimFamily | null {
	const claimTitle = stripCasePrefix(title);
	for (const family of FAMILIES) {
		if (!family.titleRe.test(claimTitle)) continue;
		if (bodySatisfiesClaim(family, body, helperNames)) continue;
		return family;
	}
	return null;
}

function lineOf(content: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (content.charCodeAt(i) === 10) line++;
	}
	return line;
}

function truncate(text: string): string {
	return text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT - 1)}…` : text;
}

/** One block's finding, or null when the block is skipped/gated/clean. */
function matchAtIntro(
	content: string,
	masked: string,
	helperNames: Set<string>,
	m: RegExpExecArray,
): InlineMatch | null {
	if (!isCodeMatch(masked, m.index) || isSkippedOrTodoCall(m[0])) return null;
	const openParen = content.indexOf("(", m.index);
	const span = openParen === -1 ? null : findCallSpan(masked, openParen + 1);
	const firstComma = span ? span.topLevelCommas[0] : undefined;
	if (!span || firstComma === undefined) return null;

	const title = nonNull(m[2]);
	const body = content.slice(firstComma + 1, span.end);
	const violation = findMismatch(title, body, helperNames);
	if (!violation) return null;

	return {
		line: lineOf(content, m.index),
		text: truncate(
			`test_name_matcher_mismatch: title claims "${violation.name}" but the body has no ${violation.name} matcher — "${title}"`,
		),
	};
}

/** Public API — flags an it()/test() whose title claims a concrete outcome
 *  (throws / returns null / returns undefined / returns empty / calls) that the
 *  body carries no matching assertion for. */
export function checkTestNameMatcherMismatch(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = maskCommentsAndStrings(content);
	const helperNames = collectAssertHelperNames(masked);
	const matches: InlineMatch[] = [];

	TEST_INTRO_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TEST_INTRO_RE.exec(content);
	while (m !== null && matches.length < MAX_MATCHES) {
		const found = matchAtIntro(content, masked, helperNames, m);
		if (found) matches.push(found);
		m = TEST_INTRO_RE.exec(content);
	}
	return matches;
}
