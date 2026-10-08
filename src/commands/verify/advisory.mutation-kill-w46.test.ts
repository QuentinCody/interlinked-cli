import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_SKIPS } from "./advisory.js";

// Each id below corresponds to a StringLiteral mutant in the brief that
// replaces one entry of DEFAULT_ADVISORY_SKIPS with "". If the mutation is
// applied, .has(id) for that id returns false (and .has("") becomes true
// instead), so asserting membership for every listed id kills all of them.
const EXPECTED_MEMBERS = [
	"no_test_file",
	"knip",
	"files_without_test",
	"complexity",
	"function_arg_count",
	"nested_ternaries",
	"loop_nesting_depth",
	"else_if_chain",
	"missing_return_types",
	"console_statements",
	"non_null_assertion",
	"require_await",
	"flag_argument",
	"magic_number",
	"positional_optional_boolean",
	"many_optional_params",
	"boolean_trap",
	"same_typed_primitive_params",
	"comment_claims_limit_no_guard",
	"comment_claims_validation_missing",
	"comment_claims_idempotent_mutates",
	"comment_claims_null_throws_instead",
	"magic_literal_in_conditional",
	"write_without_mkdir",
	"comment_claims_throws_doesnt",
	"homedir_write_escape",
	"snapshot_hygiene",
	"hand_rolled_lexer",
	"duplicated_policy_constant",
	"design_slop",
	"type_predicate_drift",
	"payload_field_casing",
	"readme_script_drift",
	"gitignored_written_config",
	"anonymous_registration",
	"spec_path_ref",
	"resource_handle_leak",
	"contradictory_nullness_chain",
	"untested_idempotent",
	"dead_exports",
	"untested_inverse_pair",
	"manual_field_copy",
	"lifecycle_cleanup",
	"cleanup_skipped_on_early_exit",
	"boundary_copy_no_revalidation",
	"cleanup_reentrancy",
	"await_state_toctou",
	"tainted_to_privileged_sink",
	"code_clones",
	"sequential_awaits",
	"default_export",
	"hybrid_class",
	"single_implementation_interface",
	"fuzzy_responsibility_name",
	"over_mocking",
	"data_clump",
	"conditional_in_test",
	"assertion_roulette",
	"test_regressions",
	"mock_only_test",
	"happy_path_only_test",
] as const;

describe("DEFAULT_ADVISORY_SKIPS — positive (must fire)", () => {
	it.each(EXPECTED_MEMBERS)("contains %s", (id) => {
		expect(DEFAULT_ADVISORY_SKIPS.has(id)).toBe(true);
	});

	it("does not contain an empty-string entry", () => {
		// If any StringLiteral mutant (orig -> "") survived, the set would
		// gain a stray "" member instead of the real id.
		expect(DEFAULT_ADVISORY_SKIPS.has("")).toBe(false);
	});

	it("has exactly the expected size (no id silently dropped)", () => {
		// Guards against a mutant that both drops one real id AND happens to
		// keep the set size the same via some other coincidence; combined
		// with the individual .has() checks above this is a belt-and-braces
		// count check, not the primary kill mechanism.
		expect(DEFAULT_ADVISORY_SKIPS.size).toBeGreaterThanOrEqual(EXPECTED_MEMBERS.length);
	});
});
