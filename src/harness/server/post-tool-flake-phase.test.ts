import type { ServerRuntime } from "./runtime-context.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeGuardRules } from "../evaluator/__tests__/fixtures.js";
import { getDefaultConfig } from "../rules-loader.js";
import { nonNull } from "../../lib/non-null.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverageRunResult } from "../coverage-runner.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

// Mock the heavy seams (real suite run + graph build). Keep the pure path
// helpers (coverageLanguageForPath, isTestPath) real via importActual.
const fakeRun = vi.fn();
vi.mock("../coverage-runner.js", async (importActual) => {
	const actual = await importActual<typeof import("../coverage-runner.js")>();
	return { ...actual, coverageRunnerFor: () => ({ run: fakeRun }) };
});
vi.mock("./runtime-context.js", () => ({ getGraphForFile: () => ({}) }));
// Routed through a spy (not a bare arrow) so one case can make the dependency
// view blow up — the "graph unavailable" fall-through inside scopedTestsFor.
const fakeResolveDependencyView = vi.fn((): unknown => undefined);
vi.mock("../dependency-view.js", () => ({
	resolveDependencyView: () => fakeResolveDependencyView(),
}));
vi.mock("../coverage-test-selector.js", async (importActual) => {
	const actual = await importActual<typeof import("../coverage-test-selector.js")>();
	return { ...actual, selectAffectedTests: () => null }; // → defaults to the edited test
});

import { appendFlakeCheckWarning } from "./post-tool-flake-phase.js";

function result(over: Partial<CoverageRunResult>): CoverageRunResult {
	return { ok: true, suiteMs: 50, perFile: new Map(), testsPassed: true, ...over };
}

function ctxWith(flakeCheck: boolean | undefined): ServerRuntime {
 const rules = makeGuardRules();
 rules.per_edit_coverage = { ...nonNull(getDefaultConfig().per_edit_coverage), budget_ms: 5000, ...(flakeCheck === undefined ? {} : { flake_check: flakeCheck }) };
 return makeServerRuntime({ cwd: "/repo", rules });
}

function editEvent(file: string): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: `/repo/${file}` },
		cwd: "/repo",
		timestamp: "t",
	};
}

afterEach(() => {
	fakeRun.mockReset();
});

describe("appendFlakeCheckWarning", () => {
	it("is a no-op when flake_check is off (default) — never runs a suite", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendFlakeCheckWarning(ctxWith(undefined), editEvent("src/foo.test.ts"), decision);
		expect(fakeRun).not.toHaveBeenCalled();
		expect(decision.warnings).toBeUndefined();
	});

	it("is a no-op for a non-test file edit even when on", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		await appendFlakeCheckWarning(ctxWith(true), editEvent("src/foo.ts"), decision);
		expect(fakeRun).not.toHaveBeenCalled();
		expect(decision.warnings).toBeUndefined();
	});

	it("is a no-op for a non-write event", async () => {
		const decision: HarnessDecision = { decision: "allow" };
		const readEvent: HarnessEvent = { ...editEvent("src/foo.test.ts"), tool_name: "Read" };
		await appendFlakeCheckWarning(ctxWith(true), readEvent, decision);
		expect(fakeRun).not.toHaveBeenCalled();
	});

	it("runs the suite twice and appends a flake warning on divergence", async () => {
		fakeRun
			.mockResolvedValueOnce(result({ testsPassed: true }))
			.mockResolvedValueOnce(result({ testsPassed: false, failingTestFiles: ["src/foo.test.ts"] }));
		const decision: HarnessDecision = { decision: "allow", warnings: ["existing"] };
		await appendFlakeCheckWarning(ctxWith(true), editEvent("src/foo.test.ts"), decision);
		expect(fakeRun).toHaveBeenCalledTimes(2);
		expect(decision.warnings).toEqual(["existing", expect.stringContaining("[interlinked:flake]")]);
	});

	it("adds no warning when the two runs agree", async () => {
		fakeRun.mockResolvedValue(result({ testsPassed: true }));
		const decision: HarnessDecision = { decision: "allow" };
		await appendFlakeCheckWarning(ctxWith(true), editEvent("src/foo.test.ts"), decision);
		expect(fakeRun).toHaveBeenCalledTimes(2);
		expect(decision.warnings).toBeUndefined();
	});

	it("double-runs the edited test alone when dependency-graph selection throws", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "flake-phase-nograph-"));
		try {
			fakeResolveDependencyView.mockImplementationOnce(() => {
				throw new Error("project graph unavailable");
			});
			fakeRun.mockResolvedValue(result({ testsPassed: true }));
			const decision: HarnessDecision = { decision: "allow" };
			const ctx = makeServerRuntime({ ...ctxWith(true), cwd });
			const event: HarnessEvent = {
				...editEvent("src/foo.test.ts"),
				cwd,
				tool_input: { file_path: join(cwd, "src/foo.test.ts") },
			};
			await appendFlakeCheckWarning(ctx, event, decision);
			expect(fakeRun).toHaveBeenCalledTimes(2);
			expect(fakeRun.mock.calls[0]?.[0]?.selectedTests).toEqual(["src/foo.test.ts"]);
			expect(decision.warnings).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("escalates via the flake calibrator once flakiness is statistically elevated", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "flake-phase-"));
		try {
			const ctx = makeServerRuntime({ ...ctxWith(true), cwd });
			let last: HarnessDecision = { decision: "allow" };
			// Three consecutive divergences cross the e-process alarm (1/α).
			for (let i = 0; i < 3; i++) {
				fakeRun
					.mockResolvedValueOnce(result({ testsPassed: true }))
					.mockResolvedValueOnce(
						result({ testsPassed: false, failingTestFiles: ["src/foo.test.ts"] }),
					);
				last = { decision: "allow" };
				await appendFlakeCheckWarning(ctx, editEvent("src/foo.test.ts"), last);
			}
			expect(last.warnings?.some((w) => w.includes("[interlinked:flake-calibrator]"))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
