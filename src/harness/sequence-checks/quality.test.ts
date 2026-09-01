import { describe, expect, it } from "vitest";

import { buildTrajectoryFixture, makeCandidate } from "../__tests__/sequence-fixtures.js";
import {
	addThenRevertLoop,
	coverageSilentRegression,
	magicLiteralCrossFileProliferation,
	planVsTrajectoryDriftQuality,
	regressionTestMissingAfterFix,
	signatureChangeCallersNotUpdated,
	staleDocSibling,
	unusedHelperIntroduced,
} from "./quality.js";

describe("signature_change_callers_not_updated", () => {
	function makeCompletion(): { source_file: string; affected_files: string[]; resolved_files: Set<string>; recorded_at_tool_call: number; description: string } {
		return {
			source_file: "src/auth.ts",
			affected_files: ["src/api.ts", "src/handler.ts"],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "exported function signature changed",
		};
	}

	it("fires when export changed but no affected file was read/written", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } },
		]);
		session.pending_completions.set("src/auth.ts", makeCompletion());
		const matches = signatureChangeCallersNotUpdated.fn(session, lastEvent);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.message).toMatch(/signature|callers/i);
	});

	it("does not fire when every affected file is in files_read", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } },
		]);
		const completion = makeCompletion();
		completion.resolved_files.add("src/api.ts");
		completion.resolved_files.add("src/handler.ts");
		session.pending_completions.set("src/auth.ts", completion);
		expect(signatureChangeCallersNotUpdated.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when there are no pending completions", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
		]);
		expect(signatureChangeCallersNotUpdated.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when affected_files is empty (no callers)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } },
		]);
		session.pending_completions.set("src/auth.ts", {
			...makeCompletion(),
			affected_files: [],
		});
		expect(signatureChangeCallersNotUpdated.fn(session, lastEvent)).toEqual([]);
	});

	it("truncates the evidence list and adds a '+N more' suffix when unresolved exceeds 3", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } },
		]);
		session.pending_completions.set("src/auth.ts", {
			...makeCompletion(),
			affected_files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
		});
		const [match] = signatureChangeCallersNotUpdated.fn(session, lastEvent);
		expect(match?.message).toContain("(+2 more)");
		expect(match?.evidence).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("fires only for the partially-resolved completions, not the fully-resolved ones", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/auth.ts" } },
		]);
		const a = makeCompletion();
		const b = { ...makeCompletion(), source_file: "src/db.ts" };
		b.resolved_files = new Set(["src/api.ts", "src/handler.ts"]);
		session.pending_completions.set("src/auth.ts", a);
		session.pending_completions.set("src/db.ts", b);
		const matches = signatureChangeCallersNotUpdated.fn(session, lastEvent);
		expect(matches.some((m) => m.message.includes("src/auth.ts"))).toBe(true);
		expect(matches.some((m) => m.message.includes("src/db.ts"))).toBe(false);
	});
});

describe("regression_test_missing_after_fix", () => {
	it("fires when a failed source file is edited but no sibling test edited", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
		]);
		session.failed_files.set("src/foo.ts", {
			failure_count: 1,
			checks: ["tsc"],
			recorded_at: "2026-05-27T00:00:00Z",
			tool_call_count: 1,
		});
		const matches = regressionTestMissingAfterFix.fn(session, lastEvent);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not fire when the matching test file was edited", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.test.ts" } },
		]);
		session.failed_files.set("src/foo.ts", {
			failure_count: 1,
			checks: ["tsc"],
			recorded_at: "2026-05-27T00:00:00Z",
			tool_call_count: 1,
		});
		expect(regressionTestMissingAfterFix.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when there are no failed files", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
		]);
		expect(regressionTestMissingAfterFix.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when the matching .spec.ts file was edited", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" } },
			{ tool_name: "Edit", tool_input: { file_path: "src/foo.spec.ts" } },
		]);
		session.failed_files.set("src/foo.ts", {
			failure_count: 1,
			checks: ["tsc"],
			recorded_at: "2026-05-27T00:00:00Z",
			tool_call_count: 1,
		});
		expect(regressionTestMissingAfterFix.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when the failed file itself was never written this session", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" } },
		]);
		session.failed_files.set("src/foo.ts", {
			failure_count: 1,
			checks: ["tsc"],
			recorded_at: "2026-05-27T00:00:00Z",
			tool_call_count: 1,
		});
		expect(regressionTestMissingAfterFix.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire for failed files that were not source files (e.g., config)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "package.json" } },
		]);
		session.failed_files.set("package.json", {
			failure_count: 1,
			checks: ["json"],
			recorded_at: "2026-05-27T00:00:00Z",
			tool_call_count: 1,
		});
		expect(regressionTestMissingAfterFix.fn(session, lastEvent)).toEqual([]);
	});
});

describe("stale_doc_sibling", () => {
	it("fires for an edit to src/foo.ts when sibling docs/foo.md exists but was not touched", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "stale-doc-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "docs"), { recursive: true });
			writeFileSync(join(dir, "src", "foo.ts"), "// foo\n");
			writeFileSync(join(dir, "docs", "foo.md"), "# foo\n");
			const sourcePath = join(dir, "src", "foo.ts");
			const { session } = buildTrajectoryFixture([
				{
					tool_name: "Edit",
					tool_input: { file_path: sourcePath },
					cwd: dir,
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: sourcePath },
				cwd: dir,
			});
			const matches = staleDocSibling.fn(session, candidate);
			expect(matches.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire when sibling doc does not exist", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "/nowhere/src/foo.ts" } },
		]);
		expect(staleDocSibling.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when sibling doc was edited this session", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "stale-doc-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "docs"), { recursive: true });
			writeFileSync(join(dir, "src", "foo.ts"), "// foo\n");
			writeFileSync(join(dir, "docs", "foo.md"), "# foo\n");
			const sourcePath = join(dir, "src", "foo.ts");
			const docPath = join(dir, "docs", "foo.md");
			const { session } = buildTrajectoryFixture([
				{
					tool_name: "Edit",
					tool_input: { file_path: sourcePath },
					cwd: dir,
				},
				{
					tool_name: "Edit",
					tool_input: { file_path: docPath },
					cwd: dir,
				},
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: sourcePath },
				cwd: dir,
			});
			expect(staleDocSibling.fn(session, candidate)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire on non-edit candidate events", () => {
		const { session } = buildTrajectoryFixture([
			{ tool_name: "Read", tool_input: { file_path: "src/foo.ts" } },
		]);
		const candidate = makeCandidate({
			tool_name: "Read",
			tool_input: { file_path: "src/foo.ts" },
		});
		expect(staleDocSibling.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the Edit candidate has no file_path at all", () => {
		const { session } = buildTrajectoryFixture([{ tool_name: "Edit", tool_input: {} }]);
		const candidate = makeCandidate({ tool_name: "Edit", tool_input: {} });
		expect(staleDocSibling.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the edited file is not a source file (e.g. .json)", () => {
		const { session } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/config.json" } },
		]);
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: "src/config.json" },
		});
		expect(staleDocSibling.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the only existing sibling doc was already READ this session (continues past it)", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "stale-doc-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "docs"), { recursive: true });
			writeFileSync(join(dir, "src", "foo.ts"), "// foo\n");
			writeFileSync(join(dir, "docs", "foo.md"), "# foo\n");
			const sourcePath = join(dir, "src", "foo.ts");
			const docPath = join(dir, "docs", "foo.md");
			const { session } = buildTrajectoryFixture([
				{ tool_name: "Edit", tool_input: { file_path: sourcePath }, cwd: dir },
				{ tool_name: "Read", tool_input: { file_path: docPath }, cwd: dir },
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: sourcePath },
				cwd: dir,
			});
			expect(staleDocSibling.fn(session, candidate)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves a RELATIVE file_path against cwd (not-absolute branch) and still fires", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "stale-doc-"));
		try {
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, "docs"), { recursive: true });
			writeFileSync(join(dir, "src", "foo.ts"), "// foo\n");
			writeFileSync(join(dir, "docs", "foo.md"), "# foo\n");
			const { session } = buildTrajectoryFixture([
				{ tool_name: "Edit", tool_input: { file_path: "src/foo.ts" }, cwd: dir },
			]);
			const candidate = makeCandidate({
				tool_name: "Edit",
				tool_input: { file_path: "src/foo.ts" },
				cwd: dir,
			});
			const matches = staleDocSibling.fn(session, candidate);
			expect(matches.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("magic_literal_cross_file_proliferation", () => {
	it("fires when the same literal hash spans 3 files this session", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map([
			[
				"hash:api-token-expiration-2026",
				new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
			],
		]);
		const matches = magicLiteralCrossFileProliferation.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/literal|constant/i);
		expect(matches[0]?.message).toContain("3");
	});

	it("fires for each literal that crosses the threshold (multiple findings)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map([
			["hash:one", new Set(["a.ts", "b.ts", "c.ts"])],
			["hash:two", new Set(["d.ts", "e.ts", "f.ts", "g.ts"])],
		]);
		const matches = magicLiteralCrossFileProliferation.fn(session, lastEvent);
		expect(matches.length).toBe(2);
	});

	it("includes the offending file list as evidence (truncated to 3)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map([
			[
				"hash:widely-used",
				new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]),
			],
		]);
		const [match] = magicLiteralCrossFileProliferation.fn(session, lastEvent);
		expect(match?.evidence?.length).toBe(3);
	});

	it("does not fire when the spread is test files — self-contained suites repeat fixtures by contract (2026-08-23 carve-out)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.test.ts" } },
		]);
		session.literal_occurrences = new Map([
			[
				"hash:shared-fixture",
				new Set(["src/a.test.ts", "src/b.mutation-kill-w49.test.ts", "src/c.spec.tsx", "src/d.ts", "src/e.ts"]),
			],
		]);
		// 3 test files filtered out; 2 non-test files remain — under threshold.
		expect(magicLiteralCrossFileProliferation.fn(session, lastEvent)).toEqual([]);
	});

	it("still fires when 3+ NON-test files share the literal even alongside test files", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map([
			["hash:real-spread", new Set(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.test.ts"])],
		]);
		const matches = magicLiteralCrossFileProliferation.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toContain("3 different files");
	});

	it("does not fire when the spread is scratch probe scripts (2026-08-23 carve-out: throwaway analysis files repeat fixtures by nature)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Write", tool_input: { file_path: "scratch/w57/sim2.mjs" } },
		]);
		session.literal_occurrences = new Map([
			[
				"hash:probe-fixture",
				new Set(["scratch/w57/sim2.mjs", "scratch/w57/sim3.mjs", "scratch/w57/sim4.mjs", "src/real.ts"]),
			],
		]);
		// 3 scratch probes filtered; 1 source file remains — under threshold.
		expect(magicLiteralCrossFileProliferation.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when the literal appears in only 2 files", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map([
			["hash:only-two", new Set(["a.ts", "b.ts"])],
		]);
		expect(magicLiteralCrossFileProliferation.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when literal_occurrences is undefined (older snapshot)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = undefined;
		expect(magicLiteralCrossFileProliferation.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when literal_occurrences is empty", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.literal_occurrences = new Map();
		expect(magicLiteralCrossFileProliferation.fn(session, lastEvent)).toEqual([]);
	});
});

describe("coverage_silent_regression", () => {
	it("fires when 6 source files written, no tests touched, suite green", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
		]);
		session.files_read = new Set();
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 5 });
		const matches = coverageSilentRegression.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/test|coverage/i);
	});

	it("fires regardless of how many source files exist beyond the threshold", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
			"src/g.ts",
		]);
		session.files_read = new Set();
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 1 });
		expect(coverageSilentRegression.fn(session, lastEvent).length).toBe(1);
	});

	it("fires only when ALL test runs are green (mixed pass+fail does not fire)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
		]);
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 1 });
		session.test_runs.set("src/b.test.ts", { status: "fail", at_step: 2 });
		expect(coverageSilentRegression.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when a test file was edited", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
			"src/a.test.ts",
		]);
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 1 });
		expect(coverageSilentRegression.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when source-file count is at or below threshold", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 1 });
		expect(coverageSilentRegression.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when a test file was only READ (not written) this session", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
		]);
		session.files_read = new Set(["src/a.test.ts"]);
		session.test_runs.set("src/a.test.ts", { status: "pass", at_step: 1 });
		expect(coverageSilentRegression.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when no test runs were recorded (can't claim green)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.files_written = new Set([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/d.ts",
			"src/e.ts",
			"src/f.ts",
		]);
		expect(coverageSilentRegression.fn(session, lastEvent)).toEqual([]);
	});
});

describe("add_then_revert_loop", () => {
	it("fires when a file shows the same content_hash at positions 0 and 2 (one gap)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-B", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 3 },
				],
			],
		]);
		const matches = addThenRevertLoop.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/cycle|thrash|revert/i);
	});

	it("fires when a hash recurs 3 times with intervening edits", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-X", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-Y", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-X", at_step: 3 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-Z", at_step: 4 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-X", at_step: 5 },
				],
			],
		]);
		const matches = addThenRevertLoop.fn(session, lastEvent);
		expect(matches.length).toBe(1);
	});

	it("fires once per file even when multiple files cycle", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		const cycledHistory = [
			{ range: { start: 1, end: 5 }, content_hash: "A", at_step: 1 },
			{ range: { start: 1, end: 5 }, content_hash: "B", at_step: 2 },
			{ range: { start: 1, end: 5 }, content_hash: "A", at_step: 3 },
		];
		session.recent_line_edits = new Map([
			["src/one.ts", cycledHistory],
			["src/two.ts", cycledHistory],
		]);
		const matches = addThenRevertLoop.fn(session, lastEvent);
		expect(matches.length).toBe(2);
	});

	it("does not fire when same hash appears consecutively (idempotent re-apply)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 2 },
				],
			],
		]);
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when each hash appears only once", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-B", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-C", at_step: 3 },
				],
			],
		]);
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when recent_line_edits is undefined (older snapshot)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = undefined;
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	// --- FALSE-POSITIVE regression: blocked-then-retry is not a revert ---
	// The observed FP: an Edit is BLOCKED by the tsc overlay (file unchanged),
	// the agent retries and succeeds. The blocked attempt left the file in the
	// SAME content state — no distinct intervening B — so this must NOT count
	// as add-then-revert thrashing. After the fix the cycle requires a genuine
	// A→B→A oscillation (distinct intervening state). A legacy / hydrated
	// buffer polluted by the old dual-record path can still hold same-hash
	// runs; the detector must stay silent on them.

	it("does NOT fire when the same hash repeats with NO distinct intervening state (blocked-retry padding)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		// hash-A at 0, 1, 2 — the agent kept trying to apply the SAME content
		// (blocked, retried, succeeded). No B was ever reached. Zero reverts.
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 3 },
				],
			],
		]);
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	it("does NOT fire when the gap between two A's is filled only with more A's (index gap, no distinct B)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		// Positions of hash-A are 0 and 3 (an index gap > 1), but everything in
		// between is ALSO hash-A — the file never moved to a different state, so
		// it is not a revert. The old `hasNonConsecutiveGap` would have fired
		// here; the distinct-intervening rule correctly stays silent.
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 3 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 4 },
				],
			],
		]);
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	it("does NOT fire on clean forward progress A→B→C→D (each state distinct, no return)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		// Pure forward progress: four distinct content states, no hash repeats.
		// This is the shape of a successful refactor after a blocked first try.
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-B", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-C", at_step: 3 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-D", at_step: 4 },
				],
			],
		]);
		expect(addThenRevertLoop.fn(session, lastEvent)).toEqual([]);
	});

	it("STILL fires on a genuine A→B→A oscillation (true positive preserved)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
		]);
		session.recent_line_edits = new Map([
			[
				"src/a.ts",
				[
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 1 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-B", at_step: 2 },
					{ range: { start: 1, end: 5 }, content_hash: "hash-A", at_step: 3 },
				],
			],
		]);
		const matches = addThenRevertLoop.fn(session, lastEvent);
		expect(matches.length).toBe(1);
	});
});

describe("unused_helper_introduced", () => {
	it("fires when a pending_completion has empty affected_files", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		session.pending_completions.set("src/helper.ts", {
			source_file: "src/helper.ts",
			affected_files: [],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "new exported helper",
		});
		const matches = unusedHelperIntroduced.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/helper|callers|unused/i);
	});

	it("fires for each unused-helper file independently", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		session.pending_completions.set("src/helper.ts", {
			source_file: "src/helper.ts",
			affected_files: [],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "added export",
		});
		session.pending_completions.set("src/util.ts", {
			source_file: "src/util.ts",
			affected_files: [],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 2,
			description: "added export",
		});
		expect(unusedHelperIntroduced.fn(session, lastEvent).length).toBe(2);
	});

	it("evidence contains the source file path", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		session.pending_completions.set("src/helper.ts", {
			source_file: "src/helper.ts",
			affected_files: [],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "exported helper",
		});
		const [match] = unusedHelperIntroduced.fn(session, lastEvent);
		expect(match?.evidence).toEqual(["src/helper.ts"]);
	});

	it("does not fire when affected_files is non-empty (that's §3.16's job)", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		session.pending_completions.set("src/helper.ts", {
			source_file: "src/helper.ts",
			affected_files: ["src/caller.ts"],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "exported helper",
		});
		expect(unusedHelperIntroduced.fn(session, lastEvent)).toEqual([]);
	});

	it("does not fire when there are no pending_completions", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		expect(unusedHelperIntroduced.fn(session, lastEvent)).toEqual([]);
	});

	it("only fires for the entries whose affected_files is empty", () => {
		const { session, lastEvent } = buildTrajectoryFixture([
			{ tool_name: "Edit", tool_input: { file_path: "src/helper.ts" } },
		]);
		session.pending_completions.set("src/orphan.ts", {
			source_file: "src/orphan.ts",
			affected_files: [],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 1,
			description: "orphan",
		});
		session.pending_completions.set("src/with-callers.ts", {
			source_file: "src/with-callers.ts",
			affected_files: ["src/caller.ts"],
			resolved_files: new Set<string>(),
			recorded_at_tool_call: 2,
			description: "wired",
		});
		const matches = unusedHelperIntroduced.fn(session, lastEvent);
		expect(matches.length).toBe(1);
		expect(matches[0]?.evidence).toEqual(["src/orphan.ts"]);
	});
});

describe("plan_vs_trajectory_drift_quality", () => {
	function planSession(): ReturnType<typeof buildTrajectoryFixture>["session"] {
		const { session } = buildTrajectoryFixture([
			{ tool_name: "Read", tool_input: { file_path: "src/auth.ts" } },
		]);
		session.declared_plan = {
			session_id: "test-session",
			agent_name: "tester",
			created_at_iso: "2026-05-27T00:00:00.000Z",
			created_at_step: 0,
			source: "TaskCreate",
			steps: [{ intent: "edit auth", tool_hint: "Edit", status: "pending" }],
		};
		return session;
	}

	it("fires when candidate diverges from plan AND no untrusted source ingested", () => {
		const session = planSession();
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "ls -la" },
		});
		const matches = planVsTrajectoryDriftQuality.fn(session, candidate);
		expect(matches.length).toBe(1);
		expect(matches[0]?.message).toMatch(/plan|scope|drift/i);
	});

	it("fires when no taint sources exist at all", () => {
		const session = planSession();
		session.taint_sources = [];
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "echo hi" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate).length).toBe(1);
	});

	it("fires when only local_read taint sources are present (still trusted)", () => {
		const session = planSession();
		session.taint_sources.push({
			file: "src/local.ts",
			level: "Public",
			at_step: 2,
			provenance: "local_read",
		});
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "git status" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate).length).toBe(1);
	});

	it("does not fire when candidate aligns with plan tool_hints", () => {
		const session = planSession();
		const candidate = makeCandidate({
			tool_name: "Edit",
			tool_input: { file_path: "src/auth.ts" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when an untrusted source IS present (defers to §3.15)", () => {
		const session = planSession();
		session.taint_sources.push({
			file: "<WebFetch>",
			level: "Public",
			at_step: 1,
			provenance: "fetched_external",
		});
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "curl example.com" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when there is no declared plan", () => {
		const { session } = buildTrajectoryFixture([
			{ tool_name: "Read", tool_input: { file_path: "src/auth.ts" } },
		]);
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the plan's steps carry no tool_hint at all (empty hints)", () => {
		const { session } = buildTrajectoryFixture([
			{ tool_name: "Read", tool_input: { file_path: "src/auth.ts" } },
		]);
		session.declared_plan = {
			session_id: "test-session",
			agent_name: "tester",
			created_at_iso: "2026-05-27T00:00:00.000Z",
			created_at_step: 0,
			source: "TaskCreate",
			steps: [{ intent: "edit auth", status: "pending" }],
		};
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when the candidate has no tool_name at all", () => {
		const session = planSession();
		const candidate = makeCandidate({ tool_input: { command: "ls" } });
		candidate.tool_name = undefined;
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});

	it("does not fire when an mcp_remote source IS present after plan capture", () => {
		const session = planSession();
		session.taint_sources.push({
			file: "mcp:remote-tool",
			level: "Public",
			at_step: 1,
			provenance: "mcp_remote",
		});
		const candidate = makeCandidate({
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(planVsTrajectoryDriftQuality.fn(session, candidate)).toEqual([]);
	});
});
