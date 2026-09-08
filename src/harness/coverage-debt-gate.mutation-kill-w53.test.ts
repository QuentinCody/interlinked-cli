// Wave pass1_w53 mutation-kill suite for coverage-debt-gate.ts.
// Each test is aimed at ONE (or a tightly-related pair of) surviving mutant(s)
// from scratch/fleet-r3/w53-briefs/src_harness_coverage-debt-gate.ts.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDebtMode, resetForeignDebtNotesForTests } from "./coverage-debt-gate.js";
import type { DependencyView } from "./dependency-view.js";
import { readOpenDebts } from "./obligation-ledger-io.js";
import type { PerEditCoverageConfig } from "./types/config.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "debt-gate-w53-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cfg(over: Partial<PerEditCoverageConfig> = {}): PerEditCoverageConfig {
	return { enabled: true, mode: "block", budget_ms: 25_000, languages: ["ts"], debt_mode: true, ...over };
}

function edit(file: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: join(root, file) },
		cwd: root,
		timestamp: "t",
	};
}

const uncovered = (file: string): HarnessDecision => ({
	decision: "block",
	reason: `[interlinked:coverage] BLOCKED: ${file} line 5 is executable but uncovered by the test suite after this edit.`,
	rule_id: "per-edit-coverage",
});

const redBar = (file: string): HarnessDecision => ({
	decision: "block",
	reason: `[interlinked:coverage] BLOCKED: your edit to ${file} leaves the test suite RED — 1 test is failing. Fix the failing test(s) before proceeding. Strict TDD: an edit may not save a transiently-red state.`,
	rule_id: "per-edit-coverage",
});

const redBarWith = (file: string, failing: string[]): HarnessDecision => ({
	...redBar(file),
	failing_test_files: failing,
});

/** Internal-shaped view over an absolute-path reverse-import edge map. */
const view = (edges: Record<string, string[]>): DependencyView => ({
	answerScope: "repo",
	source: "internal",
	getDependents: (f) => edges[f] ?? [],
	hasFile: (f) => f in edges,
	classifyModule: () => "leaf",
	getBlastRadius: () => ({ direct: 0, transitive: 0, domains: [] }),
	getCallers: () => [],
});

describe("resetForeignDebtNotesForTests — mutantId 1dddba637422f9c6 (BlockStatement)", () => {
	function editAs(session: string, file: string): HarnessEvent {
		return { ...edit(file), session_id: session };
	}

	// test-contract: public-api — resetForeignDebtNotesForTests is the documented
	// test hook for clearing the module-private dedup set (coverage-debt-gate.ts
	// doc comment); its effect must be observable through applyDebtMode's output.
	it("actually clears the dedup set — the same (session, debt) pair notes again after reset", () => {
		applyDebtMode(editAs("owner", "src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const first = applyDebtMode(editAs("visitor", "src/bar.ts"), cfg(), null);
		expect(first?.warnings?.[0]).toContain("another session");
		// Reset — the empty-body mutant would leave the dedup set intact, so the
		// SAME (session, debt) pair would stay quiet instead of noting again.
		resetForeignDebtNotesForTests();
		const second = applyDebtMode(editAs("visitor", "src/baz.ts"), cfg(), null);
		expect(second?.decision).toBe("allow");
		expect(second?.warnings?.[0]).toContain("another session");
	});
});

describe("strField — mutantId 4828f844c88bc4e7 (ConditionalExpression)", () => {
	// test-contract: boundary — hook payloads are untyped JSON; tool_input.file_path
	// can arrive as any JSON type. strField's typeof guard is the boundary check.
	it("ignores a non-string file_path instead of coercing it (typeof guard matters)", () => {
		const base = uncovered("src/foo.ts");
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: { file_path: 42 },
			cwd: root,
			timestamp: "t",
		};
		const out = applyDebtMode(ev, cfg(), base);
		expect(out).toBe(base); // no usable name → pass-through unchanged
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("editedCodeFile — mutantId 0d4b3fd9e8b8a35a (CODE_RX guard)", () => {
	// test-contract: invariant — editedCodeFile's doc comment scopes the debt
	// domain to code files (CODE_RX), independent of isCappableFile's size skip.
	it("excludes a non-JS/TS file (.py) from the debt domain entirely", () => {
		// .py isn't caught by isCappableFile's size-skip list, so ONLY the
		// CODE_RX guard keeps it out of debt tracking.
		const base = uncovered("src/foo.py");
		const out = applyDebtMode(edit("src/foo.py"), cfg(), base);
		expect(out).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("adjacentDebtFilesForEdit — mutantIds 65f5e21d20cab138 + 5c495146a751f3f1", () => {
	const THEMES = "lib/themes.ts";
	const COUNTS_TEST = "lib/server-counts.test.ts";

	// test-contract: invariant — adjacentDebtFilesForEdit's doc comment: "Unknown
	// must never WIDEN"; a seed-only backend must be treated as unknown.
	it("treats a seed-only view as unknown even when its edges show real adjacency", () => {
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		expect(readOpenDebts(root)).toHaveLength(1);
		const repoEdges = view({ [join(root, THEMES)]: [join(root, COUNTS_TEST)] });
		const seedOnly: DependencyView = { ...repoEdges, answerScope: "seed-only" };
		// COUNTS_TEST IS a direct dependent of THEMES in these edges, so a
		// mutant that ignores the scope check would wrongly call it adjacent
		// and allow. Correctly, seed-only must fall back to the strict pair
		// rule and block.
		const out = applyDebtMode(edit(COUNTS_TEST), cfg(), null, seedOnly);
		expect(out?.decision).toBe("block");
	});
});

describe("adjacentDebtFilesForEdit — mutantId c175ff173d34667c (!depView.hasFile(absEdited))", () => {
	// test-contract: bug — adjacentDebtFilesForEdit's comment on the ABSOLUTE
	// vs relative key mismatch footgun: an edited file absent from `hasFile`
	// must read as unknown, never as adjacent via an unrelated debt's edges.
	it("treats an edited file NOT known to the graph as unknown, not as adjacent by coincidence", () => {
		const COUNTS_TEST = "lib/server-counts.test.ts";
		applyDebtMode(edit(COUNTS_TEST), cfg(), uncovered(COUNTS_TEST));
		expect(readOpenDebts(root)).toHaveLength(1);
		const editedAbs = join(root, "src/unknown.ts");
		// The edited file is absent from `hasFile`, but COUNTS_TEST's own
		// dependents list happens to include it — a mutant that skips the
		// hasFile(absEdited) guard would read that coincidence as adjacency.
		const v: DependencyView = {
			answerScope: "repo",
			source: "internal",
			getDependents: (f) => (f === join(root, COUNTS_TEST) ? [editedAbs] : []),
			hasFile: (f) => f === join(root, COUNTS_TEST),
			classifyModule: () => "leaf",
			getBlastRadius: () => ({ direct: 0, transitive: 0, domains: [] }),
			getCallers: () => [],
		};
		const out = applyDebtMode(edit("src/unknown.ts"), cfg(), null, v);
		expect(out?.decision).toBe("block");
	});
});

describe("affectedTestsForEdit hasEvidence gate — mutantId 064ee82461538c7c (some -> every)", () => {
	const GENOMICS = "server/curated/genomics.ts";
	const THEMES = "lib/themes.ts";
	const COUNTS_TEST = "lib/server-counts.test.ts";
	const UNRELATED = "lib/unrelated.ts";

	// test-contract: invariant — affectedTestsForEdit's doc comment: "Computed
	// ONLY when SOME open red debt actually carries failing-test evidence" —
	// existence of one such debt is the trigger, not unanimity across all debts.
	it("ANY red debt with evidence is enough to enable evidence-cone selection, not ALL open debts", () => {
		// Debt 1: red_suite WITH real evidence — matches the predicate.
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		// Debt 2: an unrelated COVERAGE debt — does NOT match the predicate
		// (wrong kind). Under `.some()` hasEvidence is still true (debt 1
		// alone is enough); under `.every()` it flips false.
		applyDebtMode(edit(UNRELATED), cfg({ debt_wip_limit: 5 }), uncovered(UNRELATED));
		expect(readOpenDebts(root)).toHaveLength(2);

		const repoEdges = view({
			[join(root, THEMES)]: [join(root, COUNTS_TEST)],
			[join(root, GENOMICS)]: [join(root, COUNTS_TEST)],
			[join(root, COUNTS_TEST)]: [],
		});
		// THEMES is graph-adjacent to neither open debt, and shares no filename
		// pair with either — the ONLY route to "allow" is the evidence cone
		// (THEMES → COUNTS_TEST, which is genomics's recorded failing test).
		const out = applyDebtMode(edit(THEMES), cfg({ debt_wip_limit: 5 }), null, repoEdges);
		expect(out?.decision).not.toBe("block");
	});
});

describe("affectedTestsForEdit's failingTestFiles?.length — mutantId 450da460933eca5b", () => {
	// test-contract: bug — a red_suite debt opened before any failing-test
	// evidence is recorded (redBar() with no failing_test_files) must not crash
	// the gate; failingTestFiles is documented as optional on Obligation.
	it("does not throw when an open red debt carries no failing-test evidence", () => {
		// redBar() carries no failing_test_files, so the ledger's red_suite
		// debt has `failingTestFiles` left undefined.
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		expect(readOpenDebts(root)[0]?.failingTestFiles).toBeUndefined();
		const v: DependencyView = {
			answerScope: "repo",
			source: "internal",
			getDependents: () => [],
			hasFile: () => true,
			classifyModule: () => "leaf",
			getBlastRadius: () => ({ direct: 0, transitive: 0, domains: [] }),
			getCallers: () => [],
		};
		// Removing the `?.` turns `d.failingTestFiles.length` into a crash on
		// `undefined.length` inside the hasEvidence `.some()` — which sits
		// OUTSIDE the function's try/catch.
		expect(() => applyDebtMode(edit("src/bar.ts"), cfg(), null, v)).not.toThrow();
	});
});

describe("applyDebtMode's own projectRoot guard — mutantId 5fa116cebae57b9f (!projectRoot)", () => {
	// test-contract: boundary — HarnessEvent.cwd is optional (types/events.ts);
	// applyDebtMode's own comment: "no cwd ⇒ can't resolve the ledger; pass through".
	it("passes through cleanly (never throws) when the event carries no cwd", () => {
		const base = uncovered("src/foo.ts");
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "s",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: { file_path: "src/foo.ts" },
			timestamp: "t",
			// no cwd
		};
		expect(() => applyDebtMode(ev, cfg(), base)).not.toThrow();
		expect(applyDebtMode(ev, cfg(), base)).toBe(base);
	});
});

describe("applyDebtMode's clean fast-path — mutantId 0429499fb4653528 (BlockStatement)", () => {
	// test-contract: public-api — applyDebtMode's return type is `HarnessDecision
	// | null`; the clean fast-path must return the base decision, never undefined.
	it("returns the exact base decision object on the no-debt clean path, not undefined", () => {
		const base: HarnessDecision = { decision: "allow", warnings: ["from-lint"] };
		const out = applyDebtMode(edit("src/foo.ts"), cfg(), base);
		expect(out).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode's recheck loop — mutantId 25818b08ea6812e1 (inSamePair -> true)", () => {
	// test-contract: invariant — the optimistic-discharge comment above
	// applyDebtMode: discharge requires `inSamePair`, a real pairing check, not
	// "any test file edit discharges any open debt".
	it("does not discharge a debt when the edited test file is genuinely unrelated to it", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
		// A DIFFERENT test file, not foo's companion or umbrella.
		const out = applyDebtMode(edit("src/zzz-totally-unrelated.test.ts"), cfg(), null);
		expect(readOpenDebts(root)).toHaveLength(1); // still open — no false discharge
		expect(out?.decision).toBe("block"); // and it reads as a wander
	});
});

describe("redWanderGuidance fileExists probe — mutantId c84de753310a864e (ArrowFunction)", () => {
	// test-contract: bug — coverage-debt.ts's redWanderGuidance comment: "a
	// phantom genomics.test.ts sends the agent to green a file that isn't
	// there" — the message must reflect the REAL filesystem, not guess.
	it("names the real companion test file when it actually exists on disk", () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "foo.test.ts"), "test('x', () => {});\n");
		// Red debt with NO failing-test evidence and a non-test-named file, so
		// redWanderGuidance falls through to the fileExists-gated branch.
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("its test (src/foo.test.ts)");
		expect(out?.reason).not.toContain("no src/foo.test.ts exists");
	});

	// test-contract: bug — same fileExists contract, negative direction: no
	// file on disk must not falsely claim "its test (...)" exists.
	it("says the companion test doesn't exist when it genuinely doesn't", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("no src/foo.test.ts exists");
	});
});

describe("CODE_RX — mutantIds ef120eb5b9a7828d + 92d3ab56b8b04ca8 (Regex)", () => {
	// test-contract: invariant — CODE_RX is anchored with `$`; a code-looking
	// substring earlier in the path must not qualify a non-code file.
	it("requires the code extension at the true end of the path (drop-$ mutant)", () => {
		const base = uncovered("src/foo.ts.bak");
		const out = applyDebtMode(edit("src/foo.ts.bak"), cfg(), base);
		expect(out).toBe(base); // .bak, not .ts — pass-through unchanged
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	// test-contract: invariant — CODE_RX's `[cm]?` prefix documents .mjs/.cjs
	// as recognized JS variants alongside .js/.ts.
	it("accepts the [cm]? prefix — .mjs is a code file (negated-class mutant)", () => {
		const base = uncovered("src/foo.mjs");
		const out = applyDebtMode(edit("src/foo.mjs"), cfg(), base);
		expect(out).not.toBe(base); // .mjs IS a code file → debt-mode engages
		expect(out?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);
	});
});

describe("TEST_RX — mutantIds 6c9b2deedb4a0290 + 901d34ef1003e3d4 (Regex)", () => {
	// test-contract: invariant — TEST_RX is anchored with `$`; combined with
	// TOOL_STATE_PATH_RE exemption, an embedded ".test." substring earlier in
	// a .interlinked/ path must not make it look like a real test file.
	it("keeps a tool-state path exempt despite an embedded .test. substring (drop-$ mutant)", () => {
		const rel = ".interlinked/foo.test.ts.js";
		const base = uncovered(rel);
		const out = applyDebtMode(edit(rel), cfg(), base);
		expect(out).toBe(base); // tool-state path stays exempt — pass-through unchanged
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	// test-contract: invariant — TEST_RX's `[cm]?` prefix must recognize
	// .test.mjs/.test.cjs companion tests, same as .test.ts/.test.js.
	it("accepts the [cm]? prefix for .test.mjs companion tests (negated-class mutant)", () => {
		applyDebtMode(edit("src/foo.mjs"), cfg(), uncovered("src/foo.mjs"));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(edit("src/foo.test.mjs"), cfg(), null);
		expect(readOpenDebts(root)).toHaveLength(0); // discharged by its companion test
		expect(out).toBeNull();
	});
});
