// ===========================================
// Advisory-tier check ids — harness-side source
// ===========================================
// The set of check ids demoted from the default gate to advisory mode
// (surfaced only under `interlinked verify --all-checks`). Historically this
// policy lived solely in `src/commands/verify/advisory.ts`
// (`DEFAULT_ADVISORY_SKIPS`), but harness-side consumers — first the
// `persistent_warning_escalation` meta-check, which must never amplify an
// advisory-tier heuristic into an error — need the same set without a
// harness → commands import (wrong dependency direction; the harness never
// imports from the command layer).
//
// This module is the harness-side home for the id set. The per-entry
// rationale comments stay with `DEFAULT_ADVISORY_SKIPS` in
// `src/commands/verify/advisory.ts`; a parity test
// (`advisory-check-ids.test.ts`) pins the two sets equal until advisory.ts
// re-exports from here, so policy edits cannot silently drift.

/**
 * Check ids demoted to advisory (deep-audit) tier. Mirrors
 * `DEFAULT_ADVISORY_SKIPS` — see that set's comments for per-entry
 * rationale. Grouping below follows the same order.
 */
export const ADVISORY_CHECK_IDS: ReadonlySet<string> = new Set<string>([
	// Dead-code / coverage scans
	"knip",
	"no_test_file",
	"files_without_test",
	// Function size and complexity
	"complexity",
	"cognitive_complexity",
	"function_arg_count",
	"loop_nesting_depth",
	"nested_ternaries",
	"else_if_chain",
	// Style-level smells
	"console_statements",
	"missing_return_types",
	"non_null_assertion",
	"require_await",
	"flag_argument",
	"magic_number",
	"boolean_trap",
	"positional_optional_boolean",
	"many_optional_params",
	"same_typed_primitive_params",
	// Comment-vs-behavior drift
	"comment_claims_limit_no_guard",
	"comment_claims_null_throws_instead",
	"comment_claims_validation_missing",
	"comment_claims_idempotent_mutates",
	"comment_claims_throws_doesnt",
	"magic_literal_in_conditional",
	"write_without_mkdir",
	"homedir_write_escape",
	"duplicated_policy_constant",
	"type_predicate_drift",
	"snapshot_hygiene",
	"design_slop",
	"anonymous_registration",
	"payload_field_casing",
	"gitignored_written_config",
	// Quality-frontier wave (2026-07-06): verify-only doc-drift sibling + two
	// low-not-zero-FP heuristics pending cross-repo calibration (mirrors the
	// rationale comments in src/commands/verify/advisory.ts).
	"readme_script_drift",
	"spec_path_ref",
	"contradictory_nullness_chain",
	"resource_handle_leak",
	// Effect second-look wave (2026-09-01): both advisory pending cross-repo
	// FP calibration (rationales in advisory.ts).
	"fetch_without_abort_signal",
	"public_api_leaks_internal_type",
	// unvalidated_json_boundary: PROMOTED to default gate 2026-08-10 (R2).
	"dead_exports",
	"untested_inverse_pair",
	"untested_idempotent",
	"lifecycle_cleanup",
	"manual_field_copy",
	"cleanup_skipped_on_early_exit",
	"tainted_to_privileged_sink",
	"await_state_toctou",
	"cleanup_reentrancy",
	"boundary_copy_no_revalidation",
	"code_clones",
	"default_export",
	"sequential_awaits",
	"catch_and_log",
	// Design-shape smells
	"hybrid_class",
	"fuzzy_responsibility_name",
	"single_implementation_interface",
	"data_clump",
	// Test-body / test-quality heuristics
	"over_mocking",
	"conditional_in_test",
	"assertion_roulette",
	"test_regressions",
	"mock_only_test",
	"happy_path_only_test",
	"introverted_test",
	"test_legitimacy",
	"procfs_probe_in_test",
	"error_dispatch_by_instanceof",
	"crap",
	// UBS heuristic tier
	"ubs_rust_debug_assert_side_effect",
	// Bun-regression detector pack (2026-07-20)
	"ubs_c_assert_side_effect",
	"ubs_python_assert_side_effect",
	"ubs_java_assert_side_effect",
	"ubs_rust_unchecked_cast_slice",
	"unaligned_reinterpret",
	"placeholder_runtime_constant",
	"rust_unsafe_span",
	"suppression_block_span",
	"ubs_division_by_variable",
	"ubs_magic_number_no_const",
	"ubs_print_debug_leak",
	"ubs_hardcoded_localhost",
	"ubs_string_concat_in_loop",
	"ubs_large_function",
	"ubs_deeply_nested_callback",
	"ubs_time_format_locale_dep",
	"ubs_regex_in_loop_no_compile",
	"ubs_numeric_comparison_chain",
	"ubs_goroutine_no_waitgroup",
	"ubs_defer_in_loop",
	// Batch 1 agent-laziness
	"union_widened_with_string",
	"unbounded_promise_all",
	"sync_io_on_hot_path",
	// Batch 5 cross-file
	"empty_body_handler",
	"listener_pairing",
	"schema_type_drift",
	// CUDA inline checks
	"cuda_kernel_launch_unchecked",
	"cuda_printf_in_device_code",
	// Demoted after dogfood-noise review
	"agent_thumbprint_prose",
	"untestable_time_in_source",
	"duplicate_test_names",
	"test_missing_sut_import",
	"test_nondeterminism",
	"demo_data_unmarked",
	"test_subprocess_default_timeout",
	// Swift / iOS heuristic checks
	"swift_unhandled_task_error",
	"swift_global_var_no_isolation",
	"swift_self_in_escaping_closure",
	"swift_notification_observer_no_removal",
	"swift_timer_no_invalidate",
	"swift_combine_no_store",
	"swift_try_question_discarded",
	"swift_fatalerror_in_guard",
	"swift_print_in_view_body",
	"swift_abbreviations",
	// Coding-standards inline heuristics
	"unjustified_cast",
	"process_env_outside_config",
	"top_level_side_effect",
	// Type-discipline wave (2026-08-14) — see advisory.ts for rationale.
	"conditional_empty_object_spread",
	"unknown_type_alias",
	// Plan 25 lanes 6-8 (2026-08-17) — portability lint + boundary/contract
	// wave. See advisory.ts for per-id rationale.
	"dynamic_code_execution",
	"builtin_prototype_mutation",
	"float_equality_comparison",
	"python_portability_trap",
	"test_contract_annotation",
	"unvalidated_input_boundary",
	"dead_type_exports",
	"duplicate_type_declaration",
]);

/** True when `checkId` is advisory-tier (deep-audit only, not default-gate). */
export function isAdvisoryCheckId(checkId: string): boolean {
	return ADVISORY_CHECK_IDS.has(checkId);
}
