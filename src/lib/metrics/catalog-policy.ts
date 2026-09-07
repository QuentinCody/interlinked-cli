import type { QualityDimension } from "./measurement-types.js";

/** Only reviewed pure adapters participate; registry membership alone cannot confer score authority. */
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

export const SUPPORTING_CHECKS = new Set([
    "code_clones", "dead_exports", "dead_imports", "duplicate_type_declaration",
    "unknown_type_alias", "unvalidated_json_boundary", "non_null_assertion",
    "function_complexity", "function_tokens", "crap", "coverage_decrease",
]);
