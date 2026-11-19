import type { QualityDimension } from "./measurement-types.js";

/** Only reviewed adapters participate. Some consult neighboring test sources;
 * registry membership alone cannot confer score authority. */
export const SCORED_CHECKS: Readonly<Record<string, QualityDimension>> = {
    nan_comparison: "correctness", async_promise_executor: "correctness",
    unsafe_optional_chaining: "correctness", ubs_tls_verify_disabled: "correctness",
    throw_literal: "correctness", promise_reject_non_error: "correctness",
    assertion_free_test: "test_integrity", tautological_assertion: "test_integrity",
    focused_tests: "test_integrity", disabled_tests: "test_integrity",
    catch_without_assertion_guard: "test_integrity", vacuous_loop_assertion: "test_integrity",
    commented_out_assertion: "test_integrity", fallback_only_assertion: "test_integrity",
    introverted_test: "test_integrity", mock_only_test: "test_integrity",
};

/** Result-collection ceilings for direct bounded calls, separate from recognition
 * windows and applicability. Missing metadata leaves collection coverage unknown. */
export const SCORED_CHECK_RUNTIME_RESULT_LIMITS: ReadonlyMap<string, number> = new Map([
    ["nan_comparison", 10], ["async_promise_executor", 10],
    ["unsafe_optional_chaining", 10], ["ubs_tls_verify_disabled", 10],
    ["throw_literal", 10], ["promise_reject_non_error", 10],
    ["assertion_free_test", 10], ["tautological_assertion", 10],
    ["focused_tests", 15], ["disabled_tests", 15],
    ["catch_without_assertion_guard", 10], ["vacuous_loop_assertion", 10],
    ["commented_out_assertion", 10], ["fallback_only_assertion", 10],
    ["introverted_test", 10], ["mock_only_test", 12],
]);

/** Reviewed scored detectors whose result collection is uncapped inside the
 * explicit foreground check-scan context. Recognition limits remain separate. */
export const FOREGROUND_UNCAPPED_SCORED_CHECKS: ReadonlySet<string> = new Set([
    "throw_literal", "promise_reject_non_error", "catch_without_assertion_guard", "mock_only_test",
    "nan_comparison", "async_promise_executor", "unsafe_optional_chaining", "ubs_tls_verify_disabled",
    "assertion_free_test", "tautological_assertion", "focused_tests", "disabled_tests",
    "vacuous_loop_assertion", "commented_out_assertion", "fallback_only_assertion", "introverted_test",
]);

export const SUPPORTING_CHECKS = new Set([
    "code_clones", "dead_exports", "dead_imports", "duplicate_type_declaration",
    "unknown_type_alias", "unvalidated_json_boundary", "non_null_assertion",
    "function_complexity", "function_tokens", "crap", "coverage_decrease",
]);
