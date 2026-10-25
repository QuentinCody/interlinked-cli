// Regression pins for two CONFIRMED red-team bypasses of the coverage
// water-lines (scratch/2026-10-21-red-team/result.json; surfaces
// `baseline_integrity_gate` and `per_edit_coverage`). Each P-case reproduces
// the recorded concrete input against the real gate code; each N-case keeps
// an honest write passing. Fixture roots are OS temp dirs — the real
// `.interlinked/*.json` is never touched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { readFileCoverageBaselineEntry, readFileCoverageHighWater, writeFileCoverageBaseline } from "../coverage-obligation-ledger.js";
import type { CoverageOverlay } from "../coverage-overlay.js";
import type { CoverageRunner, CoverageRunResult } from "../coverage-runner.js";
import type { DependencyView } from "../dependency-view.js";
import { resetRepoProfileCache } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { detectBaselineGaming, evaluateBaselineIntegrityForEvent } from "./baseline-integrity-gate.js";
import { coverageScopeId } from "./coverage-scope.js";
import { decideFromCoverage } from "./coverage-write-decision.js";
import { type CoverageWriteDeps, checkCoverageWrite } from "./coverage-write-guard.js";

// ---- bypass 1 fixtures: a hand Edit of coverage-edit-baseline.json ---------

const BASELINE = "/repo/.interlinked/coverage-edit-baseline.json";
const SCOPE_A = coverageScopeId(["src/m.test.ts"]);
const SCOPE_B = coverageScopeId(["src/m.smoke.test.ts", "src/m.test.ts"]);

function editEvent(oldString: string, newString: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "red-team",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: BASELINE, old_string: oldString, new_string: newString },
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: "/repo",
	};
}

/** The gate as the daemon runs it, with the on-disk baseline injected. */
function gate(before: string, oldString: string, newString: string) {
	return evaluateBaselineIntegrityForEvent(editEvent(oldString, newString), { getDisk: () => before });
}

// ---- bypass 2 fixtures: the real per-edit guard route with stubbed runner ---

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rt-cov-scope-"));
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3.0.0" } }));
	resetRepoProfileCache();
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	resetRepoProfileCache();
});

const SRC = "src/m.ts";
const SRC_BEFORE = "export function f(a: number) {\n  if (a > 0) {\n    return 1;\n  }\n  return 2;\n}\n";
/** The recorded regression: a flipped condition — the edited line itself still
 *  executes, so the per-line added-coverage check passes; `return 1` goes dead. */
const FLIP_EDIT = { old_string: "  if (a > 0) {", new_string: "  if (a > 1e9) {" };

function rules(): GuardRulesConfig {
	return {
		...makeGuardRules(),
		per_edit_coverage: { enabled: true, mode: "block", budget_ms: 25_000, languages: ["js", "ts"] },
	} as GuardRulesConfig;
}

function sourceEdit(input: Record<string, unknown>): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "red-team",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: join(root, SRC), ...input },
		timestamp: "2026-10-21T00:00:00.000Z",
		cwd: root,
	};
}

/** What the stub runner was asked to run (`undefined` = the full suite). */
interface SeenSelection {
	tests?: string[] | undefined;
}

function stubRunner(cov: Omit<PerFileCoverage, "filePath" | "mtime">, seen: SeenSelection): CoverageRunner {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(SRC, { filePath: SRC, mtime: 0, ...cov });
	const result: CoverageRunResult = { suiteMs: 10, perFile, ok: true, testsPassed: true };
	return {
		run: async (opts) => {
			seen.tests = opts.selectedTests;
			return result;
		},
	};
}

function deps(runner: CoverageRunner): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: (projectRoot, rel): CoverageOverlay => ({
			overlayRoot: join(projectRoot, ".ov"),
			editedFileInOverlay: join(projectRoot, ".ov", rel),
			cleanup: () => {},
		}),
		clock: () => 0,
		cyclomaticFor: () => null,
	};
}

/** A repo-scope reverse graph: src/m.ts is imported by the listed test files. */
function depView(tests: string[]): DependencyView {
	return {
		answerScope: "repo",
		hasFile: (p: string) => p.endsWith(SRC),
		getDependents: (p: string) => (p.endsWith(SRC) ? tests.map((t) => join(root, t)) : []),
	} as unknown as DependencyView;
}

/** Coverage after FLIP_EDIT: line 2 (edited) and line 5 run, line 3 is dead → 66.7%. */
const FLIPPED_COV = {
	functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 66 }],
	coveredLines: new Set([2, 5]),
	uncoveredLines: new Set([3]),
};

describe("red-team 2026-10-21 — coverage scope re-anchor — positive (must block)", () => {
	it("P1: Scope-string re-anchor to lower a coverage-edit fraction (Edit-arm exemption abuse)", () => {
		// The recorded probe: same scope token plus a trailing space, f 0.95 → 0.10.
		const before = JSON.stringify({ "src/foo.ts": { f: 0.95, scope: "scoped:abc123def456" } });
		const d = gate(before, '{"f":0.95,"scope":"scoped:abc123def456"}', '{"f":0.1,"scope":"scoped:abc123def456 "}');
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("baseline_integrity_gate");
		expect(d?.reason).toContain("[coverage-edit:src/foo.ts]");
		expect(d?.reason).toContain("[coverage-edit-scope:src/foo.ts]");
	});

	it("P2: Scope re-anchor by companion-test churn (cross-file shuffle + sequence timing)", async () => {
		// The recorded technique through the REAL guard route: baseline earned
		// under scope A (m.test.ts only); an ungated smoke test widened selection
		// to scope B; the flipped condition drops the file to 66.7%.
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1, SCOPE_A);
		const seen: SeenSelection = {};
		const d = await checkCoverageWrite(sourceEdit(FLIP_EDIT), rules(), deps(stubRunner(FLIPPED_COV, seen)), depView(["src/m.test.ts", "src/m.smoke.test.ts"]));
		expect(seen.tests).toEqual(["src/m.smoke.test.ts", "src/m.test.ts"]);
		expect(coverageScopeId(seen.tests)).toBe(SCOPE_B);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("drops src/m.ts coverage from 100.0% to 66.7%");
		expect(d?.reason).toContain(`${SCOPE_A} → ${SCOPE_B}`);
		// The water-line is NOT re-keyed lower.
		expect(readFileCoverageBaselineEntry(root, SRC)).toEqual({ fraction: 1, scope: SCOPE_A });
	});

	it("P3: legacy bare-number entry wrapped in {f, scope} (the live-daemon input)", () => {
		// The exact --old/--new strings the record ran against the daemon, over a
		// legacy file shape (every entry in this repo's ledger was a bare number).
		const before = '{\n  "src/harness/coverage-overlay.ts": 1,\n  "src/z.ts": 1\n}\n';
		const d = gate(before, '"src/harness/coverage-overlay.ts": 1,', '"src/harness/coverage-overlay.ts": {"f": 0.1, "scope": "x"},');
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("[coverage-edit:src/harness/coverage-overlay.ts]");
		expect(d?.reason).toContain("[coverage-edit-scope:src/harness/coverage-overlay.ts]");
	});

	it("P4: scope re-keyed by hand at an EQUAL fraction (primes the runtime to re-anchor lower)", () => {
		const before = JSON.stringify({ "src/foo.ts": { f: 0.95, scope: SCOPE_A } });
		const d = gate(before, `"scope":"${SCOPE_A}"`, '"scope":"full"');
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("re-keyed by hand");
		expect(detectBaselineGaming(BASELINE, before, JSON.stringify({ "src/foo.ts": { f: 0.95, scope: "full" } }), () => true).map((f) => f.rule)).toEqual([
			"coverage-edit-scope:src/foo.ts",
		]);
	});

	it("P5: entry replaced by an undecodable value (the runtime reads it as no baseline)", () => {
		const before = JSON.stringify({ "src/foo.ts": { f: 0.95, scope: SCOPE_A } });
		const d = gate(before, `{"f":0.95,"scope":"${SCOPE_A}"}`, '"n/a"');
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("cannot decode");
	});

	it("P6: flip-back — the companion test removed again, a further drop under the narrower scope", () => {
		// Step 3 of the record: after a (hypothetical) re-anchor at 66.7% under B,
		// deleting the smoke test returns selection to A and the file to 33.3%.
		writeFileCoverageBaseline(root, SRC, 0.6667, SCOPE_B);
		const cov: PerFileCoverage = {
			filePath: SRC,
			mtime: 0,
			functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 33 }],
			coveredLines: new Set([2]),
			uncoveredLines: new Set([3, 5]),
		};
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, SRC, cov, new Set([2]), out, SCOPE_A);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("66.7% to 33.3%");
		expect(out.now).toBeUndefined();
		expect(readFileCoverageBaselineEntry(root, SRC)).toEqual({ fraction: 0.6667, scope: SCOPE_B });
	});

	it("P7: a scoped baseline measured again under the FULL suite (a superset) with a drop", () => {
		writeFileCoverageBaseline(root, SRC, 1, SCOPE_A);
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, ...FLIPPED_COV };
		const d = decideFromCoverage(root, SRC, cov, new Set([2]), {}, "full");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain(`${SCOPE_A} → full`);
	});
});

describe("red-team 2026-10-21 — coverage scope re-anchor — negative (must not fire)", () => {
	it("N1: an honest hand RAISE of a coverage-edit fraction with its scope untouched still passes", () => {
		const before = JSON.stringify({ "src/foo.ts": { f: 0.95, scope: SCOPE_A }, "src/bar.ts": 0.5 });
		expect(gate(before, '"f":0.95', '"f":0.97')).toBeNull();
		expect(gate(before, '"src/bar.ts":0.5', '"src/bar.ts":0.6')).toBeNull();
		expect(detectBaselineGaming(BASELINE, before, before, () => true)).toEqual([]);
	});

	it("N2: the full suite or a legacy baseline is no longer re-anchored DOWN by a narrowed selection (superseded by round 2)", () => {
		// Was: the 2026-07-24 bio exemption, ALLOWED. Round 2 of the red team
		// showed it is the bypass itself; see the round-2 describe below.
		const cov: PerFileCoverage = {
			filePath: SRC,
			mtime: 0,
			functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 98.7 }],
		};
		for (const stored of ["full", undefined]) {
			writeFileCoverageBaseline(root, SRC, 1, stored);
			const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
			expect(decideFromCoverage(root, SRC, cov, new Set([99]), out, SCOPE_A)?.decision).toBe("block");
			expect(out.now).toBeUndefined();
		}
	});

	it("N3: a scope change with HIGHER coverage re-anchors upward (never a loosening)", () => {
		writeFileCoverageBaseline(root, SRC, 0.5, SCOPE_A);
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 100 }] };
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		expect(decideFromCoverage(root, SRC, cov, new Set([2]), out, SCOPE_B)).toBeNull();
		expect(out.scopeChanged).toEqual({ priorFraction: 0.5 });
		expect(out.now).toBe(1);
	});

	it("N4: an honest edit under the widened scope that HOLDS coverage is allowed and re-keys the scope at the held value", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1, SCOPE_A);
		const held = {
			functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 100 }],
			coveredLines: new Set([2, 3, 5]),
			uncoveredLines: new Set<number>(),
		};
		const edit = { old_string: "  if (a > 0) {", new_string: "  if (a >= 1) {" };
		const d = await checkCoverageWrite(sourceEdit(edit), rules(), deps(stubRunner(held, {})), depView(["src/m.test.ts", "src/m.smoke.test.ts"]));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.join(" ")).toContain("re-anchored at 100.0%");
		expect(readFileCoverageBaselineEntry(root, SRC)).toEqual({ fraction: 1, scope: SCOPE_B });
	});

	it("N5: a NEW entry the runtime would write (bare number, or a well-formed scope) is not a finding", () => {
		const before = JSON.stringify({ "src/foo.ts": 0.9 });
		const after = JSON.stringify({ "src/foo.ts": 0.9, "src/new.ts": 0.4, "src/new2.ts": { f: 0.3, scope: SCOPE_B } });
		expect(detectBaselineGaming(BASELINE, before, after, () => true)).toEqual([]);
	});
});

// ---- round 2: the cross-scope high-water (harden-result.json stillBypassed) --

/** The raw on-disk ledger value for SRC (to pin the persisted `hw`). */
function rawEntry(): unknown {
	const data: unknown = JSON.parse(readFileSync(join(root, ".interlinked", "coverage-edit-baseline.json"), "utf-8"));
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>)[SRC] : undefined;
}

/** Per-line coverage at `covered`/`total`: lines 1..covered run (line 2, the
 *  edited one, always among them), the rest do not. */
function linesCov(covered: number, total: number) {
	const run = new Set<number>();
	const dead = new Set<number>();
	for (let ln = 1; ln <= total; ln++) (ln <= covered ? run : dead).add(ln);
	return { functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: (covered / total) * 100 }], coveredLines: run, uncoveredLines: dead };
}

const HOLD_EDIT = { old_string: "  if (a > 0) {", new_string: "  if (a >= 1) {" };
const HELD_COV = { functions: [{ name: "f", line: 1, endLine: 6, hits: 5, statement_pct: 100 }], coveredLines: new Set([2, 3, 5]), uncoveredLines: new Set<number>() };

describe("red-team 2026-10-21 round 2 — cross-scope high-water — positive (must block)", () => {
	it("P8: the verified full-first churn sequence (churn ⇒ full route, hold, narrow smoke test, regress)", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1, SCOPE_A);
		// Step 1+2: companion churned away (no test statically imports m.ts) ⇒ full route; a hold edit re-anchors at full.
		const seenFull: SeenSelection = {};
		const hold = await checkCoverageWrite(sourceEdit(HOLD_EDIT), rules(), deps(stubRunner(HELD_COV, seenFull)), depView([]));
		expect(seenFull.tests).toBeUndefined();
		expect(hold?.decision).toBe("allow");
		expect(rawEntry()).toEqual({ f: 1, scope: "full" });
		expect(readFileCoverageHighWater(root, SRC)).toBe(1);
		// Step 3: a narrow smoke test ⇒ scoped route; the flipped condition drops to 66.7%.
		const seenScoped: SeenSelection = {};
		const d = await checkCoverageWrite(sourceEdit(FLIP_EDIT), rules(), deps(stubRunner(FLIPPED_COV, seenScoped)), depView(["src/m.smoke.test.ts"]));
		expect(seenScoped.tests).toEqual(["src/m.smoke.test.ts"]);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("full-suite high-water 100.0% to 66.7%");
		expect(d?.reason).toContain("interlinked coverage check");
		expect(rawEntry()).toEqual({ f: 1, scope: "full" });
	});

	it("P9: a legacy bare-number entry, then a scoped regression (no churn needed)", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1);
		const d = await checkCoverageWrite(sourceEdit(FLIP_EDIT), rules(), deps(stubRunner(FLIPPED_COV, {})), depView(["src/m.smoke.test.ts"]));
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("full-suite high-water 100.0% to 66.7%");
		expect(rawEntry()).toBe(1);
	});

	it("P10: scoped → scoped downward with hw present, even when the drop is inside epsilon of the stored f", () => {
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.996, SCOPE_A);
		expect(rawEntry()).toEqual({ f: 0.996, scope: SCOPE_A, hw: 1 });
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, ...linesCov(993, 1000) };
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, SRC, cov, new Set([2]), out, SCOPE_B);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("full-suite high-water 100.0% to 99.3%");
		expect(out.now).toBeUndefined();
	});

	it("P11: a hand edit lowering (or deleting) hw is a baseline-integrity block", () => {
		const before = JSON.stringify({ "src/foo.ts": { f: 0.996, scope: SCOPE_A, hw: 1 } });
		const lowered = gate(before, '"hw":1', '"hw":0.996');
		expect(lowered?.decision).toBe("block");
		expect(lowered?.reason).toContain("[coverage-edit-hw:src/foo.ts]");
		const deleted = gate(before, ',"hw":1', "");
		expect(deleted?.decision).toBe("block");
		expect(deleted?.reason).toContain("[coverage-edit-hw:src/foo.ts]");
	});
});

describe("red-team 2026-10-21 round 2 — cross-scope high-water — negative (must not fire)", () => {
	it("N6: a selection change whose FULL measurement confirms hw is accepted and stored at scope full", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.996, SCOPE_A);
		const seen: SeenSelection = {};
		const d = await checkCoverageWrite(sourceEdit(HOLD_EDIT), rules(), deps(stubRunner(linesCov(997, 1000), seen)), depView([]));
		expect(seen.tests).toBeUndefined();
		expect(d?.decision).toBe("allow");
		expect(d?.warnings?.join(" ")).toContain("re-anchored at 99.7% (full)");
		expect(rawEntry()).toEqual({ f: 0.997, scope: "full", hw: 1 });
	});

	it("N7: an UPWARD re-anchor never needs the full route, and hw rides along", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.996, SCOPE_A);
		const d = await checkCoverageWrite(sourceEdit(HOLD_EDIT), rules(), deps(stubRunner(HELD_COV, {})), depView(["src/m.test.ts", "src/m.smoke.test.ts"]));
		expect(d?.decision).toBe("allow");
		expect(rawEntry()).toEqual({ f: 1, scope: SCOPE_B, hw: 1 });
	});

	it("N8: a brand-new file with no entry is measured and stored without a high-water", async () => {
		writeFileSync(join(root, SRC), SRC_BEFORE);
		const d = await checkCoverageWrite(sourceEdit(FLIP_EDIT), rules(), deps(stubRunner(FLIPPED_COV, {})), depView(["src/m.smoke.test.ts"]));
		expect(d).toBeNull();
		const scope = coverageScopeId(["src/m.smoke.test.ts"]);
		expect(rawEntry()).toEqual({ f: 2 / 3, scope });
		expect(readFileCoverageHighWater(root, SRC)).toBeNull();
	});
});

describe("red-team 2026-10-21 round 2 — class variants beyond the recorded inputs — positive (must block)", () => {
	it("V1: epsilon creep under ONE scope (each step inside epsilon of the last f) stops at hw - epsilon", () => {
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.996, SCOPE_A);
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, ...linesCov(992, 1000) };
		expect(decideFromCoverage(root, SRC, cov, new Set([2]), {}, SCOPE_A)?.decision).toBe("block");
	});

	it("V2: no ledger writer lowers hw — scoped, unscoped and lower full writes all retain it", () => {
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.4, SCOPE_A);
		writeFileCoverageBaseline(root, SRC, 0.3);
		writeFileCoverageBaseline(root, SRC, 0.2, "full");
		expect(readFileCoverageHighWater(root, SRC)).toBe(1);
		expect(rawEntry()).toEqual({ f: 0.2, scope: "full", hw: 1 });
		// A scope-less caller below hw is a full-route drop.
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, ...linesCov(400, 1000) };
		expect(decideFromCoverage(root, SRC, cov, new Set([2]), {})?.reason).toContain("its full-suite high-water");
	});

	it("V3: a hand edit that drops hw while RAISING f, or swaps the object for a bare number below hw", () => {
		const before = { "src/foo.ts": { f: 0.996, scope: SCOPE_A, hw: 1 } };
		const raisedNoHw = detectBaselineGaming(BASELINE, JSON.stringify(before), JSON.stringify({ "src/foo.ts": { f: 0.997, scope: SCOPE_A } }), () => true);
		expect(raisedNoHw.map((f) => f.rule)).toEqual(["coverage-edit-hw:src/foo.ts"]);
		const bare = detectBaselineGaming(BASELINE, JSON.stringify(before), JSON.stringify({ "src/foo.ts": 0.998 }), () => true);
		expect(bare.map((f) => f.rule)).toContain("coverage-edit-hw:src/foo.ts");
	});

	it("V4: a FULL-route measurement below hw (the forced full suite) is a real drop, not a re-anchor", () => {
		writeFileCoverageBaseline(root, SRC, 0.9, SCOPE_A);
		writeFileCoverageBaseline(root, SRC, 1, "full");
		writeFileCoverageBaseline(root, SRC, 0.996, SCOPE_B);
		const cov: PerFileCoverage = { filePath: SRC, mtime: 0, ...linesCov(980, 1000) };
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, SRC, cov, new Set([2]), out, "full");
		expect(d?.reason).toContain("from 100.0% to 98.0%, its full-suite high-water, measured under the full suite");
		expect(out.scopeChanged).toBeUndefined();
	});
});
