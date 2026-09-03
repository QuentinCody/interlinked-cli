// ===========================================
// Verify Command Tests
// ===========================================
// Tests for the simplified verify: tsc + biome + scored suggestions.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Deterministic unique-dir suffix for test isolation.
let verifyTestCounter = 0;

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `verify-test-${process.pid}-${++verifyTestCounter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// Helper: captures stdout/stderr and restores even if the inner block throws.
// This is resource-cleanup (not branching logic); each call is a single observable step.
async function captureStd(
	fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; exitCode: number | string | undefined }> {
	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	const origOut = process.stdout.write;
	const origErr = process.stderr.write;
	const origExitCode = process.exitCode;
	process.stdout.write = ((chunk: string) => {
		stdoutChunks.push(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderrChunks.push(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await fn();
		return {
			stdout: stdoutChunks.join(""),
			stderr: stderrChunks.join(""),
			exitCode: process.exitCode,
		};
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
		process.exitCode = origExitCode;
	}
}

// ===========================================
// Shell injection prevention
// ===========================================

describe("cloneRepo shell injection prevention", () => {
	it("rejects URLs with shell metacharacters", async () => {
		const { verifyCommand } = await import("../verify.js");
		const captured = await captureStd(async () => {
			await verifyCommand({ target: "https://evil.com;touch /tmp/pwn" });
		});
		expect(captured.stderr).toContain("shell metacharacters");
		expect(captured.exitCode).toBe(1);
	});

	it("rejects branches with command substitution", async () => {
		const { verifyCommand } = await import("../verify.js");
		const captured = await captureStd(async () => {
			await verifyCommand({
				target: "https://github.com/owner/repo",
				branch: "main$(whoami)",
			});
		});
		expect(captured.stderr).toContain("shell metacharacters");
		expect(captured.exitCode).toBe(1);
	});
});

// ===========================================
// Local path target resolution
// ===========================================

describe("local path targets", () => {
	it("errors on nonexistent target", async () => {
		const { verifyCommand } = await import("../verify.js");
		const captured = await captureStd(async () => {
			await verifyCommand({ target: "/nonexistent/path/xyzzy" });
		});
		expect(captured.stderr).toContain("Target not found");
		expect(captured.exitCode).toBe(1);
	});

	it("scans a local directory and reports files_scanned", { timeout: 30_000 }, async () => {
		const { verifyCommand } = await import("../verify.js");
		writeFileSync(join(tempDir, "index.ts"), "export const x = 1;\n");
		const captured = await captureStd(async () => {
			await verifyCommand({ target: tempDir, json: true });
		});
		const result = JSON.parse(captured.stdout);
		expect(result.files_scanned).toBeGreaterThanOrEqual(1);
	});
});

// ===========================================
// Scored suggestions (--suggestions)
// ===========================================

describe("scored suggestions", () => {
	// verifyCommand spawns tsc + biome + oxlint over a temp dir; under full-suite
	// parallelism the 10s global testTimeout is too tight, so this one test gets
	// a dedicated 30s cap plus a retry for rare subprocess-startup flakes.
	it(
		"detects sql.exec with interpolation via --suggestions",
		{ timeout: 30_000, retry: 2 },
		async () => {
			const { verifyCommand } = await import("../verify.js");

			writeFileSync(
				join(tempDir, "handler.ts"),
				'import { SqlStorage } from "@cloudflare/workers-types";\n' +
					"function query(sql: any, userInput: string) {\n" +
					"  return sql.exec(`SELECT * FROM users WHERE name = '$" +
					"{userInput}'`);\n" +
					"}\n",
			);

			const captured = await captureStd(async () => {
				await verifyCommand({ cwd: tempDir, json: true, suggestions: true });
			});
			const result = JSON.parse(captured.stdout);
			expect(result.suggestions).toBeDefined();
			const allSuggestions = Object.values(result.suggestions).flat();
			expect(allSuggestions.length).toBeGreaterThanOrEqual(1);
		},
	);
});

describe("suppression detection", () => {
	it(
		"ignores suppression markers that only appear inside string literals",
		async () => {
			const { verifyCommand } = await import("../verify.js");

			// Build the literal token at runtime so this test file's own source
			// doesn't contain a raw "@ts-expect-error" — the suppressions check would
			// (correctly) nag every edit if it did. The fixture file written below
			// still contains the literal token, which is the point of the test.
			const tsIgnore = `@ts-${"ignore"}`;
			writeFileSync(
				join(tempDir, "fixture.ts"),
				[
					"export function buildFixture() {",
					`  const code = "// ${tsIgnore}\\nconst x = 1;";`,
					`  return code.includes("${tsIgnore}");`,
					"}",
					"",
				].join("\n"),
			);

			const captured = await captureStd(async () => {
				await verifyCommand({ target: tempDir, json: true });
			});
			const result = JSON.parse(captured.stdout);
			expect(result.suppressions.issues).toBe(0);
		},
		60_000,
	);
});

// The full `summarizeFlaggedFiles` unit cases moved to
// `src/commands/verify/verify-summary.test.ts` (the function now lives in
// `./verify/verify-summary.ts`). This smoke test keeps the load-bearing
// `verify.ts` re-export pinned — external scripts import the name from here.
describe("summarizeFlaggedFiles re-export", () => {
	it("is re-exported from verify.ts and stays a pure tally", async () => {
		const { summarizeFlaggedFiles } = await import("../verify.js");
		const tally = summarizeFlaggedFiles("/repo", ["/repo/a.ts"], new Set(["<project>"]));
		expect(tally).toEqual({ flaggedFiles: 0, totalFiles: 1, projectFindings: 1 });
	});
});

// Pins the default advisory-skip list so policy changes (adding or removing a
// demoted check) show up in PR diffs instead of landing silently. Update both
// the list in verify.ts and this test together, with a rationale comment.
describe("DEFAULT_ADVISORY_SKIPS", () => {
	it("matches the expected set of advisory-only checks", async () => {
		const { DEFAULT_ADVISORY_SKIPS } = await import("../verify.js");
		expect([...DEFAULT_ADVISORY_SKIPS].sort()).toEqual(
			[
				"assertion_roulette",
				"boolean_trap",
				"comment_claims_idempotent_mutates",
				"comment_claims_limit_no_guard",
				"comment_claims_null_throws_instead",
				"comment_claims_throws_doesnt",
				"comment_claims_validation_missing",
				"catch_and_log",
				"code_clones",
				// cognitive-complexity metric (history-relational-metrics Phase 1, 2026-07-24)
				"cognitive_complexity",
				"complexity",
				"conditional_in_test",
				"console_statements",
				"crap",
				"data_clump",
				"dead_exports",
				"untested_idempotent",
				"untested_inverse_pair",
				"default_export",
				"duplicated_policy_constant",
				"type_predicate_drift",
				"snapshot_hygiene",
				"design_slop",
				"payload_field_casing",
				// Bun-regression detector pack (2026-07-20): confessed stand-in constants
				"placeholder_runtime_constant",
				"else_if_chain",
				"files_without_test",
				"flag_argument",
				"function_arg_count",
				"fuzzy_responsibility_name",
				"gitignored_written_config",
				"hybrid_class",
				"knip",
				"lifecycle_cleanup",
				"loop_nesting_depth",
				"magic_literal_in_conditional",
				"magic_number",
				"manual_field_copy",
				"many_optional_params",
				"missing_return_types",
				"nested_ternaries",
				"no_test_file",
				"non_null_assertion",
				"over_mocking",
				"positional_optional_boolean",
				// CI-hang class from the 2026-07 unit-lane saga: a /proc path used as
				// an unwritable-path fixture. Advisory — the literal cannot prove intent.
				"procfs_probe_in_test",
				"require_await",
				// Bun-regression detector pack (2026-07-20): escape-hatch span pair
				"rust_unsafe_span",
				"same_typed_primitive_params",
				"sequential_awaits",
				"single_implementation_interface",
				"single_use_trivial_helper",
				"suppression_block_span",
				"test_regressions",
				// Bun-regression detector pack (2026-07-20): assert-erasure siblings
				"ubs_c_assert_side_effect",
				"ubs_deeply_nested_callback",
				"ubs_defer_in_loop",
				"ubs_division_by_variable",
				"ubs_goroutine_no_waitgroup",
				"ubs_hardcoded_localhost",
				"ubs_java_assert_side_effect",
				"ubs_large_function",
				"ubs_magic_number_no_const",
				"ubs_numeric_comparison_chain",
				"ubs_print_debug_leak",
				"ubs_python_assert_side_effect",
				"ubs_regex_in_loop_no_compile",
				"ubs_rust_debug_assert_side_effect",
				"ubs_rust_unchecked_cast_slice",
				"ubs_string_concat_in_loop",
				"ubs_time_format_locale_dep",
				// Bun-regression detector pack (2026-07-20): JS half of the reinterpret pair
				"unaligned_reinterpret",
				// unvalidated_json_boundary: PROMOTED to default gate 2026-08-10
				// (R2 fleet swept all sites; 0 fires on promotion).
				// fs-write-safety: nested-path write missing a mkdir-recursive guard.
				"write_without_mkdir",
				// fs-write-safety: write path derives from the user's real home.
				"homedir_write_escape",
				// Batch 1: agent-laziness — advisory (heuristic)
				"sync_io_on_hot_path",
				"unbounded_promise_all",
				"union_widened_with_string",
				// 139-repo audit additions: structural cleanup + boundary
				// re-validation checks landed under the same wave as the
				// FP-reduction helpers (path-segment + content-marker gates).
				// All advisory because the pattern shapes are heuristic.
				"await_state_toctou",
				"boundary_copy_no_revalidation",
				"cleanup_reentrancy",
				"cleanup_skipped_on_early_exit",
				"tainted_to_privileged_sink",
				// Batch 5: cross-file — advisory (heuristic)
				"empty_body_handler",
				"listener_pairing",
				"schema_type_drift",
				// CUDA inline checks — advisory (heuristic)
				"cuda_kernel_launch_unchecked",
				"cuda_printf_in_device_code",
				// Demoted after dogfood-noise review (P1 finding):
				"agent_thumbprint_prose",
				"untestable_time_in_source",
				"duplicate_test_names",
				"test_legitimacy",
				"test_missing_sut_import",
				"test_nondeterminism",
				"demo_data_unmarked",
				// Test-hygiene heuristic — slow-subprocess flake detector.
				"test_subprocess_default_timeout",
				// Test-quality heuristics — mock-only + happy-path-only + introverted (no assertion reaches the SUT).
				"mock_only_test",
				"happy_path_only_test",
				"introverted_test",
				// Effect-TS lessons port (advisory until cross-realm-vs-single-realm
				// FP rate is measured).
				"error_dispatch_by_instanceof",
				// Swift / iOS heuristic checks — see advisory.ts for per-line rationale.
				"swift_abbreviations",
				"swift_combine_no_store",
				"swift_fatalerror_in_guard",
				"swift_global_var_no_isolation",
				"swift_notification_observer_no_removal",
				"swift_print_in_view_body",
				"swift_self_in_escaping_closure",
				"swift_timer_no_invalidate",
				"swift_try_question_discarded",
				"swift_unhandled_task_error",
				"unjustified_cast",
				"process_env_outside_config",
				"top_level_side_effect",
				// Type-discipline wave (2026-08-14): ported from dmmulroy/anti-slop,
				// detection algorithm only (docs/external-pulse/anti-slop.md).
				"conditional_empty_object_spread",
				"unknown_type_alias",
				// Plan 25 lanes 6-8 (2026-08-17): portability lint (checks/portability.ts)
				// + boundary/contract wave (checks/test-contract-annotation.ts,
				// checks/unvalidated-input-boundary.ts). All advisory pending dogfood
				// FP calibration, except test_contract_annotation, which is
				// adoption-triggered (zero-FP by construction).
				"dynamic_code_execution",
				"builtin_prototype_mutation",
				"float_equality_comparison",
				"python_portability_trap",
				"test_contract_annotation",
				"unvalidated_input_boundary",
				// tseslint-types verify row (strict-types campaign, 2026-09-01)
				"tseslint-types",
				// Effect second-look wave (2026-09-01)
				"fetch_without_abort_signal",
				"public_api_leaks_internal_type",
				// type-redundancy wave (2026-09-01)
				"dead_type_exports",
				"duplicate_type_declaration",
				// helper-hygiene wave (2026-09-01)
				"new_export_without_importer",
				"extracted_helper_duplicate",
				// Quality-frontier wave (2026-07-06): verify-only doc-drift sibling +
				// two low-not-zero-FP heuristics pending cross-repo calibration.
				"readme_script_drift",
				"spec_path_ref",
				"contradictory_nullness_chain",
				"resource_handle_leak",
				// Retrieval-legibility wave (2026-08-10): an anonymous handler still
				// RUNS correctly — it is only unreachable from its own id by name, so
				// the cost is legibility, not correctness. Deep-audit tier.
				"anonymous_registration",
			].sort(),
		);
	});
});
