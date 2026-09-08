import { isJsonObject } from "../../lib/json-types.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	readFileCoverageBaseline,
	readRuntimeEstimateMs,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import type { CoverageOverlay } from "../coverage-overlay.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import type { BlastRadius, CallerSite, DependencyView } from "../dependency-view.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import {
	type CoverageWriteDeps,
	checkCoverageWrite,
} from "./coverage-write-guard.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-guard-"));
	// The gate is repo-profile-aware (2026-07-06): without a detectable runner
	// it skips with a once-per-session notice instead of running the overlay.
	// These fixtures inject stub runners via deps, so declare vitest in the
	// fixture manifest to keep the profile's runner check satisfied — and reset
	// the per-root memo both ways so no cross-suite cache leaks.
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "cov-guard-fixture", devDependencies: { vitest: "^3.0.0" } }),
		"utf-8",
	);
	writeFileSync(join(root, "pytest.ini"), "[pytest]\n", "utf-8");
	resetRepoProfileCache();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	resetRepoProfileCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return ({ ...makeGuardRules(),
		per_edit_coverage: { ...({ enabled: false, mode: "block", budget_ms: 25_000, languages: [] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>),
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			...overrides,
		},
	} satisfies GuardRulesConfig);
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

/** A coverage result for the edited file with the given function rows. Defaults
 *  to a GREEN suite (`testsPassed: true`) so the coverage-decision tests are
 *  unaffected by the red-bar gate; red-bar tests pass an explicit override. */
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

/**
 * A coverage result carrying PER-LINE data (the coverage.py / Python shape):
 * empty `functions`, populated `coveredLines` / `uncoveredLines`. The gate
 * prefers the per-line fields whenever they are present.
 */
function pyCoverageResult(
	relPath: string,
	covered: number[],
	uncovered: number[],
	suiteMs = 1000,
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, {
		filePath: relPath,
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	});
	return { suiteMs, perFile, ok: true, testsPassed: true, ...overrides };
}

/** A stub runner that records whether it ran and returns a fixed result. */
function stubRunner(result: CoverageRunResult): { runner: CoverageRunner; ran: () => boolean } {
	let called = false;
	const runner: CoverageRunner = {
		run: async () => {
			called = true;
			return result;
		},
	};
	return { runner, ran: () => called };
}

/** A stub overlay factory — never touches the real tree. */
function stubOverlay(): CoverageWriteDeps["createOverlay"] {
	return (projectRoot, editedRelPath): CoverageOverlay => ({
		overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
		editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
		cleanup: () => {},
	});
}

function deps(runner: CoverageRunner): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: stubOverlay(),
		clock: () => 0,
		// CRAP is OFF in these tests (block_on_crap unset) so the analyzer is never
		// called; default to "no functions" so it can never block by accident.
		cyclomaticFor: () => () => [],
	};
}

/**
 * Deps with an injected cyclomatic analyzer for the CRAP tests. The analyzer is a
 * pure stub returning fixed per-function complexity entries — no TS load, no
 * radon spawn. `null` entries model an UNAVAILABLE analyzer (typescript/radon
 * absent), which the CRAP gate fail-opens on.
 */
function depsWithCyclomatic(
	runner: CoverageRunner,
	entries: FunctionComplexityEntry[] | null,
): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: stubOverlay(),
		clock: () => 0,
		cyclomaticFor: () => () => entries,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — gating", () => {
	it("is a pure no-op when disabled (runner never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ enabled: false }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op when per_edit_coverage config is entirely absent", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			({ ...makeGuardRules(), } satisfies GuardRulesConfig),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op in warn mode (runner never called — warn gate is inert today)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ mode: "warn" }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for a non-code / unsupported-language file (.md)", async () => {
		const { runner, ran } = stubRunner(coverageResult("README.md", []));
		const decision = await checkCoverageWrite(
			writeEvent("README.md", "# hi\n"),
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for a test file (test files are not the unit under coverage)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.test.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.test.ts", "it('x', () => {});\n"),
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — block / allow decisions", () => {
	it("BLOCKS when the edit adds an uncovered executable line, naming the line", async () => {
		// The edited function overlaps the added lines and is fully uncovered.
		const result = coverageResult("src/a.ts", [
			{ name: "added", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/line \d+/i);
	});

	it("ALLOWS when the edited line is covered (stub reports it covered)", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "added", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ALLOWS when coverage is unchanged (no edited function uncovered, no drop)", async () => {
		// Pre-seed a baseline equal to what the overlay will report → no drop. No
		// depView ⇒ the run is full-suite ⇒ scope "full"; seed the same scope so the
		// drop ratchet compares like-with-like (a scope-less seed would re-anchor).
		writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("BLOCKS on a per-file coverage drop vs the prior baseline (even off the edited lines)", async () => {
		// Baseline was fully covered UNDER THE SAME SCOPE; overlay reports a covered
		// function that does not overlap the edit, plus an uncovered one elsewhere →
		// fraction drops within-scope → block.
		writeFileCoverageBaseline(root, "src/a.ts", 1, "full");
		const result = coverageResult("src/a.ts", [
			{ name: "stillCovered", line: 1, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "nowUncovered", line: 40, endLine: 42, hits: 0, statement_pct: 0 },
		]);
		// Edit touches only line 1 (covered) — so the BLOCK must come from the drop,
		// not the added-line check.
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function stillCovered() { return 1; }\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/drop|decreas/i);
	});

	it("RE-ANCHORS (allow + warning) when the prior baseline was earned under a different scope", async () => {
		// A legacy scope-less 100% baseline (the 59-landmines shape): a narrower
		// scope reading 66% must NOT block — it re-anchors and warns. This is the
		// bio staging/utils.ts fix, end-to-end through checkCoverageWrite.
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		const result = coverageResult("src/a.ts", [
			{ name: "stillCovered", line: 1, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "offEditUncovered", line: 40, endLine: 42, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function stillCovered() { return 1; }\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("allow");
		expect(decision?.warnings?.join(" ")).toMatch(/re-anchored/);
	});

	it("refreshes the per-file baseline after an allowed edit", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(1);
	});
});

describe("default config — all gates are ON (enforce by default unless opted out)", () => {
	it("DEFAULT_CONFIG.per_edit_coverage.block_on_test_failure is true", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.block_on_test_failure).toBe(true);
	});

	it("DEFAULT_CONFIG.per_edit_coverage.block_on_crap is true (CRAP gate ON by default)", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.block_on_crap).toBe(true);
	});

	it("DEFAULT_CONFIG.per_edit_coverage.crap_threshold defaults to 30", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.crap_threshold).toBe(30);
	});

	it("the whole coverage feature is ON by default (enabled === true)", () => {
		// Enforced on every repo out of the box; opt out in guard-rules.local.json.
		expect(DEFAULT_CONFIG.per_edit_coverage?.enabled).toBe(true);
	});

	it("running the guard with the SHIPPED default config DOES run the gate (runner called)", async () => {
		// With the default flipped ON, the shipped config no longer short-circuits:
		// the overlay runner actually runs. The single function is covered + the
		// suite is green, so the decision is still allow — but the runner DID run,
		// which is the observable difference from the old default-OFF behavior.
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			DEFAULT_CONFIG,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(true);
	});

	it("OPT-OUT: shipped default with enabled:false is a pure no-op (runner never called)", async () => {
		// Proves opt-out still gives ZERO behavior change: clone the shipped config
		// and flip just `enabled` off — the guard short-circuits before any runner,
		// even with a red suite that the default-ON gates would otherwise block on.
		const optedOut: GuardRulesConfig = ({ ...makeGuardRules(),
			...DEFAULT_CONFIG,
			per_edit_coverage: { ...({ enabled: false, mode: "block", budget_ms: 25_000, languages: [] } satisfies NonNullable<GuardRulesConfig["per_edit_coverage"]>),  ...DEFAULT_CONFIG.per_edit_coverage, enabled: false },
		} satisfies GuardRulesConfig);
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [], 1000, { testsPassed: false }),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			optedOut,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — red-bar (block_on_test_failure)", () => {
	const GREEN_COVERED = (relPath: string): CoverageRunResult =>
		coverageResult(relPath, [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);

	it("OFF (sub-flag unset): a RED suite does NOT block — fail-open, coverage-only behavior", async () => {
		// testsPassed:false but block_on_test_failure unset in the passed config →
		// the red bar is inert (the gate logic treats an unset sub-flag as opt-out,
		// independent of the shipped default). The single function is covered, so the
		// coverage path also allows → null.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false, failingTests: ["t > boom"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(), // block_on_test_failure not set
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("OFF (explicit false): identical to unset — RED does not block", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: false }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + testsPassed:false → BLOCKS, naming the failing test", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false, failingTests: ["adds two numbers", "handles empty input"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/adds two numbers/);
	});

	it("ON + testsPassed:false with NO failingTests → still BLOCKS with a generic phrase", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/one or more tests are failing/);
	});

	it("ON + testsPassed:true + covered → ALLOWS (green, no coverage gap)", async () => {
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(GREEN_COVERED("src/a.ts")).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + testsPassed:true + UNCOVERED added line → coverage still BLOCKS (red bar doesn't mask it)", async () => {
		// Green suite, but the edited function is uncovered → the coverage block
		// fires. Proves the red-bar check doesn't swallow the coverage decision.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "added", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			1000,
			{ testsPassed: true },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		// The coverage (not red-bar) reason: it names the uncovered line, not "RED".
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).not.toMatch(/RED/);
	});

	it("ON + testsPassed:null (runner unavailable / indeterminate) → fail-open (no red-bar block)", async () => {
		// testsPassed null on an ok report with a covered function → the red bar
		// abstains (fail-open on pass/fail) and the coverage path allows.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: null },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + a FAILED coverage run (ok:false) → fail-loud ALLOW with the warning, never a red-bar block", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ block_on_test_failure: true }),
			deps(failing),
		);
		// Allowed (a red bar fires only from a clean red run), but not silently.
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/could not run/);
		expect(decision?.reason).toBeUndefined(); // not a red-bar block
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("ON but per_edit_coverage disabled → pure no-op (runner never called, no red-bar)", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [], 1000, { testsPassed: false }),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ enabled: false, block_on_test_failure: true }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("ON + Python red suite → BLOCKS on the red bar (per-line shape, testsPassed:false)", async () => {
		const PY_SRC = "def added():\n    return 1\n";
		const result = pyCoverageResult("src/a.py", [1, 2], [], 1000, {
			testsPassed: false,
			failingTests: ["tests/test_a.py::test_added"],
		});
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/test_added/);
	});
});

describe("checkCoverageWrite — Python per-line path (coverage.py shape)", () => {
	// Python content: 5 lines so the Write's edited-line set is {1..5}.
	const PY_SRC = "def added():\n    x = 1\n    y = 2\n    z = 3\n    return x + y + z\n";

	it("BLOCKS when an added .py line is uncovered (missing_lines), naming the line", async () => {
		// Line 4 is executable but missing → uncovered on an edited line.
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 5], [4]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/line 4/);
	});

	it("ALLOWS when every executable .py line is covered (zero uncovered lines)", async () => {
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 4, 5], []);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("BLOCKS on a per-file coverage drop vs the prior baseline (uncovered off the edited lines)", async () => {
		// Baseline fully covered UNDER THE SAME SCOPE; overlay reports an uncovered
		// line (40) OUTSIDE the edited set {1..5}, so the added-line check passes and
		// the BLOCK is the within-scope drop.
		writeFileCoverageBaseline(root, "src/a.py", 1, "full");
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 4, 5], [40]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/drop|decreas/i);
	});

	it("is a no-op when python is not in the configured languages (runner never called)", async () => {
		const { runner, ran } = stubRunner(pyCoverageResult("src/a.py", [1], []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules(), // default languages: js, ts — no python
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — CRAP block (block_on_crap)", () => {
	// A function the cyclomatic analyzer reports for the edited file. Helper keeps
	// the per-language entry construction terse.
	function fn(
		name: string,
		line: number,
		endLine: number,
		cyclomatic: number,
		language: FunctionComplexityEntry["language"] = "js_ts",
	): FunctionComplexityEntry {
		return { name, line, endLine, cyclomatic, language };
	}

	// JS source whose single function spans lines 1..3 (Write ⇒ all lines edited
	// ⇒ the function is TOUCHED). The coverage stub controls its statement_pct.
	const JS_SRC = "export function big() {\n  return 1;\n}\n";

	it("ON + added function complex AND under-covered (CRAP ≥ 30) → BLOCKS, naming the function + CRAP", async () => {
		// cyclomatic 10 @ 20% coverage → CRAP = 100·(0.8)³ + 10 ≈ 61.2 (≥30). The
		// function is partially covered (hits>0, statement_pct>0) so the COVERAGE
		// gate allows and the CRAP gate is what fires.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/cyclomatic 10/);
		expect(decision?.reason).toMatch(/coverage 20%/);
		expect(decision?.reason).toMatch(/reduce complexity|add coverage/i);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("a CRAP block does NOT persist the coverage baseline (finding 8)", async () => {
		// Coverage passes (the function is partially covered), CRAP blocks. The baseline
		// must NOT be written — otherwise a corrected retry reads as a coverage DROP
		// against content that never landed.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block"); // CRAP blocked
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBeNull(); // baseline NOT poisoned
	});

	it("ON + the SAME function fully covered (CRAP ≈ cyclomatic < 30) → ALLOWS", async () => {
		// cyclomatic 10 @ 100% coverage → CRAP = 10 (< 30). Complexity alone, with
		// full coverage, is not a CRAP block.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("OFF (sub-flag unset) → no CRAP block even for a complex, under-covered function", async () => {
		// Same CRAPpy shape as the blocking case, but block_on_crap unset in the
		// passed config → the CRAP gate is inert (the gate logic treats an unset
		// sub-flag as opt-out, independent of the shipped default). The function is
		// partially covered so coverage allows → null.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const { runner } = stubRunner(result);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules(), // block_on_crap not set
			depsWithCyclomatic(runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("OFF (explicit false) → identical to unset (no CRAP block)", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: false }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("ON but the CRAPpy function is UNTOUCHED by the edit → no CRAP block", async () => {
		// Edit touches only line 2 (`b = 2`), but the CRAPpy function lives at lines
		// 40..60 — outside the edited set, so crapTouches() excludes it. A covered
		// function at the edited lines keeps the coverage gate happy.
		const base = "const a = 1;\nconst b = 1;\nconst c = 1;\n";
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/u.ts"), base, "utf-8");
		const result = coverageResult("src/u.ts", [
			{ name: "edited", line: 2, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "faraway", line: 40, endLine: 60, hits: 1, statement_pct: 10 },
		]);
		const editEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: {
				file_path: join(root, "src/u.ts"),
				old_string: "const b = 1;",
				new_string: "const b = 2;",
			},
			timestamp: "2026-06-07T00:00:00.000Z",
			cwd: root,
		};
		const decision = await checkCoverageWrite(
			editEvent,
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [
				fn("edited", 2, 2, 1),
				fn("faraway", 40, 60, 12), // complex + 10% covered → high CRAP, but untouched
			]),
		);
		expect(decision).toBeNull();
	});

	it("ON + Python function path → BLOCKS on per-line CRAP (radon ranges ∩ coverage.py lines)", async () => {
		// Base .py on disk; an Edit touches only line 3 (covered). The function spans
		// lines 1..6; covered={3}, uncovered={4,5,6} ⇒ per-function coverage 25%.
		// cyclomatic 10 @ 25% → CRAP = 100·(0.75)³ + 10 ≈ 52.2 (≥30). The uncovered
		// lines are OUTSIDE the edited set {3}, so the coverage gate allows and CRAP
		// is what fires.
		const pyBase =
			"def big():\n    a = 1\n    b = a + 1\n    c = b + 2\n    d = c + 3\n    return d\n";
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/p.py"), pyBase, "utf-8");
		const result = pyCoverageResult("src/p.py", [3], [4, 5, 6]);
		const editEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: {
				file_path: join(root, "src/p.py"),
				old_string: "    b = a + 1",
				new_string: "    b = a + 1",
			},
			timestamp: "2026-06-07T00:00:00.000Z",
			cwd: root,
		};
		const decision = await checkCoverageWrite(
			editEvent,
			rules({ languages: ["js", "ts", "python"], block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 6, 10, "python")]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 52/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/coverage 25%/);
	});

	it("ON + cyclomatic analyzer UNAVAILABLE (null) → fail-open ALLOW with the warning, no CRAP block", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Covered function ⇒ coverage gate allows; analyzer returns null (typescript/
		// radon absent) ⇒ CRAP fail-opens with an agent-visible warning (not a block).
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, null),
		);
		// Fail-open is ALLOW, but it is no longer silent: the warning is carried.
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(decision?.reason).toBeUndefined(); // not a block
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("ON + runner unavailable (ok:false) → fail-open ALLOW with the warning, never a CRAP block", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(failing, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/could not run/);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("custom crap_threshold raises the bar: a CRAP-61 function passes a threshold of 100", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true, crap_threshold: 100 }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});
});

describe("checkCoverageWrite — block ordering (red bar → coverage → CRAP)", () => {
	const JS_SRC = "export function big() {\n  return 1;\n}\n";

	it("a RED suite blocks FIRST — before coverage and CRAP", async () => {
		// Red suite + an uncovered+CRAPpy function: the RED-bar block wins.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			1000,
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});

	it("coverage blocks SECOND — an uncovered added line wins over CRAP", async () => {
		// Green suite, fully-uncovered function (statement_pct 0): the COVERAGE
		// uncovered-added-line block fires before CRAP would.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});

	it("CRAP blocks LAST — green suite, coverage passes, but a touched function is CRAPpy", async () => {
		// Green + partially-covered (so coverage allows) + complex ⇒ only CRAP fires.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 }],
			1000,
			{ testsPassed: true },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP/);
		expect(decision?.reason).not.toMatch(/RED/);
	});

	// Shared with the CRAP describe — duplicated locally to keep the block self-contained.
	function fn(
		name: string,
		line: number,
		endLine: number,
		cyclomatic: number,
		language: FunctionComplexityEntry["language"] = "js_ts",
	): FunctionComplexityEntry {
		return { name, line, endLine, cyclomatic, language };
	}
});

describe("checkCoverageWrite — budget gate", () => {
	it("does NOT run the suite when the estimate >= budget; records an obligation and allows", async () => {
		// Seed a rolling estimate above the budget so the gate defers.
		writeRuntimeEstimateAbove(root, 30_000);
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		// An obligation row was appended.
		const lines = readObligations(root);
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatchObject({ kind: "coverage", reason: "budget_exceeded", file: "src/a.ts" });
	});

	it("over-budget scoped run (timed out: ok:false, suiteMs >= budget) records an obligation and allows", async () => {
		// A run that burns the whole per-edit budget without a report is a timeout
		// kill (the spawn is bounded at budget_ms), NOT a missing provider. Wide-fan-in
		// scoped case: the affected set is correct but too slow to run in-band, so it
		// must DEFER (commit-time obligation) rather than fail open.
		const wide = join(root, "src/wide.ts");
		const view = stubDepView({ [wide]: [join(root, "src/wide.test.ts")] }, new Set<string>([wide]));
		const { runner } = stubRunner({
			suiteMs: 26_000, // > budget_ms (25s): the over-budget / timeout signal
			perFile: new Map(),
			ok: false,
			error: "suite did not run: spawnSync ETIMEDOUT",
			testsPassed: null,
		});
		const decision = await checkCoverageWrite(
			writeEvent("src/wide.ts", "export const x = 1;\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
			view,
		);
		expect(decision).toBeNull(); // allowed (deferred), not a loud-degrade or block
		const lines = readObligations(root);
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatchObject({ kind: "coverage", reason: "budget_exceeded", file: "src/wide.ts" });
	});

	it("FAST failure (ok:false, suiteMs under budget) still fails loud - allow-with-warning, NO obligation", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const wide = join(root, "src/wide.ts");
		const view = stubDepView({ [wide]: [join(root, "src/wide.test.ts")] }, new Set<string>([wide]));
		const { runner } = stubRunner({
			suiteMs: 10, // a quick launch/parse failure, well under budget
			perFile: new Map(),
			ok: false,
			error: "boom",
			testsPassed: null,
		});
		const decision = await checkCoverageWrite(
			writeEvent("src/wide.ts", "export const x = 1;\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
			view,
		);
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/could not run/);
		expect(readObligations(root).length).toBe(0);
		errSpy.mockRestore();
	});

	it("runs the suite and updates the estimate when under budget", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }], 1500),
		);
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
		);
		expect(ran()).toBe(true);
		expect(readRuntimeEstimateMs(root)).toBe(1500);
	});

	it("caps the per-edit run at budget_ms, not the 120s suite default", async () => {
		let capturedTimeout: number | undefined;
		const runner: CoverageRunner = {
			run: async (opts) => {
				capturedTimeout = opts.timeoutMs;
				return coverageResult("src/a.ts", [
					{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
				]);
			},
		};
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
		);
		expect(capturedTimeout).toBe(25_000);
	});

	it("does NOT seed the budget estimate from a scoped run (only full-suite cost counts)", async () => {
		// A scoped run is fast by construction; folding its runtime into the rolling
		// estimate erodes it below budget and re-opens the full-suite-timeout loop.
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/m.test.ts")],
		});
		const { runner } = stubRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }], 1234),
		);
		await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(readRuntimeEstimateMs(root)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Affected-test selection — the keystone: scope the overlay run to only the
// tests that transitively import the edited file (fast → fits the budget →
// enforces in-band). depView is stubbed; no real ProjectGraph.
// ---------------------------------------------------------------------------

/** A stub DependencyView: explicit absolute-path reverse edges + membership. */
function stubDepView(edges: Record<string, string[]>, known?: Set<string>): DependencyView {
	const membership = known ?? new Set<string>([...Object.keys(edges), ...Object.values(edges).flat()]);
	return {
		source: "internal",
		answerScope: "repo",
		getDependents: (f: string): string[] => edges[f] ?? [],
		hasFile: (f: string): boolean => membership.has(f),
		classifyModule: () => "internal",
		getBlastRadius: (): BlastRadius => ({ direct: 0, transitive: 0, domains: [] }),
		getCallers: (): CallerSite[] => [],
	};
}

/** A runner that records the `selectedTests` it was handed (or undefined). */
function capturingRunner(result: CoverageRunResult): {
	runner: CoverageRunner;
	selected: () => string[] | undefined;
} {
	let captured: string[] | undefined;
	const runner: CoverageRunner = {
		run: async (opts) => {
			captured = opts.selectedTests;
			return result;
		},
	};
	return { runner, selected: () => captured };
}

describe("checkCoverageWrite — affected-test selection (scoped per-edit run)", () => {
	it("passes ONLY the selected affected tests to the runner", async () => {
		// m.ts ← m.test.ts + integration.test.ts → both selected and forwarded.
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/m.test.ts"), join(root, "tests/integration.test.ts")],
		});
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(decision).toBeNull();
		expect(selected()).toEqual(["src/m.test.ts", "tests/integration.test.ts"]);
	});

	// EVIDENCE-AUTHORITY CONTRACT (finding 2): an empty affected-test selection
	// (`[]`) means only that no test STATICALLY imports the file — not that it is
	// uncovered. The graph may select tests but its silence may never prove
	// absence of coverage (integration tests exercise code they don't import). So
	// `[]` MEASURES with the full suite; a block can only come from that run.
	it("MEASURES with the full suite when no test statically imports the file (selection == []) — never blocks from the graph alone", async () => {
		// m.ts is imported only by a non-test; selection is [] → fall back to the
		// FULL suite (no subset forwarded) and MEASURE, rather than block blind.
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/app.ts")],
			[join(root, "src/app.ts")]: [],
		});
		// A covered measured result → allowed. The point: the runner RAN (it was
		// not short-circuited by a graph block) and got NO subset (full suite).
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(decision).toBeNull(); // measured + covered → allowed, NOT a graph block
		expect(selected()).toBeUndefined(); // full suite, not a wrong empty subset
	});

	it("a block on an empty selection is MEASUREMENT-driven (the suite ran and showed the edited line uncovered), not graph-driven", async () => {
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/app.ts")],
			[join(root, "src/app.ts")]: [],
		});
		// The measured run reports the added function as uncovered (hits 0) → the
		// block comes from the coverage decision, with the uncovered-line reason —
		// NOT the old graph-only "no test imports this" reason.
		const { runner, ran } = stubRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(decision?.decision).toBe("block");
		expect(ran()).toBe(true); // the block is measurement-driven — the suite ran
		expect(decision?.reason).toMatch(/uncovered by the test suite after this edit/);
		expect(decision?.reason).not.toMatch(/no test in the project imports/);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("does NOT defer on budget when a scoped subset exists (enforces in-band)", async () => {
		// Estimate is above budget, but a scoped subset bypasses the budget gate:
		// the run is fast, so it executes and enforces instead of deferring.
		writeRuntimeEstimateAbove(root, 30_000);
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/m.test.ts")],
		});
		const { runner, ran } = stubRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
			view,
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(true); // ran despite the over-budget estimate
	});

	it("falls back to the full suite (no selectedTests) when the file is NOT in the graph", async () => {
		// hasFile=false → selector returns null → full suite, runner gets no subset.
		const view = stubDepView({}, new Set<string>([join(root, "src/other.ts")]));
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(decision).toBeNull();
		expect(selected()).toBeUndefined();
	});

	it("scopes a NEW file (not in the graph) to its on-disk companion — enforces per-edit instead of deferring", async () => {
		// THE FIX: hasFile=false (brand-new file) but src/m.test.ts exists on disk
		// (test-first TDD) → the new-file branch resolves the companion → scoped run.
		// Even an over-budget estimate doesn't defer, because the scoped route never
		// consults the budget gate. Before the fix this deferred to the commit gate.
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.test.ts"), "import './m.js';\nit('x', () => {});\n", "utf-8");
		writeRuntimeEstimateAbove(root, 30_000);
		const view = stubDepView({}, new Set<string>([join(root, "src/other.ts")]));
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
			view,
		);
		expect(decision).toBeNull();
		expect(selected()).toEqual(["src/m.test.ts"]);
	});

	it("blocks a NEW file per-edit when its companion leaves an added line uncovered", async () => {
		// New file + on-disk companion, but the measured run shows the added function
		// uncovered (hits 0) → per-edit BLOCK, not a deferral. This is the heavy-handed
		// 100%-coverage enforcement reaching new files.
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.test.ts"), "import './m.js';\nit('x', () => {});\n", "utf-8");
		const view = stubDepView({}, new Set<string>([join(root, "src/other.ts")]));
		const { runner, ran } = stubRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 0, statement_pct: 0 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			view,
		);
		expect(decision?.decision).toBe("block");
		expect(ran()).toBe(true);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("with NO depView supplied, behavior is the full-suite path (unchanged)", async () => {
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/m.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
			// depView omitted
		);
		expect(decision).toBeNull();
		expect(selected()).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Fail-LOUD: gate ON for a covered language but the runner could not establish
// a result → ALLOW (can't-measure ≠ deny) but with an AGENT-VISIBLE provider
// warning carried ON THE DECISION (allow + warnings), never a silent null. The
// warning must reach the agent — asserting `decision.warnings` (not just stderr)
// is the regression pin against silent fail-open.
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — fail-loud when the runner cannot run", () => {
	it("ok:false on a JS edit → ALLOW carrying the agent-visible warning (NOT a silent null)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "no report", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(failing),
		);
		// Allowed (fail-open) but NOT silently: it is an allow-DECISION, not null.
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("allow");
		// The warning is carried on the decision so the pipeline forwards it to the
		// agent — the exact provider text the operator must act on.
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/\[interlinked:coverage\]/);
		expect(warning).toMatch(/coverage\/red-green\/CRAP gate is ON for ts/);
		expect(warning).toMatch(/could not run/);
		expect(warning).toMatch(/@vitest\/coverage-v8/);
		expect(warning).toMatch(/pytest-cov/);
		expect(warning).toMatch(/NOT.*coverage-checked/);
		// Belt and suspenders: the daemon-stderr line is still emitted.
		expect(errSpy).toHaveBeenCalled();
		expect(errSpy.mock.calls.map((c) => String(c[0])).join("")).toContain(warning);
		errSpy.mockRestore();
	});

	it("no runner for a covered language → ALLOW carrying the warning (not null)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const noRunnerDeps: CoverageWriteDeps = {
			runnerFor: () => null, // gate ON, but the factory yields nothing
			createOverlay: stubOverlay(),
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			noRunnerDeps,
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/gate is ON for ts but could not run/);
		expect(warning).toMatch(/to enforce/);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("Python ok:false → the agent-visible warning names pytest-cov (the python provider)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "no report", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", "x = 1\n"),
			rules({ languages: ["js", "ts", "python"] }),
			deps(failing),
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/gate is ON for python/);
		expect(warning).toMatch(/pytest-cov/);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("a SUCCESSFUL covered run emits NO degrade/provider warning (no spurious noise)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Green suite, the single function fully covered → clean allow.
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		// Clean pass = bare null (no decision, no warning): the gate ran and was happy.
		expect(decision).toBeNull();
		const text = errSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(text).not.toMatch(/\[interlinked:coverage\]/);
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Python reaches the gate now that "python" is a covered language
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — a .py edit reaches the gate (python covered)", () => {
	it("runs the runner for a .py edit when python is configured (not a no-op)", async () => {
		const { runner, ran } = stubRunner(pyCoverageResult("src/a.py", [1], []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", "x = 1\n"),
			rules({ languages: ["js", "ts", "python"] }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(true);
	});

	it("the SHIPPED default config now covers python (.py reaches the gate)", async () => {
		// Regression pin for the languages change: DEFAULT_CONFIG includes python,
		// so a .py edit is no longer short-circuited as an unsupported language.
		expect(DEFAULT_CONFIG.per_edit_coverage?.languages).toContain("python");
		const { runner, ran } = stubRunner(pyCoverageResult("src/a.py", [1], []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", "x = 1\n"),
			DEFAULT_CONFIG,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(true);
	});
});

describe("checkCoverageWrite — loud-degrade", () => {
	it("allows AND carries the agent-visible warning when the runner errors (not null)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(failing),
		);
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("allows with an agent-visible warning when the overlay factory throws (never crashes the pipeline)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const throwingDeps: CoverageWriteDeps = {
			runnerFor: () => stubRunner(coverageResult("src/a.ts", [])).runner,
			createOverlay: () => {
				throw new Error("overlay failed");
			},
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			throwingDeps,
		);
		// The outer try/catch loud-degrades — allow, but NOT silently.
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/\[interlinked:coverage\]/);
		expect(warning).toMatch(/degraded/);
		expect(warning).toMatch(/overlay failed/);
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Local helpers that poke persisted state for assertions
// ---------------------------------------------------------------------------

function writeRuntimeEstimateAbove(projectRoot: string, ms: number): void {
	// Reuse the public updater twice so the EWMA settles at/above `ms`.
	updateRuntimeEstimateMs(projectRoot, ms, () => 0);
	updateRuntimeEstimateMs(projectRoot, ms, () => 0);
}

function readObligations(projectRoot: string): Array<Record<string, unknown>> {
	const path = join(projectRoot, ".interlinked", "coverage-obligations.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const row: unknown = JSON.parse(line);
			if (!isJsonObject(row)) throw new Error("Expected an obligation object");
			return row;
		});
}

// ---------------------------------------------------------------------------
// APPLY_PATCH ATOMICITY CONTRACT (finding 2026-06). A single apply_patch carrying
// a production change AND its covering test must be evaluated in ONE overlay
// holding BOTH sections, with the suite run ONCE — otherwise the code is reported
// uncovered (its test was filtered out / left on disk) and a valid strict-TDD
// patch is falsely blocked.
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — apply_patch atomicity", () => {
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

	/** Overlay stub recording the primary + sibling relPaths it was handed. */
	function capturingOverlay(): { createOverlay: CoverageWriteDeps["createOverlay"]; files: () => string[] } {
		let captured: string[] = [];
		const createOverlay: CoverageWriteDeps["createOverlay"] = (projectRoot, editedRelPath, _content, extra) => {
			captured = [editedRelPath, ...(extra ?? []).map((f) => f.relPath)];
			return {
				overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
				editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
				cleanup: () => {},
			};
		};
		return { createOverlay, files: () => captured };
	}

	function depsWith(createOverlay: CoverageWriteDeps["createOverlay"], runner: CoverageRunner): CoverageWriteDeps {
		return { runnerFor: () => runner, createOverlay, clock: () => 0, cyclomaticFor: () => () => [] };
	}

	it("overlays BOTH code and test, runs the suite ONCE, and ALLOWS a covered code+test patch", async () => {
		const { createOverlay, files } = capturingOverlay();
		let runs = 0;
		const runner: CoverageRunner = {
			run: async () => {
				runs++;
				return coverageResult("src/m.ts", [
					{ name: "f", line: 1, endLine: 1, hits: 2, statement_pct: 100 },
				]);
			},
		};
		const ev = applyPatch(
			"*** Add File: src/m.ts",
			"+export function f() {",
			"+\treturn 1;",
			"+}",
			"*** Add File: src/m.test.ts",
			'+import { f } from "./m";',
			'+test("f", () => { f(); });',
		);
		const decision = await checkCoverageWrite(ev, rules(), depsWith(createOverlay, runner));
		expect(decision).toBeNull(); // covered → allowed (the test was present in the overlay)
		expect(runs).toBe(1); // ONE suite run for the whole atomic patch
		expect(files()).toContain("src/m.ts"); // production primary
		expect(files()).toContain("src/m.test.ts"); // its test, in the SAME overlay
	});

	it("BLOCKS a code-only patch whose added function is uncovered", async () => {
		const { createOverlay } = capturingOverlay();
		const runner: CoverageRunner = {
			run: async () =>
				coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 1, hits: 0, statement_pct: 0 }]),
		};
		const ev = applyPatch("*** Add File: src/m.ts", "+export function f() {", "+\treturn 1;", "+}");
		const decision = await checkCoverageWrite(ev, rules(), depsWith(createOverlay, runner));
		expect(decision?.decision).toBe("block");
	});

	// Baselines persist ONLY when the WHOLE atomic patch allows (finding 2026-06):
	// a mid-loop persist let an early target's baseline land while a later target
	// blocked the patch, leaving the baseline describing content that never
	// existed and corrupting future drop decisions.
	function twoTargetResult(m2Covered: boolean): CoverageRunResult {
		const perFile = new Map<string, PerFileCoverage>();
		perFile.set("src/m1.ts", {
			filePath: "src/m1.ts",
			mtime: 0,
			functions: [{ name: "f1", line: 1, endLine: 1, hits: 2, statement_pct: 100 }],
		});
		perFile.set("src/m2.ts", {
			filePath: "src/m2.ts",
			mtime: 0,
			functions: [
				{ name: "f2", line: 1, endLine: 1, hits: m2Covered ? 2 : 0, statement_pct: m2Covered ? 100 : 0 },
			],
		});
		return { suiteMs: 1000, perFile, ok: true, testsPassed: true };
	}

	const TWO_TARGET_PATCH = [
		"*** Add File: src/m1.ts",
		"+export function f1() {",
		"+\treturn 1;",
		"+}",
		"*** Add File: src/m2.ts",
		"+export function f2() {",
		"+\treturn 2;",
		"+}",
	];

	it("does NOT persist an early target's baseline when a LATER target blocks the patch", async () => {
		const { createOverlay } = capturingOverlay();
		const runner: CoverageRunner = { run: async () => twoTargetResult(false) };
		const decision = await checkCoverageWrite(
			applyPatch(...TWO_TARGET_PATCH),
			rules(),
			depsWith(createOverlay, runner),
		);
		expect(decision?.decision).toBe("block"); // m2 uncovered blocks the whole patch
		// Pre-fix: m1's baseline was already written when m2 blocked.
		expect(readFileCoverageBaseline(root, "src/m1.ts")).toBeNull();
		expect(readFileCoverageBaseline(root, "src/m2.ts")).toBeNull();
	});

	it("persists EVERY target's baseline once the whole patch allows", async () => {
		const { createOverlay } = capturingOverlay();
		const runner: CoverageRunner = { run: async () => twoTargetResult(true) };
		const decision = await checkCoverageWrite(
			applyPatch(...TWO_TARGET_PATCH),
			rules(),
			depsWith(createOverlay, runner),
		);
		expect(decision).toBeNull();
		expect(readFileCoverageBaseline(root, "src/m1.ts")).toBe(1);
		expect(readFileCoverageBaseline(root, "src/m2.ts")).toBe(1);
	});

	// ---- reasoned full-suite routing (finding 2026-06): a source-only patch may
	// ---- use the scoped affected-test route; only sections that make scoping
	// ---- unsound (e.g. a test section) force the full suite.
	it("a source-only UPDATE patch routes SCOPED — the runner receives the affected-test subset", async () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.ts"), "export const a = 1;\n", "utf-8");
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/m.test.ts")],
		});
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 1, hits: 2, statement_pct: 100 }]),
		);
		const ev = applyPatch(
			"*** Update File: src/m.ts",
			"@@",
			"-export const a = 1;",
			"+export const a = 2;",
		);
		const decision = await checkCoverageWrite(ev, rules(), deps(runner), view);
		expect(decision).toBeNull();
		expect(selected()).toEqual(["src/m.test.ts"]); // scoped, not full
	});

	it("the SAME update patch plus a test section forces the FULL suite (no subset)", async () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.ts"), "export const a = 1;\n", "utf-8");
		const view = stubDepView({
			[join(root, "src/m.ts")]: [join(root, "src/m.test.ts")],
		});
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 1, hits: 2, statement_pct: 100 }]),
		);
		const ev = applyPatch(
			"*** Update File: src/m.ts",
			"@@",
			"-export const a = 1;",
			"+export const a = 2;",
			"*** Add File: src/other.test.ts",
			'+test("t", () => {});',
		);
		const decision = await checkCoverageWrite(ev, rules(), deps(runner), view);
		expect(decision).toBeNull();
		expect(selected()).toBeUndefined(); // full suite — the overlay-only test must run
	});

	it("a source-only patch with NO depView still falls back to the full suite", async () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.ts"), "export const a = 1;\n", "utf-8");
		const { runner, selected } = capturingRunner(
			coverageResult("src/m.ts", [{ name: "f", line: 1, endLine: 1, hits: 2, statement_pct: 100 }]),
		);
		const ev = applyPatch(
			"*** Update File: src/m.ts",
			"@@",
			"-export const a = 1;",
			"+export const a = 2;",
		);
		const decision = await checkCoverageWrite(ev, rules(), deps(runner));
		expect(decision).toBeNull();
		expect(selected()).toBeUndefined();
	});

	// ---- delete-only plans (finding 2026-06): no coverage targets, but the
	// ---- deletion overlay can break the suite — red-bar enforcement still runs.
	it("BLOCKS a delete-only source patch whose suite comes back RED (block_on_test_failure)", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/other.ts", [], 1000, {
				testsPassed: false,
				failingTests: ["imports gone.ts"],
			}),
		);
		const ev = applyPatch("*** Delete File: src/gone.ts");
		const decision = await checkCoverageWrite(ev, rules({ block_on_test_failure: true }), deps(runner));
		expect(ran()).toBe(true); // the suite RAN against the deletion overlay
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("src/gone.ts");
		expect(decision?.reason).toMatch(/RED/);
	});

	it("ALLOWS a delete-only source patch whose suite stays GREEN", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const ev = applyPatch("*** Delete File: src/gone.ts");
		const decision = await checkCoverageWrite(ev, rules({ block_on_test_failure: true }), deps(runner));
		expect(ran()).toBe(true);
		expect(decision).toBeNull();
	});

	it("does NOT spend a suite run on a delete-only patch when red-bar blocking is off", async () => {
		// Without block_on_test_failure the gate has no decidable axis for a
		// deletion (no coverage target), so it must not run the suite.
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const ev = applyPatch("*** Delete File: src/gone.ts");
		const decision = await checkCoverageWrite(ev, rules(), deps(runner));
		expect(ran()).toBe(false);
		expect(decision).toBeNull();
	});

	it("ignores a delete-only patch of NON-code files (nothing gated deleted)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const ev = applyPatch("*** Delete File: docs/notes.md");
		const decision = await checkCoverageWrite(ev, rules({ block_on_test_failure: true }), deps(runner));
		expect(ran()).toBe(false);
		expect(decision).toBeNull();
	});

	it("defers a delete-only patch to the commit gate when the estimate exceeds the budget", async () => {
		writeRuntimeEstimateAbove(root, 30_000);
		const { runner, ran } = stubRunner(coverageResult("src/other.ts", []));
		const ev = applyPatch("*** Delete File: src/gone.ts");
		const decision = await checkCoverageWrite(
			ev,
			rules({ block_on_test_failure: true, budget_ms: 25_000 }),
			deps(runner),
		);
		expect(ran()).toBe(false); // deferred, not run
		expect(decision).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Cross-ecosystem sections (finding 2026-06): a patch with coverage targets in
// one language plus a deletion / move / test section in ANOTHER must run BOTH
// suites — vitest passing must not ship an unrun pytest breakage.
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — cross-ecosystem sections run their own suite", () => {
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

	/** A runner with a stable execution-key `id` that counts its runs. */
	function countingRunner(
		id: string,
		result: CoverageRunResult,
	): { runner: CoverageRunner; runs: () => number } {
		let n = 0;
		return {
			runner: {
				id,
				run: async () => {
					n++;
					return result;
				},
			},
			runs: () => n,
		};
	}

	/** Per-language deps: js/ts share one runner (Vitest), python gets its own. */
	function polyglotDeps(jsTs: CoverageRunner, py: CoverageRunner): CoverageWriteDeps {
		return {
			runnerFor: (language) => (language === "python" ? py : jsTs),
			createOverlay: stubOverlay(),
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
	}

	/** A green, fully-covered result for the ts target `src/m.ts`. */
	function greenTs(): CoverageRunResult {
		return coverageResult("src/m.ts", [
			{ name: "f", line: 1, endLine: 1, hits: 2, statement_pct: 100 },
		]);
	}

	const POLYGLOT = { languages: ["js", "ts", "python"], block_on_test_failure: true };

	beforeEach(() => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.ts"), "export const a = 1;\n", "utf-8");
	});

	const TS_UPDATE = ["*** Update File: src/m.ts", "@@", "-export const a = 1;", "+export const a = 2;"];

	it("BLOCKS a TS update + Python deletion whose python suite comes back RED", async () => {
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner(
			"pytest",
			coverageResult("pkg/other.py", [], 1000, {
				testsPassed: false,
				failingTests: ["test_imports_gone"],
			}),
		);
		const ev = applyPatch(...TS_UPDATE, "*** Delete File: pkg/gone.py");
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), polyglotDeps(ts.runner, py.runner));
		expect(ts.runs()).toBe(1); // the target's own suite still ran
		expect(py.runs()).toBe(1); // pre-fix: 0 — the python deletion shipped unrun
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("pkg/gone.py");
		expect(decision?.reason).toMatch(/python test suite RED/);
	});

	it("ALLOWS when both ecosystems' suites stay green (each ran exactly once)", async () => {
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner("pytest", coverageResult("pkg/other.py", []));
		const ev = applyPatch(...TS_UPDATE, "*** Delete File: pkg/gone.py");
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), polyglotDeps(ts.runner, py.runner));
		expect(decision).toBeNull();
		expect(ts.runs()).toBe(1);
		expect(py.runs()).toBe(1);
	});

	it("a python TEST section added next to a TS target runs the python suite too", async () => {
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner(
			"pytest",
			coverageResult("pkg/other.py", [], 1000, { testsPassed: false, failingTests: ["test_new"] }),
		);
		const ev = applyPatch(...TS_UPDATE, "*** Add File: tests/test_new.py", "+def test_new():", "+    assert False");
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), polyglotDeps(ts.runner, py.runner));
		expect(py.runs()).toBe(1);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toContain("tests/test_new.py");
	});

	it("does NOT re-run a language whose RUNNER a target already ran (vitest serves js+ts)", async () => {
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner("pytest", coverageResult("pkg/other.py", []));
		// The js test section shares the ts target's runner (same execution key).
		const ev = applyPatch(...TS_UPDATE, "*** Add File: src/extra.test.js", '+test("t", () => {});');
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), polyglotDeps(ts.runner, py.runner));
		expect(decision).toBeNull();
		expect(ts.runs()).toBe(1); // ONE run covers the ts target AND the js section
		expect(py.runs()).toBe(0); // no python section anywhere in the patch
	});

	it("spends NO cross-ecosystem run when block_on_test_failure is off (no decidable axis)", async () => {
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner("pytest", coverageResult("pkg/other.py", []));
		const ev = applyPatch(...TS_UPDATE, "*** Delete File: pkg/gone.py");
		const decision = await checkCoverageWrite(
			ev,
			rules({ languages: ["js", "ts", "python"] }),
			polyglotDeps(ts.runner, py.runner),
		);
		expect(decision).toBeNull();
		expect(py.runs()).toBe(0); // red bar is the only axis for a non-target section
	});

	it("defers the cross-ecosystem obligation when the estimate exceeds the budget", async () => {
		updateRuntimeEstimateMs(root, 30_000, () => 0); // seed estimate over budget
		const ts = countingRunner("vitest", greenTs());
		const py = countingRunner("pytest", coverageResult("pkg/other.py", []));
		const ev = applyPatch(...TS_UPDATE, "*** Delete File: pkg/gone.py");
		const decision = await checkCoverageWrite(
			ev,
			rules({ ...POLYGLOT, budget_ms: 25_000 }),
			polyglotDeps(ts.runner, py.runner),
		);
		expect(decision).toBeNull();
		expect(py.runs()).toBe(0); // deferred to the (language-aware) commit gate
		const ledger = readFileSync(join(root, ".interlinked", "coverage-obligations.jsonl"), "utf-8");
		expect(ledger).toContain("pkg/gone.py"); // the residual deferral is RECORDED
	});

	it("a delete-only plan pairing a python deletion with a TS test section runs BOTH languages", async () => {
		const ts = countingRunner(
			"vitest",
			coverageResult("src/other.ts", [], 1000, { testsPassed: false, failingTests: ["new ts test"] }),
		);
		const py = countingRunner("pytest", coverageResult("pkg/other.py", []));
		const ev = applyPatch(
			"*** Delete File: pkg/gone.py",
			"*** Add File: src/extra.test.ts",
			'+test("t", () => { throw new Error("red"); });',
		);
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), polyglotDeps(ts.runner, py.runner));
		expect(py.runs() + ts.runs()).toBeGreaterThanOrEqual(1); // ran until the first red
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
	});

	it("propagates the residual language's loud-degrade warning alongside the target's own (both allow-with-warning)", async () => {
		// createOverlay throws for EVERY overlay build (the target's own run AND the
		// residual python run), so both legs loud-degrade and BOTH warnings must
		// survive into the single merged allow decision.
		const throwingDeps: CoverageWriteDeps = {
			runnerFor: (language) => (language === "python" ? countingRunner("pytest", coverageResult("pkg/other.py", [])).runner : countingRunner("vitest", greenTs()).runner),
			createOverlay: () => {
				throw new Error("mirror boom");
			},
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const ev = applyPatch(...TS_UPDATE, "*** Delete File: pkg/gone.py");
		const decision = await checkCoverageWrite(ev, rules(POLYGLOT), throwingDeps);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/mirror boom/);
	});
});

// ---------------------------------------------------------------------------
// Additional gap coverage (2026-08): entry-gating branches, DEFAULT_DEPS,
// runner-unavailable fallback text, and the coverage-report-absence path.
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — additional gating + fallback branches", () => {
	it("is a no-op for a non-write tool (Read) — isFileWrite's false branch", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			{
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Read",
				tool_input: { file_path: join(root, "src/a.ts") },
				timestamp: "2026-06-07T00:00:00.000Z",
				cwd: root,
			},
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("falls back to process.cwd() when the event carries no cwd (non-code target ⇒ safe no-op)", async () => {
		const { runner } = stubRunner(coverageResult("README.md", []));
		// No `cwd` field at all: `event.cwd || process.cwd()` must take the
		// right-hand side. A non-code file_path keeps the rest of the gate a
		// trivial no-op regardless of which projectRoot is resolved.
		const decision = await checkCoverageWrite(
			{
				hook_event: "PreToolUse",
				session_id: "sess-1",
				agent_source: "claude",
				tool_name: "Write",
				tool_input: { file_path: "/nonexistent-cov-guard-fixture-root/README.md", content: "# hi\n" },
				timestamp: "2026-06-07T00:00:00.000Z",
			},
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
	});

	it("the repo-profile fast-path fires (returns non-undefined) when no runner is detected for the gated language", async () => {
		// A sibling root with NO vitest/jest signal at all (bare package.json, no
		// pytest.ini either) — detectJsRunner returns false, so
		// profileRunnerFastPath's early-return-with-warning path is taken instead
		// of falling through to the overlay/runner machinery.
		const bareRoot = mkdtempSync(join(tmpdir(), "interlinked-cov-guard-bare-"));
		try {
			writeFileSync(join(bareRoot, "package.json"), JSON.stringify({ name: "bare" }), "utf-8");
			resetRepoProfileCache();
			const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
			const decision = await checkCoverageWrite(
				{
					hook_event: "PreToolUse",
					session_id: "sess-1",
					agent_source: "claude",
					tool_name: "Write",
					tool_input: { file_path: join(bareRoot, "src/a.ts"), content: "export const a = 1;\n" },
					timestamp: "2026-06-07T00:00:00.000Z",
					cwd: bareRoot,
				},
				rules(),
				deps(runner),
			);
			// The fast-path decision is returned directly — the real runner is never invoked.
			expect(decision?.decision).toBe("allow");
			const warning = (decision?.warnings ?? []).join("\n");
			expect(warning).toMatch(/no supported test runner/);
			expect(ran()).toBe(false);
			errSpy.mockRestore();
		} finally {
			rmSync(bareRoot, { recursive: true, force: true });
			resetRepoProfileCache();
		}
	});

	it("ALLOWS with a generic fallback reason when a failed run carries no `error` string", async () => {
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, testsPassed: null }),
		};
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(failing),
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/could not run/);
		errSpy.mockRestore();
	});

	it("loud-degrades when the edited file is absent from an otherwise-ok coverage report", async () => {
		// `ok: true` but the perFile map has NO entry for the edited relPath.
		const result = coverageResult("src/other-file.ts", []);
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/\[interlinked:coverage\]/);
		expect(warning).toMatch(/edited file absent from coverage report/);
		errSpy.mockRestore();
	});

	it("loud-degrades with the non-Error branch when the overlay factory throws a non-Error value", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const throwingDeps: CoverageWriteDeps = {
			runnerFor: () => stubRunner(coverageResult("src/a.ts", [])).runner,
			createOverlay: () => {
				// Exercising the `err instanceof Error` false branch.
				throw "overlay-failed-non-error";
			},
			clock: () => 0,
			cyclomaticFor: () => () => [],
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			throwingDeps,
		);
		expect(decision?.decision).toBe("allow");
		const warning = (decision?.warnings ?? []).join("\n");
		expect(warning).toMatch(/overlay-failed-non-error/);
		errSpy.mockRestore();
	});

	it("exercises DEFAULT_DEPS (no deps arg): the real runner factory is reached and fails loud (ENOENT/spawn), never crashing", async () => {
		writeFileSync(join(root, "src.ts.placeholder"), "", "utf-8");
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const decision = await checkCoverageWrite(
			writeEvent("src/default-deps.ts", "export const a = 1;\n"),
			rules({ budget_ms: 2_000 }),
			// No third argument ⇒ DEFAULT_DEPS (the real runnerFor/createOverlay/clock).
		);
		// Whatever the real environment does (no vitest binary on PATH in the
		// tmp fixture ⇒ ok:false, or a report that omits the file), the gate must
		// stay fail-open: either null (measured clean) or an allow decision, but
		// never a block and never a throw.
		expect(decision === null || decision?.decision === "allow").toBe(true);
		errSpy.mockRestore();
	}, 15_000);
});
