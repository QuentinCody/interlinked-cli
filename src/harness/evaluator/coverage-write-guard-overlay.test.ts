// Unit tests for coverage-write-guard-overlay.ts — the overlay-run
// sub-decisions extracted out of `runOverlayAndDecide`.

import { describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageRunResult } from "../coverage-runner.js";
import type { HarnessEvent } from "../types.js";
import type { CoverageWriteDeps, GateContext } from "./coverage-write-guard.js";
import {
	buildOverlayRunOpts,
	checkRedBar,
	evaluateCrapGate,
	finalizeAllow,
	handleFailedOverlayRun,
	missingCoverageDegrade,
} from "./coverage-write-guard-overlay.js";

function baseCtx(overrides?: Partial<GateContext>): GateContext {
	return {
		projectRoot: "/repo",
		relPath: "src/a.ts",
		proposed: "export function a() { return 1; }\n",
		language: "ts",
		editedLines: undefined,
		budgetMs: 25_000,
		...overrides,
	};
}

function event(): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: "/repo/src/a.ts" },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: "/repo",
	};
}

function cov(): PerFileCoverage {
	// SAFETY: fixture stub — the extracted helpers under test only forward `cov`
	// verbatim into CrapInput, they never read its fields directly.
	return {
		coveredLines: new Set([1]),
		uncoveredLines: new Set(),
		totalLines: 1,
	} as unknown as PerFileCoverage;
}

// SAFETY: every `as CoverageRunResult` cast below is a fixture stub carrying
// only the fields the function under test actually reads (ok/suiteMs/error,
// or testsPassed/failingTests) — the full runner-result shape is irrelevant here.

// ---------------------------------------------------------------------------
// buildOverlayRunOpts — positive (must fire)
// ---------------------------------------------------------------------------
describe("buildOverlayRunOpts", () => {
	it("P1: sets selectedTests when the context carries a non-empty subset", () => {
		const opts = buildOverlayRunOpts(baseCtx({ selectedTests: ["src/a.test.ts"] }), "/repo/.cov");
		expect(opts.selectedTests).toEqual(["src/a.test.ts"]);
		expect(opts.projectRoot).toBe("/repo/.cov");
		expect(opts.coverageDir).toBe("/repo/.cov/.interlinked/coverage");
		expect(opts.timeoutMs).toBe(25_000);
	});

	it("N1: omits selectedTests when the context has none (full-suite route)", () => {
		const opts = buildOverlayRunOpts(baseCtx(), "/repo/.cov");
		expect(opts.selectedTests).toBeUndefined();
	});

	it("N2: omits selectedTests when the context's subset is empty", () => {
		const opts = buildOverlayRunOpts(baseCtx({ selectedTests: [] }), "/repo/.cov");
		expect(opts.selectedTests).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// handleFailedOverlayRun
// ---------------------------------------------------------------------------
describe("handleFailedOverlayRun", () => {
	it("P1: defers for budget when the run was killed at the per-edit timeout", () => {
		const ctx = baseCtx({ budgetMs: 1000 });
		const result = { ok: false, suiteMs: 1000, perFile: new Map(), testsPassed: null } as CoverageRunResult;
		const decision = handleFailedOverlayRun(ctx, event(), result);
		expect(decision).toBeNull();
	});

	it("N1: reports loud-runner-unavailable for a fast failure under budget", () => {
		const ctx = baseCtx({ budgetMs: 25_000 });
		const result = {
			ok: false,
			suiteMs: 50,
			perFile: new Map(),
			testsPassed: null,
			error: "spawn ENOENT",
		} as CoverageRunResult;
		const decision = handleFailedOverlayRun(ctx, event(), result);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toContain("spawn ENOENT");
	});
});

// ---------------------------------------------------------------------------
// checkRedBar
// ---------------------------------------------------------------------------
describe("checkRedBar", () => {
	it("P1: blocks when block_on_test_failure is on and the suite came back red", () => {
		const ctx = baseCtx({ blockOnTestFailure: true });
		const result = {
			ok: true,
			suiteMs: 10,
			perFile: new Map(),
			testsPassed: false,
			failingTests: ["a.test.ts > works"],
		} as CoverageRunResult;
		const decision = checkRedBar(ctx, result);
		expect(decision?.decision).toBe("block");
	});

	it("N1: falls through (null) when block_on_test_failure is off", () => {
		const ctx = baseCtx({ blockOnTestFailure: false });
		const result = { ok: true, suiteMs: 10, perFile: new Map(), testsPassed: false } as CoverageRunResult;
		expect(checkRedBar(ctx, result)).toBeNull();
	});

	it("N2: falls through (null) when testsPassed is true", () => {
		const ctx = baseCtx({ blockOnTestFailure: true });
		const result = { ok: true, suiteMs: 10, perFile: new Map(), testsPassed: true } as CoverageRunResult;
		expect(checkRedBar(ctx, result)).toBeNull();
	});

	it("N3: falls through (null) when testsPassed is null (undetermined, fail-open)", () => {
		const ctx = baseCtx({ blockOnTestFailure: true });
		const result = { ok: true, suiteMs: 10, perFile: new Map(), testsPassed: null } as CoverageRunResult;
		expect(checkRedBar(ctx, result)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// missingCoverageDegrade
// ---------------------------------------------------------------------------
describe("missingCoverageDegrade", () => {
	it("P1: returns an allow decision with a loud degrade warning naming the file", () => {
		const decision = missingCoverageDegrade("src/a.ts");
		expect(decision.decision).toBe("allow");
		expect(decision.warnings?.[0]).toContain("src/a.ts");
		expect(decision.warnings?.[0]).toContain("absent from coverage report");
	});
});

// ---------------------------------------------------------------------------
// evaluateCrapGate
// ---------------------------------------------------------------------------
describe("evaluateCrapGate", () => {
	function deps(analyzer: CoverageWriteDeps["cyclomaticFor"]): CoverageWriteDeps {
		return {
			runnerFor: () => null,
			createOverlay: (() => {
				throw new Error("unused");
			}) as unknown as CoverageWriteDeps["createOverlay"],
			clock: () => 0,
			cyclomaticFor: analyzer,
		};
	}

	it("P1: fail-open loud-degrades when block_on_crap is on but no analyzer exists", () => {
		const ctx = baseCtx({ blockOnCrap: true });
		const decision = evaluateCrapGate(ctx, deps(() => null), cov());
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.[0]).toContain("no cyclomatic analyzer for CRAP");
	});

	it("N1: skips entirely (null) when block_on_crap is off", () => {
		const ctx = baseCtx({ blockOnCrap: false });
		const decision = evaluateCrapGate(ctx, deps(() => null), cov());
		expect(decision).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// finalizeAllow
// ---------------------------------------------------------------------------
describe("finalizeAllow", () => {
	it("P1: stages the baseline via recordBaseline when covOut.now is set", () => {
		const staged: Array<{ relPath: string; fraction: number; scope?: string }> = [];
		const ctx = baseCtx({
			recordBaseline: (relPath, fraction, scope) => {
				staged.push(scope === undefined ? { relPath, fraction } : { relPath, fraction, scope });
			},
		});
		const decision = finalizeAllow(ctx, { now: 0.9 }, "full");
		expect(staged).toEqual([{ relPath: "src/a.ts", fraction: 0.9, scope: "full" }]);
		expect(decision).toBeNull();
	});

	it("N1: does not call recordBaseline when covOut.now is undefined", () => {
		let called = false;
		const ctx = baseCtx({ recordBaseline: () => { called = true; } });
		finalizeAllow(ctx, {}, "full");
		expect(called).toBe(false);
	});

	it("N2: returns null (silent allow) when there are no warnings to surface", () => {
		const ctx = baseCtx();
		expect(finalizeAllow(ctx, { now: 0.9 }, "full")).toBeNull();
	});
});
