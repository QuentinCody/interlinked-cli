// interlinked-tdd: exempt
// Test-file hygiene checks — test-quality family (Batch 2), mock-only cluster.
//
// Section 8 ("mock-only test") extracted from test-hygiene-quality.ts to keep
// that module under the per-file line cap. `checkMockOnlyTest` is re-exported
// from test-hygiene-quality.ts (and the test-hygiene.ts barrel) so the check
// registry and every importer stay unchanged. Behavior is byte-identical to the
// pre-extraction inline definitions.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isStrictTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";
import { findCallSpan, IT_TEST_OPEN_RE } from "./test-hygiene-shared.js";

// ==========================================================================
// 8. Mock-only test — every assertion is a call-interaction matcher
// ==========================================================================
// An it()/test() block whose only assertions are toHaveBeenCalled* /
// toHaveReturned* checks that a collaborator was *called* — never that the
// code produced a correct value, output, or state. It is a change-detector:
// it restates the call the author wrote, so it passes even when the behavior
// is wrong. A block whose call assertions are ALL negated (only
// `not.toHaveBeenCalled()`) is exempt — asserting a call did NOT happen is a
// genuine behavioral guarantee (a guard fired), not a tautology.

// Vitest / Jest call- and return-interaction matchers. Every member asserts
// *that a mock was invoked*, not what the code computed.
const CALL_INTERACTION_MATCHERS = new Set<string>([
	"toHaveBeenCalled",
	"toHaveBeenCalledTimes",
	"toHaveBeenCalledWith",
	"toHaveBeenLastCalledWith",
	"toHaveBeenNthCalledWith",
	"toHaveBeenCalledOnce",
	"toHaveBeenCalledExactlyOnceWith",
	"toHaveBeenCalledBefore",
	"toHaveBeenCalledAfter",
	"toBeCalled",
	"toBeCalledTimes",
	"toBeCalledWith",
	"lastCalledWith",
	"nthCalledWith",
	"toHaveReturned",
	"toHaveReturnedTimes",
	"toHaveReturnedWith",
	"toHaveLastReturnedWith",
	"toHaveNthReturnedWith",
	"toReturn",
	"toReturnTimes",
	"toReturnWith",
	"lastReturnedWith",
	"nthReturnedWith",
	"toHaveResolved",
	"toHaveResolvedTimes",
	"toHaveResolvedWith",
	"toHaveLastResolvedWith",
	"toHaveNthResolvedWith",
]);

// `expect(` in assertion position. `expect.objectContaining(` etc. is
// `expect.` — the `\(` requirement skips it (asymmetric matchers, not
// assertions).
const EXPECT_ASSERTION_RE = /\bexpect\s*\(/g;
// The `.mod.mod.matcher(` chain that follows an `expect(...)` close paren.
const MATCHER_CHAIN_RE = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)\s*\(/;
const ZERO_INTERACTION_COUNT_MATCHERS = new Set<string>([
	"toHaveBeenCalledTimes",
	"toBeCalledTimes",
	"toHaveReturnedTimes",
	"toReturnTimes",
	"toHaveResolvedTimes",
]);
const NODE_ASSERT_MODULE_RE = /^(?:node:assert(?:\/strict)?|assert)$/;
const NODE_ASSERT_HELPERS = new Set<string>([
	"deepEqual",
	"deepStrictEqual",
	"doesNotMatch",
	"doesNotReject",
	"doesNotThrow",
	"equal",
	"fail",
	"ifError",
	"match",
	"notDeepEqual",
	"notDeepStrictEqual",
	"notEqual",
	"notStrictEqual",
	"ok",
	"rejects",
	"strictEqual",
	"throws",
]);

interface ExpectClassification {
	/** True when the matcher is a call/return-interaction matcher. */
	isCallInteraction: boolean;
	/** True when the matcher chain contains a `.not` modifier. */
	negated: boolean;
}

// A non-call classification, shared for every expect whose matcher cannot be
// resolved. Read-only at every use site, so a single instance is safe.
const NON_CALL_EXPECT: ExpectClassification = { isCallInteraction: false, negated: false };

/**
 * Classify every `expect(...)` assertion in a stripped block body. An expect
 * whose matcher can't be resolved is reported as a non-call assertion — that
 * keeps the caller conservative: an unrecognized matcher prevents a
 * mock-only verdict rather than forcing one.
 */
export function classifyBlockExpects(body: string): ExpectClassification[] {
	const out: ExpectClassification[] = [];
	EXPECT_ASSERTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null = EXPECT_ASSERTION_RE.exec(body);
	while (m !== null) {
		const span = findCallSpan(body, m.index + m[0].length);
		if (span === null) {
			out.push(NON_CALL_EXPECT);
			break;
		}
		const chain = MATCHER_CHAIN_RE.exec(body.slice(span.end + 1));
		if (chain === null) {
			out.push(NON_CALL_EXPECT);
		} else {
			const segments = nonNull(chain[1])
				.split(".")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			const matcher = segments[segments.length - 1] ?? "";
			const matcherArgsStart = span.end + 1 + chain[0].length;
			out.push({
				isCallInteraction: CALL_INTERACTION_MATCHERS.has(matcher),
				negated:
					segments.includes("not") ||
					matcherHasZeroInteractionCount(body, matcher, matcherArgsStart),
			});
		}
		EXPECT_ASSERTION_RE.lastIndex = span.end + 1;
		m = EXPECT_ASSERTION_RE.exec(body);
	}
	return out;
}

function matcherHasZeroInteractionCount(
	body: string,
	matcher: string,
	argsStart: number,
): boolean {
	if (!ZERO_INTERACTION_COUNT_MATCHERS.has(matcher)) return false;
	const span = findCallSpan(body, argsStart);
	if (span === null) return false;
	const firstArgEnd = span.topLevelCommas[0] ?? span.end;
	const firstArg = body.slice(argsStart, firstArgEnd);
	return /^\s*0(?:\s+as\s+const)?\s*$/.test(firstArg);
}

/** Read an it()/test() case's name from its first argument's string literal. */
function readCaseName(content: string, argsStart: number, firstArgEnd: number): string {
	const nameMatch = content
		.slice(argsStart, firstArgEnd)
		.match(/["'`]([^"'`]{0,80})["'`]/);
	return nameMatch ? `"${nameMatch[1]}" ` : "";
}

function escapeRegexLiteral(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectImportedAssertHelpers(content: string): Set<string> {
	const helpers = new Set<string>();
	const withoutComments = stripComments(content);

	const importRe =
		/\bimport\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]+)\}\s*from\s*(["'])([^"']+)\2/g;
	let m: RegExpExecArray | null = importRe.exec(withoutComments);
	while (m !== null) {
		if (NODE_ASSERT_MODULE_RE.test(nonNull(m[3]))) addAssertSpecifiers(helpers, nonNull(m[1]), "esm");
		m = importRe.exec(withoutComments);
	}

	const requireRe =
		/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*(["'])([^"']+)\2\s*\)/g;
	m = requireRe.exec(withoutComments);
	while (m !== null) {
		if (NODE_ASSERT_MODULE_RE.test(nonNull(m[3]))) addAssertSpecifiers(helpers, nonNull(m[1]), "cjs");
		m = requireRe.exec(withoutComments);
	}

	return helpers;
}

function addAssertSpecifiers(
	helpers: Set<string>,
	specifiers: string,
	mode: "esm" | "cjs",
): void {
	for (const raw of specifiers.split(",")) {
		const part = raw.trim().replace(/^type\s+/, "");
		if (part.length === 0) continue;
		const parsed =
			mode === "esm"
				? /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part)
				: /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/.exec(part);
		if (!parsed) continue;
		const imported = nonNull(parsed[1]);
		const local = parsed[2] ?? imported;
		if (NODE_ASSERT_HELPERS.has(imported)) helpers.add(local);
	}
}

function hasImportedAssertHelperCall(body: string, helpers: Set<string>): boolean {
	for (const helper of helpers) {
		if (new RegExp(`\\b${escapeRegexLiteral(helper)}\\s*\\(`).test(body)) return true;
	}
	return false;
}

/** Public API — flags it()/test() blocks that assert only mock interactions. */
export function checkMockOnlyTest(content: string, filePath: string): InlineMatch[] {
	if (!isStrictTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const importedAssertHelpers = collectImportedAssertHelpers(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 12;

	IT_TEST_OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null = IT_TEST_OPEN_RE.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const argsStart = m.index + m[0].length;
		const span = findCallSpan(stripped, argsStart);
		if (span === null) {
			m = IT_TEST_OPEN_RE.exec(stripped);
			continue;
		}
		const body = stripped.slice(argsStart, span.end);
		// A non-expect assertion library (node:assert, chai `.should`) means
		// the block may well check a value — don't call it mock-only.
		const hasOtherAssertions =
			/\bassert\s*[(.]/.test(body) ||
			/\.\s*should\b/.test(body) ||
			hasImportedAssertHelperCall(body, importedAssertHelpers);
		const expects = classifyBlockExpects(body);
		// Mock-only: at least one assertion, EVERY assertion is a call
		// interaction, and at least one of them is a positive (non-negated)
		// call assertion. A block of only `not.toHaveBeenCalled()` is a real
		// guard test and is left alone.
		const everyCall = expects.length > 0 && expects.every((e) => e.isCallInteraction);
		const anyPositiveCall = expects.some((e) => e.isCallInteraction && !e.negated);
		if (!hasOtherAssertions && everyCall && anyPositiveCall) {
			const lineIdx = (stripped.slice(0, m.index).match(/\n/g) || []).length;
			const firstArgEnd = span.topLevelCommas[0] ?? span.end;
			const name = readCaseName(content, argsStart, firstArgEnd);
			matches.push({
				line: lineIdx + 1,
				text: `test ${name}asserts only mock interactions (toHaveBeenCalled / toHaveReturned) — it checks that a collaborator was called, not that the code produced a correct value, output, or state, so it passes even when the behavior is wrong. Assert a return value, rendered output, or observable state. A bare not.toHaveBeenCalled() is fine; a positive call-only assertion is not.`,
			});
		}
		m = IT_TEST_OPEN_RE.exec(stripped);
	}
	return matches;
}
