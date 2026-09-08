// Wave pass1_w48 survivor-kill suite for coverage-write-guard-redbar.ts.
// Targets 32 listed survivor mutants across gatedDeletions, gatedSectionsByLanguage,
// runRedBarSuites, decideForDeletionOnly, decideForResidualLanguages,
// blockForDeletionRedBar, blockForCrossSuiteRedBar.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadRules } from "../rules-loader.js";
import { nonNull } from "../../lib/non-null.js";
import type { JsonObject } from "../../lib/json-types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOpenCoverageObligations, updateRuntimeEstimateMs } from "../coverage-obligation-ledger.js";
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
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-redbar-w48-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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

function persistedCoverage(overrides: JsonObject): NonNullable<GuardRulesConfig["per_edit_coverage"]> {
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, ".interlinked", "guard-rules.local.json"),
		JSON.stringify({ per_edit_coverage: { ...cfg(), ...overrides } }));
	return nonNull(loadRules(root).per_edit_coverage);
}

function event(): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-w48",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, "src/a.ts") },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function plan(overlayFiles: OverlayFile[], overrides?: Partial<CoverageEditPlan>): CoverageEditPlan {
	return {
		targets: [],
		overlayFiles,
		isPatch: true,
		fullSuiteReason: null,
		...overrides,
	};
}

function stubOverlay(onCreate?: (projectRoot: string, editedRelPath: string, content: string) => void): CoverageWriteDeps["createOverlay"] {
	return (projectRoot, editedRelPath, content): CoverageOverlay => {
		onCreate?.(projectRoot, editedRelPath, content);
		return {
			overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
			editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
			cleanup: () => {},
		};
	};
}

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

function redResult(failingTests?: string[]): CoverageRunResult {
	return {
		suiteMs: 100,
		perFile: new Map(),
		ok: true,
		testsPassed: false,
		...(failingTests !== undefined ? { failingTests } : {}),
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
// gatedDeletions (private, reached through decideForDeletionOnly)
// ---------------------------------------------------------------------------

describe("gatedDeletions — reachable only through decideForDeletionOnly", () => {
	it("excludes a deletion whose resolvable language is NOT in cfg.languages (no obligation recorded)", async () => {
		// python file deleted, but cfg only gates ts — real code must treat this
		// as nothing-gated-deleted and never touch the budget/obligation machinery.
		const p = plan([{ relPath: "src/x.py", content: "", delete: true }]);
		updateRuntimeEstimateMs(root, 30_000); // deliberately over budget
		const { runner, calls } = runnerFor("pytest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ languages: ["ts"], block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
		expect(readOpenCoverageObligations(root, "sess-w48")).toHaveLength(0);
	});

	it("excludes a deletion whose language is unresolvable, even if cfg.languages contains a matching null sentinel (no obligation recorded)", async () => {
		// Exercises the `language !== null` half specifically: force cfg.languages
		// to contain the literal value null (bypassing the string[] type) so
		// `cfg.languages.includes(language)` alone would read true for README.md.
		const p = plan([{ relPath: "README.md", content: "", delete: true }]);
		updateRuntimeEstimateMs(root, 30_000); // deliberately over budget
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			persistedCoverage({
				languages: ["ts", null],
				block_on_test_failure: true,
				budget_ms: 25_000,
			}),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
		expect(readOpenCoverageObligations(root, "sess-w48")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// gatedSectionsByLanguage (private, reached through decideForDeletionOnly)
// ---------------------------------------------------------------------------

describe("gatedSectionsByLanguage — reachable only through decideForDeletionOnly", () => {
	it("excludes a non-delete section whose resolvable language is not gated by cfg (python not called)", async () => {
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "src/b.py", content: "def f(): pass\n" },
		]);
		const { runner: tsRunner, calls: tsCalls } = runnerFor("vitest", greenResult());
		let pythonCalled = false;
		const result = await decideForDeletionOnly(
			event(),
			cfg({ languages: ["ts"], block_on_test_failure: true }),
			deps({
				runnerFor: (language) => {
					if (language === "python") {
						pythonCalled = true;
						return null;
					}
					return tsRunner;
				},
			}),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(tsCalls()).toBe(1);
		expect(pythonCalled).toBe(false);
	});

	it("excludes an unresolvable-language section (README.md) even when cfg.languages carries a null sentinel matching it", async () => {
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "README.md", content: "# notes\n" },
		]);
		const { runner: tsRunner, calls: tsCalls } = runnerFor("vitest", greenResult());
		let nullLanguageCalled = false;
		const result = await decideForDeletionOnly(
			event(),
			persistedCoverage({
				languages: ["ts", null],
				block_on_test_failure: true,
			}),
			deps({
				runnerFor: (language) => {
					if (language === "ts") return tsRunner;
					nullLanguageCalled = true;
					return null;
				},
			}),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(tsCalls()).toBe(1);
		expect(nullLanguageCalled).toBe(false);
	});

	it("excludes an unresolvable-language section (README.md) under plain cfg.languages (no null sentinel needed)", async () => {
		const p = plan([
			{ relPath: "src/a.ts", content: "", delete: true },
			{ relPath: "README.md", content: "# notes\n" },
		]);
		const { runner: tsRunner, calls: tsCalls } = runnerFor("vitest", greenResult());
		let anyOtherRunnerCalled = false;
		const result = await decideForDeletionOnly(
			event(),
			cfg({ languages: ["ts"], block_on_test_failure: true }),
			deps({
				runnerFor: (language) => {
					if (language === "ts") return tsRunner;
					anyOtherRunnerCalled = true;
					return null;
				},
			}),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(tsCalls()).toBe(1);
		expect(anyOtherRunnerCalled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runRedBarSuites internals (private, reached through decideForDeletionOnly)
// ---------------------------------------------------------------------------

describe("runRedBarSuites internals", () => {
	it("passes the DELETED anchor's proposed content as empty string, not its stale content", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "STALE CONTENT SHOULD NOT APPEAR", delete: true }]);
		let seenContent: string | undefined;
		const { runner } = runnerFor("vitest", greenResult());
		await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({
				runnerFor: () => runner,
				createOverlay: stubOverlay((_root, _rel, content) => {
					seenContent = content;
				}),
			}),
			p,
			root,
		);
		expect(seenContent).toBe("");
	});

	it("passes the real overlay root + coverage dir to the runner's run() options", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		let seenOpts: { projectRoot?: string; coverageDir?: string } = {};
		const runner: CoverageRunner = {
			id: "vitest",
			run: async (opts) => {
				seenOpts = opts;
				return greenResult();
			},
		};
		await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		const expectedOverlayRoot = join(root, ".interlinked", ".cov-overlay-stub");
		expect(seenOpts.projectRoot).toBe(expectedOverlayRoot);
		expect(seenOpts.coverageDir).toBe(`${expectedOverlayRoot}/.interlinked/coverage`);
	});

	it("calls overlay.cleanup() after the run completes", async () => {
		const p = plan([{ relPath: "src/a.ts", content: "", delete: true }]);
		let cleanupCalled = false;
		const { runner } = runnerFor("vitest", greenResult());
		await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true }),
			deps({
				runnerFor: () => runner,
				createOverlay: (projectRoot, editedRelPath) => ({
					overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
					editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
					cleanup: () => {
						cleanupCalled = true;
					},
				}),
			}),
			p,
			root,
		);
		expect(cleanupCalled).toBe(true);
	});

	it("degrades loudly (does not throw or hang) with the runner-absence reason preserved end to end", async () => {
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
});

// ---------------------------------------------------------------------------
// decideForDeletionOnly — budget/estimate arithmetic
// ---------------------------------------------------------------------------

describe("decideForDeletionOnly — budget/estimate arithmetic", () => {
	function gatedDeletePlan(): CoverageEditPlan {
		return plan([{ relPath: "src/a.ts", content: "", delete: true }]);
	}

	it("runs the suite in-band when the estimate is comfortably UNDER budget", async () => {
		updateRuntimeEstimateMs(root, 100);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: () => runner }),
			gatedDeletePlan(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("runs the suite on a NEVER-measured file even when budget_ms is 0 (null estimate always proceeds)", async () => {
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, budget_ms: 0 }),
			deps({ runnerFor: () => runner }),
			gatedDeletePlan(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("defers (does not run the suite) when the estimate is EXACTLY at the budget boundary", async () => {
		updateRuntimeEstimateMs(root, 25_000);
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForDeletionOnly(
			event(),
			cfg({ block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: () => runner }),
			gatedDeletePlan(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// decideForResidualLanguages — budget/estimate arithmetic + guards
// ---------------------------------------------------------------------------

describe("decideForResidualLanguages — budget/estimate arithmetic + guards", () => {
	function planWithTargetAndResidual(): CoverageEditPlan {
		return plan(
			[
				{ relPath: "src/a.ts", content: "export const a = 1;\n" },
				{ relPath: "src/b.py", content: "def f(): pass\n" },
			],
			{
				targets: [
					{ relPath: "src/a.ts", language: "ts", proposed: "export const a = 1;\n", editedLines: new Set([1]) },
				],
			},
		);
	}

	function pyOnlyRunnerFor(runner: CoverageRunner): CoverageWriteDeps["runnerFor"] {
		return (language) => (language === "python" ? runner : null);
	}

	it("runs the residual suite in-band when the estimate is comfortably UNDER budget", async () => {
		updateRuntimeEstimateMs(root, 100);
		const { runner, calls } = runnerFor("pytest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: pyOnlyRunnerFor(runner) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("runs the residual suite on a NEVER-measured file even when budget_ms is 0", async () => {
		const { runner, calls } = runnerFor("pytest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true, budget_ms: 0 }),
			deps({ runnerFor: pyOnlyRunnerFor(runner) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(1);
	});

	it("defers (does not run the residual suite) when the estimate is EXACTLY at the budget boundary", async () => {
		updateRuntimeEstimateMs(root, 25_000);
		const { runner, calls } = runnerFor("pytest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"], block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: pyOnlyRunnerFor(runner) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("is a no-op when block_on_test_failure is falsy, even with a residual RED language present", async () => {
		const { runner, calls } = runnerFor("pytest", redResult(["test_b"]));
		const result = await decideForResidualLanguages(
			event(),
			cfg({ languages: ["js", "ts", "python"] }), // block_on_test_failure omitted
			deps({ runnerFor: pyOnlyRunnerFor(runner) }),
			planWithTargetAndResidual(),
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});

	it("is a clean no-op (never throws) when there is no residual language, even with the budget exceeded", async () => {
		// Every gated section's runner already ran as a target — anchor is
		// genuinely absent, and the guard must short-circuit BEFORE touching the
		// budget/estimate machinery at all.
		updateRuntimeEstimateMs(root, 30_000);
		const p = plan([{ relPath: "src/a.ts", content: "export const a = 1;\n" }], {
			targets: [
				{ relPath: "src/a.ts", language: "ts", proposed: "export const a = 1;\n", editedLines: new Set([1]) },
			],
		});
		const { runner, calls } = runnerFor("vitest", greenResult());
		const result = await decideForResidualLanguages(
			event(),
			cfg({ block_on_test_failure: true, budget_ms: 25_000 }),
			deps({ runnerFor: () => runner }),
			p,
			root,
		);
		expect(result).toBeNull();
		expect(calls()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// blockForDeletionRedBar / blockForCrossSuiteRedBar — direct field checks
// ---------------------------------------------------------------------------

describe("blockForDeletionRedBar", () => {
	it("shows all 3 paths verbatim with NO ellipsis at the exact boundary (length === 3)", () => {
		const result = blockForDeletionRedBar(["a.ts", "b.ts", "c.ts"], ["t1"], undefined);
		expect(result.reason).toContain("deleting a.ts, b.ts, c.ts leaves the test suite RED");
		expect(result.reason).not.toContain("…");
	});
});

describe("blockForCrossSuiteRedBar", () => {
	it("carries every literal field exactly and shows all 3 paths with no ellipsis at the boundary", () => {
		const result = blockForCrossSuiteRedBar("ts", ["a.ts", "b.ts", "c.ts"], ["t1"]);
		expect(result.severity).toBe("medium");
		expect(result.rule_id).toBe("per-edit-coverage");
		expect(result.category).toBe("coverage");
		expect(result.reason).not.toContain("…");
		expect(result.reason).toContain(
			"targets are in a different ecosystem, so that suite would not otherwise run; fix the",
		);
		expect(result.reason).toContain("ts breakage in the SAME patch, then retry.");
	});
});
