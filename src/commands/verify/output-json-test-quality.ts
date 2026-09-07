// ===========================================
// verify --json: the test-quality section keys
// ===========================================
// `outputJson` (output-json.ts) sits far over the per-function token cap and
// may only shrink; the eight test-discrimination checks (2026-09-06) would have
// grown it, so the whole test-quality block — the five pre-existing ids plus
// the eight new ones — is projected here and spread in with one expression.
// The summarizer is passed in rather than imported to keep this module free of
// an output-json → here → output-json cycle.

import type { JsonObject } from "../../lib/json-types.js";
import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";

/** JSON key → results bucket, in the order the section table renders them. */
const TEST_QUALITY_SECTIONS = [
	["mock_only_test", "mockOnlyTest"],
	["happy_path_only_test", "happyPathOnlyTest"],
	["introverted_test", "introvertedTest"],
	["test_legitimacy", "testLegitimacy"],
	["procfs_probe_in_test", "procfsProbeInTest"],
	["duplicate_throw_message_assertion", "duplicateThrowMessageAssertion"],
	["fallback_only_assertion", "fallbackOnlyAssertion"],
	["spy_call_unpinned_args", "spyCallUnpinnedArgs"],
	["wildcard_in_observable", "wildcardInObservable"],
	["fixed_port_in_test", "fixedPortInTest"],
	["in_tree_temp_fixture", "inTreeTempFixture"],
	["catch_without_assertion_guard", "catchWithoutAssertionGuard"],
	["duplicate_expected_literal_pos_neg", "duplicateExpectedLiteralPosNeg"],
	["vacuous_loop_assertion", "vacuousLoopAssertion"],
	["mock_return_echo", "mockReturnEcho"],
	["duplicate_test_body", "duplicateTestBody"],
	["spy_without_restore", "spyWithoutRestore"],
	["export_existence_smoke_test", "exportExistenceSmokeTest"],
	["commented_out_assertion", "commentedOutAssertion"],
] as const satisfies ReadonlyArray<readonly [string, keyof CodeQualityResults]>;

/** Public API — the sixteen snake_case JSON keys, in emission order. */
export const TEST_QUALITY_JSON_KEYS: readonly string[] = TEST_QUALITY_SECTIONS.map(([key]) => key);

/** Public API — consumed by `outputJson`; `summarize` is its own row summarizer. */
export function summarizeTestQualitySections(
	cq: CodeQualityResults,
	summarize: (list: readonly CodeQualityIssue[]) => JsonObject,
): JsonObject {
	const out: JsonObject = {};
	for (const [key, bucket] of TEST_QUALITY_SECTIONS) {
		out[key] = summarize(cq[bucket]);
	}
	return out;
}
