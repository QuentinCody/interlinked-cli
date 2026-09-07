// CLASS: call-count-only spy evidence leaves arguments unobserved.
// FIRES WHEN: an active test positively asserts a spy was called (or its count),
// no call-argument/mock.calls pin exists, and all remaining matchers are fallbacks.
// DOES NOT FIRE: call arguments or mock.calls/mock.lastCall are inspected,
// a concrete return/state value is asserted, or the spy assertion is negated.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | before fixes | 183/unknown | builder sample only | call-count matches |
// | after partial wave | 112/59 | 64 fixed / 0 FP reported by workers | tests changed |
// KNOWN GAPS: argument-free notifications can legitimately be tested by count;
// most residual hits use vi.fn, whose intended contract cannot be inferred.
// HOW TO EXTEND: add matcher aliases to the spy/pin sets with labeled P/N cases;
// retain behavioral-value exemptions. Census: scripts/scan-test-discrimination.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";
import { findCallSpan, IT_TEST_OPEN_RE } from "./test-hygiene-shared.js";
import { isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";

const MAX_MATCHES = 12;
const MAX_TEXT_LEN = 150;

/** Matchers whose ONLY claim is "the collaborator was invoked" (optionally N
 *  times) — never what it was invoked WITH. Includes the `toBeCalled*`
 *  jest aliases. */
const SPY_CALL_MATCHERS = new Set<string>([
	"toHaveBeenCalled",
	"toHaveBeenCalledTimes",
	"toHaveBeenCalledOnce",
	"toBeCalled",
	"toBeCalledTimes",
]);

/** Matchers (or raw-body substrings) that pin the call ARGUMENTS. Presence of
 *  any of these anywhere in the block means the block is NOT flagged, even if
 *  other spy assertions in it are unpinned. */
const PIN_EVIDENCE_RE =
	/\btoHaveBeenCalledWith\b|\btoHaveBeenLastCalledWith\b|\btoHaveBeenNthCalledWith\b|\btoBeCalledWith\b|\blastCalledWith\b|\bnthCalledWith\b|\btoHaveBeenCalledExactlyOnceWith\b|\.mock\.calls\b|\.mock\.lastCall\b/;

/** Matcher + args pairs that carry zero discriminating information about a
 *  RETURN VALUE / STATE — the "nothing interesting was asserted" shape.
 *  `toThrow` only counts here when negated (a bare `not.toThrow()` says
 *  "no error", not "this specific value"). */
const FALLBACK_ZERO_ARG_MATCHERS = new Set<string>(["toBeNull", "toBeUndefined", "toBeFalsy"]);

const EXPECT_ASSERTION_RE = /\bexpect\s*\(/g;
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;

interface ExpectClassification {
	/** A positive (non-negated) spy-call assertion — the shape that is
	 *  blind to argument corruption. A NEGATED spy-call assertion
	 *  (`not.toHaveBeenCalled()`) asserts an ABSTENTION, which a wrong call
	 *  would still catch regardless of arguments, so it does not, by
	 *  itself, carry the "unpinned args" blindness this check targets. */
	isPositiveSpyCall: boolean;
	/** Any spy-call matcher, positive or negated — kept separate so a
	 *  negated sibling (`expect(other).not.toHaveBeenCalled()`) never
	 *  counts as a "real" value assertion that would clear the block. */
	isAnySpyCall: boolean;
	isFallback: boolean;
}

/** True when `matcher(argsText)` is one of the zero-information fallback
 *  shapes: `toBeNull()`, `toBeUndefined()`, `toBeFalsy()`, `toEqual([])`,
 *  `toEqual({})`, `toBe(0)`, `toBe(false)`, `toHaveLength(0)`, or a negated
 *  `toThrow()`. */
function isFallbackAssertion(matcher: string, argsText: string, negated: boolean): boolean {
	const trimmedArgs = argsText.trim();
	if (FALLBACK_ZERO_ARG_MATCHERS.has(matcher)) return true;
	if (matcher === "toEqual" && (trimmedArgs === "[]" || trimmedArgs === "{}")) return true;
	if (matcher === "toBe" && (trimmedArgs === "0" || trimmedArgs === "false")) return true;
	if (matcher === "toHaveLength" && trimmedArgs === "0") return true;
	if (matcher === "toThrow" && negated) return true;
	return false;
}

/** Classify one `expect(...)` assertion found at `argStart` (index just past
 *  the opening `expect(`) in a masked block body. Returns null when the
 *  matcher chain can't be resolved (unrecognized shape) so the caller can
 *  fall back to "treat as a real assertion" (conservative: suppresses fire). */
function classifyExpectAt(body: string, argStart: number): ExpectClassification | null {
	const span = findCallSpan(body, argStart);
	if (span === null) return null;
	const chain = MATCHER_CHAIN_RE.exec(body.slice(span.end + 1));
	if (chain === null) return null;
	const segments = nonNull(chain[1])
		.split(".")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const matcher = segments[segments.length - 1] ?? "";
	const negated = segments.includes("not");
	const matcherArgsStart = span.end + 1 + chain[0].length;
	const matcherSpan = findCallSpan(body, matcherArgsStart);
	const argsText = matcherSpan === null ? "" : body.slice(matcherArgsStart, matcherSpan.end);
	const isAnySpyCall = SPY_CALL_MATCHERS.has(matcher);
	return {
		isPositiveSpyCall: isAnySpyCall && !negated,
		isAnySpyCall,
		isFallback: isFallbackAssertion(matcher, argsText, negated),
	};
}

/** Scan a masked block body's `expect(...)` assertions. Returns whether ANY
 *  POSITIVE spy-call-only assertion was seen (the argument-blind shape) and
 *  whether ANY "real" (non-spy, non-fallback) assertion was seen — a negated
 *  spy call on a sibling mock is spy-category evidence, not a "real" value
 *  check, so it never counts toward `hasRealOther`. An unresolvable chain
 *  counts as real, keeping the detector conservative. */
function scanBlockAssertions(body: string): { hasPositiveSpyCall: boolean; hasRealOther: boolean } {
	let hasPositiveSpyCall = false;
	let hasRealOther = false;
	EXPECT_ASSERTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_ASSERTION_RE.exec(body);
	while (m !== null) {
		const argStart = m.index + m[0].length;
		const cls = classifyExpectAt(body, argStart);
		if (cls === null) {
			hasRealOther = true;
			// Unresolvable span: advance past the `expect(` token itself so a
			// stuck regex (unbalanced parens) can't infinite-loop.
			EXPECT_ASSERTION_RE.lastIndex = argStart;
		} else {
			if (cls.isPositiveSpyCall) hasPositiveSpyCall = true;
			else if (!cls.isAnySpyCall && !cls.isFallback) hasRealOther = true;
			const span = findCallSpan(body, argStart);
			EXPECT_ASSERTION_RE.lastIndex = span === null ? argStart : span.end + 1;
		}
		m = EXPECT_ASSERTION_RE.exec(body);
	}
	return { hasPositiveSpyCall, hasRealOther };
}

/** Read an it()/test() case's name from its first argument's string literal
 *  in the ORIGINAL (unmasked) content, for a readable warning. */
function readCaseName(content: string, argsStart: number, firstArgEnd: number): string {
	const nameMatch = content.slice(argsStart, firstArgEnd).match(/["'`]([^"'`]{0,80})["'`]/);
	return nameMatch ? `"${nameMatch[1]}" ` : "";
}

/** One candidate `it(`/`test(` callsite's block extent, or null when the
 *  call is skipped/todo or its argument list never balances. */
function blockExtentAt(
	masked: string,
	m: RegExpExecArray,
): { argsStart: number; end: number; topLevelCommas: number[] } | null {
	if (isSkippedOrTodoCall(m[0])) return null;
	const argsStart = m.index + m[0].length;
	const span = findCallSpan(masked, argsStart);
	if (span === null) return null;
	return { argsStart, end: span.end, topLevelCommas: span.topLevelCommas };
}

/** Build the warning for a single flagged block, or null when the block's
 *  assertions don't match the unpinned-spy-call shape. */
function matchForBlock(
	content: string,
	masked: string,
	m: RegExpExecArray,
	extent: { argsStart: number; end: number; topLevelCommas: number[] },
): InlineMatch | null {
	const body = masked.slice(extent.argsStart, extent.end);
	if (PIN_EVIDENCE_RE.test(body)) return null;
	const { hasPositiveSpyCall, hasRealOther } = scanBlockAssertions(body);
	if (!hasPositiveSpyCall || hasRealOther) return null;
	const lineIdx = (masked.slice(0, m.index).match(/\n/g) ?? []).length;
	const firstArgEnd = extent.topLevelCommas[0] ?? extent.end;
	const name = readCaseName(content, extent.argsStart, firstArgEnd);
	const text =
		`spy_call_unpinned_args: test ${name}asserts only that a spy/mock was called, never with what arguments — executed but not observed. Add toHaveBeenCalledWith(...) or inspect .mock.calls, or assert the resulting value/state instead.`.slice(
			0,
			MAX_TEXT_LEN,
		);
	return { line: lineIdx + 1, text };
}

/**
 * Flags `it()`/`test()` blocks whose only spy/mock assertions check that a
 * collaborator WAS CALLED (or called N times) with no assertion anywhere in
 * the block pinning the call ARGUMENTS, and no other assertion carrying
 * real (non-fallback) information about a return value or state. Such a
 * block is blind to a bug that only corrupts the call's arguments.
 */
export function checkSpyCallUnpinnedArgs(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const masked = maskCommentsAndStrings(content);
	const matches: InlineMatch[] = [];

	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(masked);
	while (m !== null && matches.length < MAX_MATCHES) {
		const extent = blockExtentAt(masked, m);
		const match = extent === null ? null : matchForBlock(content, masked, m, extent);
		if (match !== null) matches.push(match);
		m = IT_TEST_OPEN_RE.exec(masked);
	}
	return matches;
}
