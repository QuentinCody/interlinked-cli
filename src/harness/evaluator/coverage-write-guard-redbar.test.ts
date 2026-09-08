// Unit tests for coverage-write-guard-redbar.ts — red-bar-only enforcement for
// NON-TARGET gated sections (delete-only patches and residual-language
// sections a target-bearing plan's runner didn't already cover).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateRuntimeEstimateMs } from "../coverage-obligation-ledger.js";
import type { CoverageOverlay, OverlayFile } from "../coverage-overlay.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import type { CoverageEditPlan } from "./coverage-edit-targets.js";
import type { CoverageWriteDeps } from "./coverage-write-guard.js";
import {
	blockForCrossSuiteRedBar,
	blockForDeletionRedBar,
	decideForDeletionOnly,
	decideForResidualLanguages,
} from "./coverage-write-guard-redbar.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-redbar-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cfg(
	overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>,
): NonNullable<GuardRulesConfig["per_edit_coverage"]> {
	return ({
		enabled: true,
		mode: "block",
		budget_ms: 25_000,
		languages: ["js", "ts"],
		...overrides,
	} satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>);
}

function event(): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, "src/a.ts") },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function plan(
	overlayFiles: OverlayFile[],
	overrides?: Partial<CoverageEditPlan>,
): CoverageEditPlan {
	return {
		targets: [],
		overlayFiles,
		isPatch: true,
		fullSuiteReason: null,
		...overrides,
	};
}

function stubOverlay(): CoverageWriteDeps["createOverlay"] {
	return (projectRoot, editedRelPath): CoverageOverlay => ({
		overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
		editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
		cleanup: () => {},
	});
}

/** A runner keyed by an execution id, so two languages can dedup onto one run. */
function runnerFor(id: string, result: CoverageRunResult): { runner: CoverageRunner; calls: () => number } {
	let calls = 0;
	const runner: CoverageRunner = {
		id,
		run: async () => {
			calls++;
			return result;
		},
	};
	return { runner, calls: () => calls };
}

function greenResult(): CoverageRunResult {
	return { suiteMs: 100, perFile: new Map(), ok: true, testsPassed: true };
}

function redResult(failingTests?: string[], failingTestFiles?: string[]): CoverageRunResult {
	return {
		suiteMs: 100,
		perFile: new Map(),
		ok: true,
		testsPassed: false,
		...(failingTests !== undefined ? { failingTests } : {}),
		...(failingTestFiles !== undefined ? { failingTestFiles } : {}),
	};
}

function deps(overrides?: Partial<CoverageWriteDeps>): CoverageWriteDeps {
	return {
		runnerFor: () => null,
		createOverlay: stubOverlay(),
		clock: () => 0,
		cyclomaticFor: () => () => [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// decideForDeletionOnly
// ---------------------------------------------------------------------------

describe("decideForDeletionOnly", () => {
	it("is a no-op when the patch deletes nothing gated (runner never called)", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "x", delete: false }]);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("is a no-op when block_on_test_failure is not true, even with a gated deletion", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const { runner, calls } = runnerFor("vitest", redResult());
		const result = await decideForDeletionOnly(event(), cfg(), deps({ runnerFor: () => runner }), p, root);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("defers when the runtime estimate is over budget (runner never called, obligation recorded)", async () => {
		updateRuntimeEstimateMs(root, 30_000);
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const { runner, calls } = runnerFor("vitest", redResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("ALLOWS (null) when the red-bar suite runs green", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("BLOCKS with blockForDeletionRedBar when the deleted file's own language is red", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const { runner } = runnerFor("vitest", redResult(["it fails"], ["src/a.test.ts"]));
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toEqual({
			decision: "block",
			reason:
				"[interlinked:coverage] BLOCKED: deleting src/a.ts leaves the test suite RED — " +
				"failing test(s): it fails. Other code still depends on what this patch " +
				"removes; update or remove the dependents in the SAME patch (the overlay sees the " +
				"whole patch together), then retry.",
			rule_id: "per-edit-coverage",
			severity: "medium",
			category: "coverage",
			failing_test_files: ["src/a.test.ts"],
		});
	});

	it("BLOCKS with blockForCrossSuiteRedBar when a SIBLING gated section (no deletion in that language) is red", async () => {
		// The deletion is TypeScript; a Python section rides along in the same patch
		// and its suite is red — no python deletion exists, so the cross-suite path
		// fires instead of the deletion path.
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "src/b.py", content: "def f(): pass\n" },
		]);
		const pyRunner = runnerFor("pytest", redResult(["test_b"]));
		const tsRunner = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, languages: ["js", "ts", "python"] }),
			deps({
				runnerFor: (language) => (language === "python" ? pyRunner.runner : tsRunner.runner),
			}),
			p,
			root,
		);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("python sections (src/b.py) leave the python test suite RED");
		expect(result?.reason).not.toContain("deleting");
	});

	it("fails open (loudDegrade) when the overlay throws", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({
				runnerFor: () => runnerFor("vitest", greenResult()).runner,
				createOverlay: () => {
					throw new Error("mirror failed");
				},
			}),
			p,
			root,
		);
		expect(result?.decision).toBe("allow");
		expect((result?.warnings ?? []).join("\n")).toMatch(/mirror failed/);
	});

	it("fails open with loudRunnerUnavailable when no runner exists for the language", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => null }),
			p,
			root,
		);
		expect(result?.decision).toBe("allow");
		expect((result?.warnings ?? []).join("\n")).toMatch(/no coverage runner for ts/);
	});

	it("fails open with loudRunnerUnavailable when the run reports ok:false", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 5, perFile: new Map(), ok: false, error: "spawn ENOENT", testsPassed: null }),
		};
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => failing }),
			p,
			root,
		);
		expect(result?.decision).toBe("allow");
		expect((result?.warnings ?? []).join("\n")).toMatch(/spawn ENOENT/);
	});

	it("ignores a non-gated sibling section (unresolvable language) when grouping by language", async () => {
		// README.md resolves to language `null` and must be skipped, not crash
		// grouping or get counted as a residual/red language.
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "README.md", content: "# notes\n" },
		]);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("dedups by runner execution id: two gated languages sharing a runner id run the suite ONCE", async () => {
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "src/b.js", content: "", delete: true },
		]);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, languages: ["js", "ts"] }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// decideForResidualLanguages
// ---------------------------------------------------------------------------

describe("decideForResidualLanguages", () => {
	function planWithTargetAndResidual(): CoverageEditPlan {
		return plan(
			[
				{ relPath: "src/a.ts", content: "export const a = 1;\n" },
				{ relPath: "src/b.py", content: "def f(): pass\n" },
			],
			{
				targets: [{ relPath: "src/a.ts", language: "ts", proposed: "export const a = 1;\n", editedLines: new Set([1]) }],
			},
		);
	}

	it("is a no-op when block_on_test_failure is not true", async () => {
		const { runner, calls } = runnerFor("pytest", redResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"] }),
			deps({ runnerFor: () => runner }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("is a no-op when every gated section's runner already ran as a target (no residual)", async () => {
		// Only a ts target, only a ts section — nothing residual.
		const p = plan([{ relPath: "src/a.ts", content: "export const a = 1;\n" }], {
			targets: [{ relPath: "src/a.ts", language: "ts", proposed: "export const a = 1;\n", editedLines: new Set([1]) }],
		});
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("defers when the runtime estimate is over budget", async () => {
		updateRuntimeEstimateMs(root, 30_000);
		const { runner, calls } = runnerFor("pytest", redResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: (language) => (language === "python" ? runner : null) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("runs the residual (non-target) language's suite and ALLOWS when green", async () => {
		// The runner is keyed to "python" only, so the ts target resolves its OWN
		// (unshared) execution key and the python section stays residual.
		const { runner, calls } = runnerFor("pytest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			deps({ runnerFor: (language) => (language === "python" ? runner : null) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("BLOCKS with blockForCrossSuiteRedBar when the residual language is red", async () => {
		const { runner } = runnerFor("pytest", redResult(["test_b"]));
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			deps({ runnerFor: (language) => (language === "python" ? runner : null) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result?.decision).toBe("block");
		expect(result?.reason).toContain("python sections (src/b.py) leave the python test suite RED");
	});

	it("fails open (loudDegrade) when the overlay throws", async () => {
		const pyRunner = runnerFor("pytest", greenResult()).runner;
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			deps({
				runnerFor: (language) => (language === "python" ? pyRunner : null),
				createOverlay: () => {
					throw new Error("mirror boom");
				},
			}),
			planWithTargetAndResidual(),
			root,
		);
		expect(result?.decision).toBe("allow");
		expect((result?.warnings ?? []).join("\n")).toMatch(/mirror boom/);
	});
});

// ---------------------------------------------------------------------------
// blockForDeletionRedBar / blockForCrossSuiteRedBar (direct)
// ---------------------------------------------------------------------------

describe("blockForDeletionRedBar", () => {
	it("shows all paths verbatim when there are 3 or fewer", () => {
		const result = blockForDeletionRedBar(["a.ts", "b.ts"], ["t1"], undefined);
		expect(result.reason).toContain("deleting a.ts, b.ts leaves the test suite RED");
		expect(result.reason).not.toContain("…");
		expect(result.failing_test_files).toBeUndefined();
	});

	it("truncates to 3 with an ellipsis when there are more than 3 paths, and omits empty failingTestFiles", () => {
		const result = blockForDeletionRedBar(["a.ts", "b.ts", "c.ts", "d.ts"], undefined, []);
		expect(result.reason).toContain("deleting a.ts, b.ts, c.ts, … leaves the test suite RED");
		expect(result.failing_test_files).toBeUndefined();
	});

	it("carries failing_test_files when non-empty", () => {
		const result = blockForDeletionRedBar(["a.ts"], ["t1"], ["a.test.ts", "b.test.ts"]);
		expect(result.failing_test_files).toEqual(["a.test.ts", "b.test.ts"]);
	});
});

describe("blockForCrossSuiteRedBar", () => {
	it("shows all paths verbatim when there are 3 or fewer", () => {
		const result = blockForCrossSuiteRedBar("python", ["a.py", "b.py"], ["t1"]);
		expect(result.reason).toContain("(a.py, b.py) leave the python test suite RED");
		expect(result.reason).not.toContain("…");
	});

	it("truncates to 3 with an ellipsis when there are more than 3 paths", () => {
		const result = blockForCrossSuiteRedBar("python", ["a.py", "b.py", "c.py", "d.py"], undefined);
		expect(result.reason).toContain("(a.py, b.py, c.py, …) leave the python test suite RED");
	});
});
