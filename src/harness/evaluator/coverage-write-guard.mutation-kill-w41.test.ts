import { makeGuardRules } from "./__tests__/fixtures.js";
import { loadRules } from "../rules-loader.js";
import { nonNull } from "../../lib/non-null.js";
import type { JsonObject } from "../../lib/json-types.js";
// Mutation-kill suite for coverage-write-guard.ts (wave 41 survivors).
// Targets the specific StringLiteral/ConditionalExpression/EqualityOperator/
// LogicalOperator/BlockStatement/OptionalChaining/ArrayDeclaration/ObjectLiteral
// mutants listed in scratch/fleet-r3/w41-briefs/src_harness_evaluator_coverage-write-guard.ts.json
// that survived the existing coverage-write-guard.integration.test.ts suite.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process BEFORE importing anything that (transitively) uses it,
// so the real DEFAULT_DEPS runner path is exercised without spawning a real
// process — the mock throws synchronously, which coverage-runner.ts's runSuite
// catches and turns into a fast, deterministic `{ ok:false, error }` result.
vi.mock("node:child_process", () => ({
	spawn: () => {
		throw new Error("mocked-no-spawn");
	},
}));

import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	readFileCoverageBaseline,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import type { CoverageOverlay } from "../coverage-overlay.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { type CoverageWriteDeps, checkCoverageWrite } from "./coverage-write-guard.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-guard-w41-"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "cov-guard-w41-fixture", devDependencies: { vitest: "^3.0.0" } }),
		"utf-8",
	);
	resetRepoProfileCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	resetRepoProfileCache();
});

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		per_edit_coverage: { ...({ enabled: false, mode: "block", budget_ms: 25_000, languages: [] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>),
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			...overrides,
		},
		// SAFETY: GuardRulesConfig has many unrelated fields the gate never reads;
		// the object above satisfies the one field (`per_edit_coverage`) it consumes.
	} satisfies GuardRulesConfig);
}

function persistedCoverageRules(overrides: JsonObject): GuardRulesConfig {
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, ".interlinked", "guard-rules.local.json"),
		JSON.stringify({ per_edit_coverage: { ...rules().per_edit_coverage, ...overrides } }));
	return { ...rules(), per_edit_coverage: nonNull(loadRules(root).per_edit_coverage) };
}

function writeEvent(relPath: string, content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, relPath), content },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function applyPatch(...lines: string[]): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "apply_patch",
		tool_input: { command: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

function coverageResult(
	relPath: string,
	functions: PerFileCoverage["functions"],
	suiteMs = 1000,
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, { filePath: relPath, mtime: 0, functions });
	return { suiteMs, perFile, ok: true, testsPassed: true, ...overrides };
}

function stubOverlay(): CoverageWriteDeps["createOverlay"] {
	return (projectRoot, editedRelPath): CoverageOverlay => ({
		overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
		editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
		cleanup: () => {},
	});
}

function deps(runner: CoverageRunner, overlay?: CoverageWriteDeps["createOverlay"]): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: overlay ?? stubOverlay(),
		clock: () => 0,
		cyclomaticFor: () => () => [],
	};
}

describe("coverage-write-guard — DEFAULT_DEPS reaches the real runner factory (232d18ea, 56caa718)", () => {
	// test-contract: invariant — DEFAULT_DEPS.runnerFor must call the real
	// coverageRunnerFor(language) factory, which always returns a JsCoverageRunner
	// for ts/js (never undefined/null); a mutant that returns undefined instead
	// short-circuits to the "no runner" path without ever attempting a run.
	it("no deps arg: the real runnerFor/createOverlay/clock reach a real spawn attempt, not a stubbed-out object", async () => {
		const decision = await checkCoverageWrite(
			writeEvent("src/default-deps.ts", "export const a = 1;\n"),
			rules({ budget_ms: 5_000 }),
			// No third argument -> DEFAULT_DEPS.
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		// Real runnerFor() returns a JsCoverageRunner unconditionally for ts, so
		// run() reaches the (mocked) spawn and the failure text is the spawn
		// failure, never the "no runner" text a stubbed-out {} / undefined
		// runnerFor would short-circuit to.
		expect(warning).toMatch(/mocked-no-spawn/);
		expect(warning).not.toMatch(/no coverage runner for ts/);
		expect(warning).not.toMatch(/is not a function/);
	});
});

describe("coverage-write-guard — no-runner warning text + once-per-daemon dedup (a6d874dd)", () => {
	// test-contract: invariant — the raw `why` string built at the loudRunnerUnavailable
	// call site must survive verbatim into the composed warning, and
	// isRunnerAbsenceReason() classifies it as a stable runner-absence reason
	// (once-per-daemon dedup); an emptied StringLiteral fails that classification.
	it("names the exact reason text and dedups on the SECOND call for the same root+language", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const noRunnerDeps: CoverageWriteDeps = {
			runnerFor: () => null,
			createOverlay: stubOverlay(),
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const first = await checkCoverageWrite(writeEvent("src/a.ts", "export const a = 1;\n"), rules(), noRunnerDeps);
		expect(first?.decision).toBe("allow");
		const warning = (first?.warnings ?? []).join("\n");
		// The exact raw reason string must survive into the composed warning.
		expect(warning).toMatch(/\(no coverage runner for ts\)/);

		// Second call, SAME root + language: real code recognizes "no coverage
		// runner for ts" as a stable runner-absence reason and goes silent
		// (once-per-daemon) — the per-target `{decision:"allow"}` carries no
		// warnings, so the outer aggregator drops it to bare `null`. A
		// StringLiteral mutant that empties the raw string fails
		// `isRunnerAbsenceReason`, so it never dedups and keeps writing to
		// stderr on every call instead.
		errSpy.mockClear();
		const second = await checkCoverageWrite(writeEvent("src/b.ts", "export const b = 1;\n"), rules(), noRunnerDeps);
		expect(second).toBeNull();
		expect(errSpy).not.toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

describe("coverage-write-guard — coverageDir string built from overlayRoot (01998bffe)", () => {
	// test-contract: invariant — coverageDir is a template literal built from
	// `overlay.overlayRoot`; an emptied StringLiteral would point the runner at a
	// literal `.interlinked/coverage` (unrooted / wrong path).
	it("passes `${overlayRoot}/.interlinked/coverage` as coverageDir to the runner", async () => {
		let capturedCoverageDir: string | undefined;
		const overlayRoot = join(root, ".interlinked", ".cov-overlay-stub");
		const runner: CoverageRunner = {
			run: async (opts) => {
				capturedCoverageDir = opts.coverageDir;
				return coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
			},
		};
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
		);
		expect(capturedCoverageDir).toBe(`${overlayRoot}/.interlinked/coverage`);
	});
});

describe("coverage-write-guard — selectedTests key omitted on the full-suite route (b25d32535)", () => {
	// test-contract: invariant — `ctx.selectedTests && ctx.selectedTests.length > 0`
	// gates whether runOpts.selectedTests is assigned at all; forcing the whole
	// condition to `true` would assign `runOpts.selectedTests = undefined`
	// explicitly (key present, value undefined) instead of omitting the key.
	it("does NOT set a `selectedTests` key on runOpts at all when ctx.selectedTests is undefined", async () => {
		let sawSelectedTestsKey: boolean | undefined;
		const runner: CoverageRunner = {
			run: async (opts) => {
				sawSelectedTestsKey = Object.prototype.hasOwnProperty.call(opts, "selectedTests");
				return coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
			},
		};
		// No depView supplied -> full-suite route -> ctx.selectedTests is never set.
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
		);
		expect(sawSelectedTestsKey).toBe(false);
	});
});

describe("coverage-write-guard — over-budget equality at the FAST-failure boundary (bf2b746)", () => {
	// test-contract: boundary — `result.suiteMs >= ctx.budgetMs` must include the
	// exact-equality tie (a `>` mutant would misclassify it as a fast launch
	// failure and fail-open with a warning instead of deferring).
	it("suiteMs EXACTLY equal to budgetMs is treated as over-budget (defer), not a fast failure", async () => {
		const runner: CoverageRunner = {
			run: async () => ({
				suiteMs: 5_000, // exactly == budget_ms below
				perFile: new Map(),
				ok: false,
				error: "spawnSync ETIMEDOUT",
				testsPassed: null,
			}),
		};
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ budget_ms: 5_000 }),
			deps(runner),
		);
		// Deferred (obligation recorded, allow-null) — NOT the loud "could not run"
		// fast-failure warning a `>` mutant would produce for an exact tie.
		expect(decision).toBeNull();
		const text = errSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(text).not.toMatch(/could not run/);
		errSpy.mockRestore();
	});
});

describe("coverage-write-guard — fallback error text for a missing `error` string (b7d12f0b, ff9e28cce)", () => {
	// test-contract: invariant — `result.error ?? "coverage run failed"` must
	// supply the literal fallback text when `result.error` is nullish; an
	// emptied StringLiteral leaves the "(...)" segment blank.
	it("uses the literal 'coverage run failed' fallback when result.error is undefined", async () => {
		const runner: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, testsPassed: null }),
		};
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(runner),
		);
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/\(coverage run failed\)/);
		errSpy.mockRestore();
	});

	// test-contract: invariant — `??` must preserve a truthy `result.error`
	// verbatim; a `&&` mutant replaces any truthy error with the fallback text.
	it("uses the REAL error text (not the fallback) when result.error is a truthy string", async () => {
		const runner: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(runner),
		);
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/\(boom\)/);
		expect(warning).not.toMatch(/coverage run failed/);
		errSpy.mockRestore();
	});
});

describe("coverage-write-guard — CRAP-pass still stages the baseline (eb0f5e2b)", () => {
	// test-contract: invariant — `if (crapDecision) return crapDecision;` must
	// fall through (not return early) when crapDecision is null, reaching the
	// baseline-staging code below it; a forced-`true` mutant returns the null
	// early and skips ctx.recordBaseline() entirely.
	it("when block_on_crap is ON but the function is NOT crappy, the baseline is still persisted", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_crap: true }),
			{
				runnerFor: (): CoverageRunner => ({ run: async () => result }),
				createOverlay: stubOverlay(),
				clock: () => 0,
				cyclomaticFor: () => () => [{ name: "f", line: 1, endLine: 3, cyclomatic: 1, language: "js_ts" }],
			},
		);
		expect(decision).toBeNull();
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(1);
	});
});

describe("coverage-write-guard — scope re-anchor decision text + exact percentage (93ecc43bd, 6121541de)", () => {
	// test-contract: invariant — the "allow" StringLiteral on the re-anchor
	// decision must be exact, and `covOut.now ?? 0` must forward the real
	// (nonzero, non-100%) fraction into the message; a `&&` mutant collapses any
	// truthy fraction to 0 in the formatted percentage.
	it("re-anchors with decision 'allow' and the CORRECT (nonzero, non-100%) now-fraction in the warning", async () => {
		// Legacy scope-less 100% baseline; measured now = 50% (one covered fn, one
		// fully uncovered) -> re-anchor branch, covOut.now = 0.5 (truthy, nonzero).
		// A `covOut.now && 0` mutant collapses this to 0% in the message.
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		const result = coverageResult("src/a.ts", [
			{ name: "stillCovered", line: 1, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "offEditUncovered", line: 40, endLine: 42, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function stillCovered() { return 1; }\n"),
			rules(),
			deps(stubOverlayRunner(result)),
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join(" ");
		expect(warning).toMatch(/re-anchored at 50\.0%/);
	});
});

function stubOverlayRunner(result: CoverageRunResult): CoverageRunner {
	return { run: async () => result };
}

describe("coverage-write-guard — overlay.cleanup() always runs (54c8a930d)", () => {
	// test-contract: invariant — the `finally` block must call overlay.cleanup();
	// an emptied BlockStatement leaks the overlay directory on every run.
	it("calls overlay.cleanup() after a successful, clean-allow run", async () => {
		const cleanup = vi.fn();
		const overlay: CoverageWriteDeps["createOverlay"] = (projectRoot, editedRelPath) => ({
			overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
			editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
			cleanup,
		});
		const result = coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubOverlayRunner(result), overlay),
		);
		expect(decision).toBeNull();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});

describe("coverage-write-guard — deletion-only routing produces the DELETION wording, not the cross-suite wording (12b8153d5, 821a9055c)", () => {
	// A bypassed/always-false `plan.targets.length === 0` branch falls through
	// to the generic cross-suite red-bar wording instead of decideForDeletionOnly.
	// test-contract: invariant — the deletion-only branch must both take the `=== 0` condition and execute its body.
	it("a delete-only patch with a RED suite blocks with the deletion-specific reason text", async () => {
		const runner = stubOverlayRunner(
			coverageResult("src/other.ts", [], 1000, { testsPassed: false, failingTests: ["imports gone.ts"] }),
		);
		const ev = applyPatch("*** Delete File: src/gone.ts");
		const decision = await checkCoverageWrite(ev, rules({ block_on_test_failure: true }), deps(runner));
		expect(decision?.decision).toBe("block");
		// Unique to blockForDeletionRedBar — a residual-only (cross-suite) path
		// would instead say "leave the ts test suite RED", never this phrase.
		expect(decision?.reason).toMatch(/BLOCKED: deleting/);
		expect(decision?.reason).toMatch(/other code still depends on what this patch/i);
	});
});

describe("coverage-write-guard — warnings array does not start pre-seeded (e70c061b)", () => {
	// test-contract: invariant — `const warnings: string[] = [];` must start
	// empty; a pre-seeded ArrayDeclaration mutant makes `warnings.length > 0`
	// true even with nothing genuinely to report, turning a clean null allow
	// into a spurious allow-with-warnings.
	it("a clean covered edit with nothing to warn about returns bare null", async () => {
		const result = coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubOverlayRunner(result)),
		);
		expect(decision).toBeNull();
	});
});

describe("coverage-write-guard — residual-language warnings are actually merged in (84d5f3310)", () => {
	// test-contract: invariant — `if (residual?.warnings) warnings.push(...)` must forward the residual leg's warnings; a forced-false mutant drops them silently.
	it("merges BOTH the target's warning AND the residual language's warning (two distinct entries)", async () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.ts"), "export const a = 1;\n", "utf-8");
		const throwingDeps: CoverageWriteDeps = {
			runnerFor: () => stubOverlayRunner(coverageResult("pkg/other.py", [])),
			createOverlay: () => {
				throw new Error("mirror boom");
			},
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const ev = applyPatch(
			"*** Update File: src/m.ts",
			"@@",
			"-export const a = 1;",
			"+export const a = 2;",
			"*** Delete File: pkg/gone.py",
		);
		const decision = await checkCoverageWrite(
			ev,
			rules({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			throwingDeps,
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.length).toBe(2);
		const joined = (decision?.warnings ?? []).join("\n");
		expect(joined).toMatch(/degraded for src\/m\.ts/);
		expect(joined).toMatch(/degraded for pkg\/gone\.py/);
	});
});

describe("coverage-write-guard — budget gate reachable when no estimate is seeded yet (8056fe98)", () => {
	// test-contract: invariant — `estimate !== null && estimate >= cfg.budget_ms` must short-circuit on a null estimate; forcing the first conjunct `true` lets `null >= 0` defer instead.
	it("with budget_ms:0 and NO seeded estimate, the suite still RUNS (estimate===null short-circuits the gate)", async () => {
		let ran = false;
		const runner: CoverageRunner = {
			run: async () => {
				ran = true;
				return coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
			},
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ budget_ms: 0 }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran).toBe(true);
	});
});

describe("coverage-write-guard — budget-gate equality boundary (837285ef)", () => {
	// test-contract: boundary — `estimate >= cfg.budget_ms` must include the exact-equality tie; a `>` mutant lets a tied estimate run instead of deferring.
	it("estimate EXACTLY equal to budget_ms defers (>=), not just estimate > budget_ms", async () => {
		updateRuntimeEstimateMs(root, 25_000, () => 0);
		updateRuntimeEstimateMs(root, 25_000, () => 0); // settle exactly at 25_000
		let ran = false;
		const runner: CoverageRunner = {
			run: async () => {
				ran = true;
				return coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);
			},
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran).toBe(false); // deferred, never ran
	});
});

describe("coverage-write-guard — drop_epsilon override cluster (24cdb730, f9a919c, 2d619c1b, b57ae40b, 16015c8f, 6d897785)", () => {
	// test-contract: invariant — a valid numeric `drop_epsilon >= 0` must override the default COVERAGE_DROP_EPSILON; a mutant that skips the override always uses the tighter default.
	it("A: a valid positive drop_epsilon tolerates a real drop that the default epsilon would block", async () => {
		writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 90 }, // 10% drop
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ drop_epsilon: 0.5 }),
			deps(stubOverlayRunner(result)),
		);
		expect(decision).toBeNull();
	});

	// test-contract: boundary — `cfg.drop_epsilon >= 0` must reject a negative value; a forced-true mutant applies -1 as the tolerance and false-blocks a clean edit.
	it("B: an out-of-range NEGATIVE drop_epsilon is REJECTED (falls back to the default), not applied", async () => {
		writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }, // NO drop
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ drop_epsilon: -1 }),
			deps(stubOverlayRunner(result)),
		);
		// No real drop -> allowed under the real (rejected-negative) default epsilon.
		// A mutant that force-applies -1 as the tolerance would BLOCK here (any
		// coverage reads as "way below" a negative-shrunk floor).
		expect(decision).toBeNull();
	});

	// test-contract: invariant — `typeof cfg.drop_epsilon === "number"` must reject a non-number even if it coerces `>= 0`; `||`/forced-true/`!==`/empty-string mutants would accept it.
	it("C: a NON-NUMBER drop_epsilon (typeof check) is REJECTED even though it coerces >= 0", async () => {
		writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 90 }, // 10% drop
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			persistedCoverageRules({ drop_epsilon: "0.5" }),
			deps(stubOverlayRunner(result)),
		);
		// typeof "0.5" !== "number" -> override rejected -> default epsilon (0.005)
		// -> the 10% drop BLOCKS. A `||` / forced-true-first-conjunct mutant
		// would instead accept "0.5" (it coerces >= 0) and ALLOW.
		expect(decision?.decision).toBe("block");
	});
});
