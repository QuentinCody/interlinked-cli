import { describe, expect, it, vi } from "vitest";
import type { ProjectWideCheckConfig } from "../types.js";
import type { CheckReport } from "../check-engine/types.js";

const { mRunChecks, mRunChecksAsync } = vi.hoisted(() => ({
	mRunChecks: vi.fn(),
	mRunChecksAsync: vi.fn(),
}));

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: vi.fn(() => ({ runChecks: mRunChecks, runChecksAsync: mRunChecksAsync })),
}));

import { ProjectWideSweepState, runProjectWideChecks, runProjectWideChecksAsync } from "./project-wide.js";

/**
 * The sweep debouncer decides how often the expensive project-wide pass runs.
 * Getting it wrong is invisible in the worst direction: too rarely and the sweep
 * silently stops covering the tree, which reads exactly like "no findings".
 *
 * This file exists as the direct companion to `project-wide.ts` — the existing
 * coverage reaches it through the `quality-checks.js` barrel, so neither the
 * no-test-file check nor a cold reader could see that it was tested at all.
 *
 * The mocked engine stub exposes BOTH `runChecks` (sync) and `runChecksAsync`
 * (used by `runProjectWideChecksAsync`) so each variant can be driven
 * independently without mocking `project-wide.ts` itself.
 */
function config(over: Partial<ProjectWideCheckConfig> = {}): ProjectWideCheckConfig {
	// SAFETY: the debouncer reads only `edit_interval`; the cast supplies the rest
	// of the config shape without coupling these tests to unrelated fields.
	return { enabled: true, edit_interval: 3, tools: ["biome"], timeout_ms: 1000, ...over } as ProjectWideCheckConfig;
}

describe("ProjectWideSweepState — the sweep debouncer", () => {
	it("does not fire before the interval is reached", () => {
		const s = new ProjectWideSweepState();
		expect(s.recordEdit(config({ edit_interval: 3 }))).toBe(false);
		expect(s.recordEdit(config({ edit_interval: 3 }))).toBe(false);
	});

	it("fires exactly ON the configured interval", () => {
		const s = new ProjectWideSweepState();
		const cfg = config({ edit_interval: 3 });
		s.recordEdit(cfg);
		s.recordEdit(cfg);
		expect(s.recordEdit(cfg)).toBe(true);
	});

	it("keeps firing past the interval until it is reset", () => {
		// The counter is not self-clearing: a caller that forgets to reset must
		// still get sweeps rather than silently stopping.
		const s = new ProjectWideSweepState();
		const cfg = config({ edit_interval: 2 });
		s.recordEdit(cfg);
		expect(s.recordEdit(cfg)).toBe(true);
		expect(s.recordEdit(cfg)).toBe(true);
	});

	it("fires on every edit when the interval is 1", () => {
		const s = new ProjectWideSweepState();
		expect(s.recordEdit(config({ edit_interval: 1 }))).toBe(true);
	});

	it("records checked files so a project-wide sweep can dedup against per-file runs", () => {
		const s = new ProjectWideSweepState();
		s.recordFileChecked("src/a.ts");
		s.recordFileChecked("src/a.ts");
		expect(s.checkedFiles.has("src/a.ts")).toBe(true);
		expect(s.checkedFiles.size).toBe(1);
	});

	it("starts with no checked files and no reported findings", () => {
		const s = new ProjectWideSweepState();
		expect(s.checkedFiles.size).toBe(0);
		expect(s.reportedFindings.size).toBe(0);
		expect(s.editsSinceLastSweep).toBe(0);
	});

	it("does not treat a file as checked just because another was", () => {
		const s = new ProjectWideSweepState();
		s.recordFileChecked("src/a.ts");
		expect(s.checkedFiles.has("src/b.ts")).toBe(false);
	});
});

describe("runProjectWideChecks — unavailable tools", () => {
	it("reports a missing requested tool as deferred and retains the retry cadence", () => {
		const state = new ProjectWideSweepState();
		state.editsSinceLastSweep = 3;
		const report: CheckReport = {
			results: [],
			toolsRun: [{ id: "biome", available: false, reason: "not installed" }],
			toolsSkipped: [{ id: "biome", available: false, reason: "not installed" }],
			skipped: [{ check: "biome", reason: "not installed", category: "tool_missing" }],
			elapsedMs: 0,
			metrics: [],
			deduplicatedCount: 0,
		};
		mRunChecks.mockReturnValueOnce(report);

		const result = runProjectWideChecks(
			config({ tools: ["biome"], max_findings: 10, severity: "warning" }),
			state,
			"/repo",
		);

		expect(result.toolsRun).toEqual([]);
		expect(result.deferredReasons).toEqual(["biome: not installed"]);
		expect(result.findings).toEqual([]);
		expect(state.editsSinceLastSweep).toBe(3);
	});

	it("folds an unavailable-tool RESULT (not just a skip) into deferredToolIds and excludes it from toolsRun", () => {
		// Distinct from the skip-based case above: here the engine reports the
		// unavailable tool as a `tsc-unavailable` finding inside `results`, and
		// that finding must still suppress the tool from toolsRun and surface
		// in deferredReasons — the `unavailableResults` fold, not the `skipped` fold.
		const state = new ProjectWideSweepState();
		const report: CheckReport = {
			results: [
				{
					tool: "tsc",
					severity: "error",
					file: "n/a",
					line: 0,
					message: "tsc binary not found on PATH",
					ruleId: "tsc-unavailable",
				},
			],
			toolsRun: [{ id: "tsc", available: true }],
			toolsSkipped: [],
			skipped: [],
			elapsedMs: 4,
			metrics: [],
			deduplicatedCount: 0,
		};
		mRunChecks.mockReturnValueOnce(report);

		const result = runProjectWideChecks(
			config({ tools: ["tsc"], max_findings: 10, severity: "warning" }),
			state,
			"/repo",
		);

		expect(result.toolsRun).toEqual([]);
		expect(result.deferredReasons).toEqual(["tsc: tsc binary not found on PATH"]);
		expect(result.findings).toEqual([]);
	});
});

describe("runProjectWideChecksAsync — the non-blocking sweep variant", () => {
	it("delegates to the check-engine's async runner and returns a real finding formatted from its result", async () => {
		const state = new ProjectWideSweepState();
		const report: CheckReport = {
			results: [{ tool: "biome", severity: "warning", file: "src/a.ts", line: 3, message: "no-var" }],
			toolsRun: [{ id: "biome", available: true }],
			toolsSkipped: [],
			skipped: [],
			elapsedMs: 12,
			metrics: [],
			deduplicatedCount: 0,
		};
		mRunChecksAsync.mockResolvedValueOnce(report);

		const result = await runProjectWideChecksAsync(
			config({ tools: ["biome"], max_findings: 10, severity: "warning" }),
			state,
			"/repo",
		);

		expect(mRunChecksAsync).toHaveBeenCalledWith(
			{ projectRoot: "/repo", mode: "project" },
			{ tools: ["biome"], timeoutMs: 1000 },
		);
		expect(result.findings).toEqual([
			{
				name: "biome_project_wide",
				severity: "warning",
				message: "[cross-file] src/a.ts(3): no-var",
				file: "src/a.ts",
			},
		]);
		expect(result.toolsRun).toEqual(["biome"]);
	});
});


describe("project-wide deferred retries", () => {
    it.each(["resource_busy", "tool_missing", "timeout", "error"] as const)("keeps %s eligible for retry instead of reporting a clean sweep", (category) => {
        const state = new ProjectWideSweepState();
        state.editsSinceLastSweep = 3;
        const report: CheckReport = {
            results: [], toolsRun: [{ id: "biome", available: true }], toolsSkipped: [],
            skipped: [{ check: "biome", reason: "no verdict", category }], elapsedMs: 0, metrics: [], deduplicatedCount: 0,
        };
        mRunChecks.mockReturnValueOnce(report);
        const result = runProjectWideChecks(config(), state, "/repo");
        expect(result).toMatchObject({ toolsRun: [], findings: [], deferredReasons: ["biome: no verdict"] });
        expect(state.editsSinceLastSweep).toBe(3);
    });

    it("does not retry deliberately disabled checks", () => {
        const state = new ProjectWideSweepState();
        state.editsSinceLastSweep = 3;
        mRunChecks.mockReturnValueOnce({ results: [], toolsRun: [], toolsSkipped: [],
            skipped: [{ check: "biome", reason: "disabled", category: "config_disabled" }],
            elapsedMs: 0, metrics: [], deduplicatedCount: 0 } satisfies CheckReport);
        const result = runProjectWideChecks(config(), state, "/repo");
        expect(result.deferredReasons).toEqual([]);
        expect(state.editsSinceLastSweep).toBe(0);
    });
});
