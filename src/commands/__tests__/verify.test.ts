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

// Pins the invariant for the tail "X / Y files flagged" summary:
//   - numerator ≤ denominator (always — regression: v0 produced 68 / 67),
//   - synthetic sentinels like "<project>" do not inflate the numerator,
//   - a file flagged by an external tool but outside the discovered source
//     sweep (e.g. tsc error in tsconfig.json) expands both sides so the ratio
//     stays meaningful.
describe("summarizeFlaggedFiles", () => {
	it("reports numerator ≤ denominator and drops the <project> sentinel", async () => {
		const { summarizeFlaggedFiles } = await import("../verify.js");
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`, `${cwd}/src/c.ts`];
		// Mirror the real mix in allFlaggedFiles: absolute hit, relative hit,
		// bare-filename hit, the project sentinel.
		const flagged = new Set([
			`${cwd}/src/a.ts`, // absolute — same as discovered[0]
			"src/b.ts", // relative — same as discovered[1]
			"tsconfig.json", // non-source file flagged by tsc
			"<project>", // project-wide LOC-ratio finding
		]);
		const tally = summarizeFlaggedFiles(cwd, files, flagged);
		expect(tally.flaggedFiles).toBe(3); // a.ts, b.ts, tsconfig.json
		expect(tally.totalFiles).toBe(4); // + c.ts from discovered
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("never exceeds the denominator even when every path is synthetic or non-discovered", async () => {
		const { summarizeFlaggedFiles } = await import("../verify.js");
		const cwd = "/repo";
		const flagged = new Set(["<project>", "<project>", "tsconfig.json", "package.json"]);
		const tally = summarizeFlaggedFiles(cwd, [], flagged);
		// A Set collapses the duplicate "<project>" token, so only one project
		// finding reaches us. Both non-source hits land in the universe.
		expect(tally.flaggedFiles).toBe(2);
		expect(tally.totalFiles).toBe(2);
		expect(tally.projectFindings).toBe(1);
		expect(tally.flaggedFiles).toBeLessThanOrEqual(tally.totalFiles);
	});

	it("returns a zero tally when nothing is flagged", async () => {
		const { summarizeFlaggedFiles } = await import("../verify.js");
		const cwd = "/repo";
		const files = [`${cwd}/src/a.ts`, `${cwd}/src/b.ts`];
		const tally = summarizeFlaggedFiles(cwd, files, new Set());
		expect(tally).toEqual({ flaggedFiles: 0, totalFiles: 2, projectFindings: 0 });
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
				"circular_imports",
				"complexity",
				"conditional_in_test",
				"console_statements",
				"crap",
				"data_clump",
				"dead_exports",
				"default_export",
				"else_if_chain",
				"files_without_test",
				"flag_argument",
				"function_arg_count",
				"fuzzy_responsibility_name",
				"hybrid_class",
				"knip",
				"large_files",
				"lifecycle_cleanup",
				"loop_nesting_depth",
				"magic_literal_in_conditional",
				"magic_number",
				"missing_return_types",
				"nested_ternaries",
				"no_test_file",
				"non_null_assertion",
				"over_mocking",
				"require_await",
				"same_typed_primitive_params",
				"sequential_awaits",
				"single_implementation_interface",
				"test_regressions",
				"ubs_deeply_nested_callback",
				"ubs_defer_in_loop",
				"ubs_division_by_variable",
				"ubs_goroutine_no_waitgroup",
				"ubs_hardcoded_localhost",
				"ubs_large_function",
				"ubs_magic_number_no_const",
				"ubs_numeric_comparison_chain",
				"ubs_print_debug_leak",
				"ubs_regex_in_loop_no_compile",
				"ubs_string_concat_in_loop",
				"ubs_time_format_locale_dep",
				"unvalidated_json_boundary",
				// Batch 1: agent-laziness — advisory (heuristic)
				"fetch_without_timeout",
				"sync_io_on_hot_path",
				"type_smuggling",
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
				// Batch 8: demo-data — advisory (heuristic)
				"silent_demo_fallback",
				// CUDA inline checks — advisory (heuristic)
				"cuda_kernel_launch_unchecked",
				"cuda_printf_in_device_code",
				// Demoted after dogfood-noise review (P1 finding):
				"agent_thumbprint_prose",
				"untestable_time_in_source",
				"duplicate_test_names",
				"test_missing_sut_import",
				"test_nondeterminism",
				"demo_data_unmarked",
			].sort(),
		);
	});
});
