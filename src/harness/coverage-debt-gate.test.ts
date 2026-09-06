import { mkdtempSync, rmSync } from "node:fs";
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
	root = mkdtempSync(join(tmpdir(), "debt-gate-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function cfg(over: Partial<PerEditCoverageConfig> = {}): PerEditCoverageConfig {
	return { enabled: true, mode: "block", budget_ms: 25_000, languages: ["ts"], debt_mode: true, ...over };
}

function edit(file: string): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Edit", tool_input: { file_path: join(root, file) }, cwd: root, timestamp: "t" };
}

function bashEvent(): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command: "ls" }, cwd: root, timestamp: "t" };
}

/** A read-only Read carries `file_path` just like an Edit, but mutates nothing. */
function readEvent(file: string): HarnessEvent {
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Read", tool_input: { file_path: join(root, file) }, cwd: root, timestamp: "t" };
}

const uncovered = (file: string): HarnessDecision => ({
	decision: "block",
	reason: `[interlinked:coverage] BLOCKED: ${file} line 5 is executable but uncovered by the test suite after this edit.`,
	rule_id: "per-edit-coverage",
});

/** Mirrors coverage-write-decision's red-bar block verbatim enough to match. */
const redBar = (file: string): HarnessDecision => ({
	decision: "block",
	reason: `[interlinked:coverage] BLOCKED: your edit to ${file} leaves the test suite RED — 1 test is failing. Fix the failing test(s) before proceeding. Strict TDD: an edit may not save a transiently-red state.`,
	rule_id: "per-edit-coverage",
});

describe("applyDebtMode — pair A (source then test, two ordinary edits)", () => {
	it("opens debt + allows the first uncovered source edit, then discharges on the test", () => {
		// Edit 1 — uncovered source. OLD harness blocked here; now it ALLOWS.
		const e1 = applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(e1?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);

		// Edit 2 — the companion test. Base gate returns null (test not a target);
		// the wrapper optimistically discharges foo.ts's debt.
		const e2 = applyDebtMode(edit("src/foo.test.ts"), cfg(), null);
		expect(e2).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("discharges a decomposed-sibling debt when its UMBRELLA test is edited", () => {
		// Debt opens on a decomposed sibling…
		const e1 = applyDebtMode(edit("src/evaluator/foo-bar.ts"), cfg(), uncovered("src/evaluator/foo-bar.ts"));
		expect(e1?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);

		// …and editing the umbrella test under __tests__/ (NOT the co-located
		// sibling) discharges it via the umbrella-pair rule.
		const e2 = applyDebtMode(edit("src/evaluator/__tests__/foo.test.ts"), cfg(), null);
		expect(e2).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode — wandering blocks", () => {
	it("blocks an unrelated-file edit while debt is open", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("src/foo.ts");
	});

	it("WIP > 1 lets a second pair open instead of blocking", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg({ debt_wip_limit: 3 }), uncovered("src/bar.ts"));
		expect(out?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(2);
	});

	it("does NOT block a read-only Read of an unrelated file while debt is open", () => {
		// Open a debt on foo.ts, then READ an unrelated file. A read edits nothing,
		// so it must pass through — not be mis-read as an edit that "wanders" away
		// from the open pair (regression: the debt-lock was gating read-only calls).
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(readEvent("src/bar.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(1); // debt untouched by the read
	});
});

describe("applyDebtMode — red debt (the red→green loop, twin of coverage debt)", () => {
	it("downgrades a red-bar block to allow + opens a red_suite debt", () => {
		const out = applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		expect(out?.decision).toBe("allow");
		expect(out?.warnings?.[0]).toContain("red debt opened");
		const open = readOpenDebts(root);
		expect(open).toHaveLength(1);
		expect(open[0]?.kind).toBe("red_suite");
	});

	it("keeps ONE debt across same-pair red iterations (source and test edits)", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		// Still red after another source edit…
		expect(applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"))?.decision).toBe("allow");
		// …and after a companion-test edit that is itself still red.
		expect(applyDebtMode(edit("src/foo.test.ts"), cfg(), redBar("src/foo.test.ts"))?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);
	});

	it("blocks a wander to an unrelated file while the suite is red", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		const out = applyDebtMode(edit("src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("test suite is RED");
		expect(out?.reason).toContain("src/foo.ts");
	});

	it("discharges the red debt on the next same-pair non-red run", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		// The fix lands: overlay run no longer red (base verdict clean).
		const out = applyDebtMode(edit("src/foo.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
		// …and the agent is free to move on.
		expect(applyDebtMode(edit("src/bar.ts"), cfg(), null)).toBeNull();
	});

	it("a companion-test edit whose own verdict is STILL RED keeps the red debt open", () => {
		// The discharge key is the VERDICT, not the edit: a same-pair edit that
		// still comes back red continues the debt. (A non-red verdict — even one
		// with no run behind it — discharges; see the null-verdict test below.)
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		applyDebtMode(edit("src/foo.test.ts"), cfg(), redBar("src/foo.test.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
	});

	it("a companion-test edit with a NULL verdict (no run) DOES discharge the red debt", () => {
		// Deliberate optimism, pinned: red discharge keys on "verdict is not red",
		// NOT on "a suite actually ran". Pure-test-file plans are ungated (null
		// verdict), a budget defer returns null, a degrade allows — all read as
		// non-red, exactly like the happy path (source edit whose overlay runs
		// clean → null). The commit gate is the ground-truth backstop that
		// re-runs the suite. See docs/design/coverage-debt-tdd.md § Red debt.
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(edit("src/foo.test.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("a pass-through BLOCK (e.g. CRAP) does NOT discharge the red debt — the edit never lands", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		const crap: HarnessDecision = {
			decision: "block",
			reason: "[interlinked:coverage] BLOCKED: this edit leaves `fn` with CRAP 42 (threshold 30).",
			rule_id: "per-edit-coverage",
		};
		const out = applyDebtMode(edit("src/foo.ts"), cfg(), crap);
		expect(out?.decision).toBe("block"); // refused → disk unchanged
		expect(readOpenDebts(root)).toHaveLength(1); // red debt survives
	});

	it("ONE companion-test edit discharges BOTH a coverage debt and a red debt on the same file", () => {
		// Regression (id-keyed discharge): the discharged set was keyed by FILE,
		// so the recheck-discharged coverage debt hid the same file's red debt
		// from foldRedBar and it survived this call.
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts")); // coverage debt opens
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts")); // red debt joins it
		expect(readOpenDebts(root)).toHaveLength(2);
		const out = applyDebtMode(edit("src/foo.test.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0); // both gone in one call
	});

	it("red discharge and coverage open can land on the SAME edit (green but uncovered)", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), redBar("src/foo.ts"));
		const out = applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(out?.decision).toBe("allow"); // uncovered → coverage debt, not a block
		const open = readOpenDebts(root);
		expect(open).toHaveLength(1);
		expect(open[0]?.kind).toBe("coverage"); // red retired, coverage opened
	});

	it("debt_mode off preserves the strict red-bar unchanged", () => {
		const base = redBar("src/foo.ts");
		expect(applyDebtMode(edit("src/foo.ts"), cfg({ debt_mode: false }), base)).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode — pass-through (no debt logic)", () => {
	it("leaves a non-code file edit's verdict untouched", () => {
		const base = uncovered("docs/x.md");
		expect(applyDebtMode(edit("docs/x.md"), cfg(), base)).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("leaves a non-file (Bash) event untouched", () => {
		expect(applyDebtMode(bashEvent(), cfg(), null)).toBeNull();
	});

	it("is a no-op clean allow when there is no debt and no uncovered verdict", () => {
		expect(applyDebtMode(edit("src/foo.ts"), cfg(), null)).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("is a pure pass-through when debt_mode is off", () => {
		const base = uncovered("src/foo.ts");
		expect(applyDebtMode(edit("src/foo.ts"), cfg({ debt_mode: false }), base)).toBe(base);
		expect(readOpenDebts(root)).toHaveLength(0);
	});
});

describe("applyDebtMode — non-Claude edit verbs (canonical isFileWrite, not a hand-rolled set)", () => {
	// Copilot / Codex / Gemini emit str_replace / edit_file / … instead of
	// Write / Edit / MultiEdit. The hand-rolled set silently dropped them, so
	// debt-mode detection never engaged for those agents (baseline-review finding).
	const nonClaudeEdit = (file: string, toolName: string): HarnessEvent => ({
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "codex",
		tool_name: toolName,
		tool_input: { file_path: join(root, file) },
		cwd: root,
		timestamp: "t",
	});

	it("treats a str_replace edit as an edit (opens debt; pre-fix it fell through to the raw block)", () => {
		const out = applyDebtMode(nonClaudeEdit("src/foo.ts", "str_replace"), cfg(), uncovered("src/foo.ts"));
		expect(out?.decision).toBe("allow");
		expect(readOpenDebts(root)).toHaveLength(1);
	});

	it("treats an edit_file wander as an edit (blocks while a debt is open)", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(nonClaudeEdit("src/bar.ts", "edit_file"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("src/foo.ts");
	});
});

describe("applyDebtMode — failure-evidence relatedness (genomics/themes, end-to-end glue)", () => {
	// The reported false block, replayed through the REAL ledger + a stub
	// dependency view: editing curated/genomics.ts broke lib/server-counts.test.ts
	// (non-colocated; it imports genomics.ts AND themes.ts). The fix lives in
	// themes.ts — under the pair rule a "wander", under evidence relatedness the
	// same red episode.
	const GENOMICS = "server/curated/genomics.ts";
	const THEMES = "lib/themes.ts";
	const COUNTS_TEST = "lib/server-counts.test.ts";

	/** A red-bar verdict carrying the failing-test files the runner parsed. */
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

	/** themes.ts and genomics.ts are both imported by the counts test. */
	const repoView = (): DependencyView =>
		view({
			[join(root, THEMES)]: [join(root, COUNTS_TEST)],
			[join(root, GENOMICS)]: [join(root, COUNTS_TEST)],
			[join(root, COUNTS_TEST)]: [],
		});

	it("records the failing-test evidence on the opened red debt", () => {
		const out = applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		expect(out?.decision).toBe("allow");
		const debts = readOpenDebts(root);
		expect(debts).toHaveLength(1);
		expect(debts[0]?.failingTestFiles).toEqual([COUNTS_TEST]);
	});

	it("allows the cross-module themes.ts edit while red (the reported false block)", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const out = applyDebtMode(edit(THEMES), cfg(), null, repoView());
		expect(out).toBeNull(); // in-cone landing edit — allowed, and the episode discharges
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("keeps the episode open (no stacked debt) when the in-cone edit is still red", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const out = applyDebtMode(edit(THEMES), cfg(), redBarWith(THEMES, [COUNTS_TEST]), repoView());
		expect(out?.decision).toBe("allow");
		const debts = readOpenDebts(root);
		expect(debts).toHaveLength(1);
		expect(debts[0]?.file).toBe(GENOMICS);
	});

	// ===========================================
	// Coverage debts get graph adjacency too
	// ===========================================
	//
	// A red_suite debt has always had graph-aware relatedness via its recorded
	// failing tests. A `coverage` debt carries no such evidence, so relatedness
	// fell back to the filename pair alone and a coordinated change across an
	// import edge read as a wander — neither file can go green by itself, yet
	// the gate demanded one be finished before the other was touched.

	it("P1: allows editing a direct IMPORTER of a file with open coverage debt", () => {
		// counts.test imports themes; debt is on themes.
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(edit(COUNTS_TEST), cfg(), null, repoView());
		expect(out?.decision).not.toBe("block");
	});

	it("P2: allows editing a direct IMPORTEE of a file with open coverage debt", () => {
		// Debt on the importer (counts.test); the edit lands on what it imports.
		applyDebtMode(edit(COUNTS_TEST), cfg(), uncovered(COUNTS_TEST));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(edit(THEMES), cfg(), null, repoView());
		expect(out?.decision).not.toBe("block");
	});

	it("N1: still blocks a graph-UNRELATED edit while coverage debt is open", () => {
		// genomics and themes share no import edge — the WIP limit still bites.
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		const out = applyDebtMode(edit(GENOMICS), cfg(), null, repoView());
		expect(out?.decision).toBe("block");
	});

	it("N2: unknown graph must not widen — no view means the legacy rule applies", () => {
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		const out = applyDebtMode(edit(GENOMICS), cfg(), null);
		expect(out?.decision).toBe("block");
	});

	it("N3: a seed-only backend is treated as unknown, never as adjacency", () => {
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		const seedOnly: DependencyView = {
			...repoView(),
			answerScope: "seed-only",
		};
		const out = applyDebtMode(edit(GENOMICS), cfg(), null, seedOnly);
		expect(out?.decision).toBe("block");
	});

	it("N4: adjacency is ONE hop — it does not dissolve the WIP limit", () => {
		// a → b → c: editing `a` is not related to a debt on `c`.
		const A = "lib/a.ts";
		const B = "lib/b.ts";
		const C = "lib/c.ts";
		const chain = view({
			[join(root, C)]: [join(root, B)],
			[join(root, B)]: [join(root, A)],
			[join(root, A)]: [],
		});
		applyDebtMode(edit(C), cfg(), uncovered(C));
		const out = applyDebtMode(edit(A), cfg(), null, chain);
		expect(out?.decision).toBe("block");
	});

	it("allows editing the non-colocated failing test itself — no graph required", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const out = applyDebtMode(edit(COUNTS_TEST), cfg(), null);
		expect(out).toBeNull();
	});

	it("still blocks a genuinely unrelated edit, naming the real failing test — not a phantom companion", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const out = applyDebtMode(edit("lib/unrelated.ts"), cfg(), null, repoView());
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("test suite is RED");
		expect(out?.reason).toContain(COUNTS_TEST);
		expect(out?.reason).not.toContain("genomics.test.ts");
		expect(out?.reason).toContain("debt_wip_limit"); // discoverable, recorded escape
	});

	it("falls back to the strict pair rule when no dependency view is available (unknown never widens)", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const out = applyDebtMode(edit(THEMES), cfg(), null);
		expect(out?.decision).toBe("block");
	});

	it("evidence survives the ledger round-trip (JSONL write → readOpenDebts)", () => {
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST, "lib/other.test.ts"]));
		const debts = readOpenDebts(root);
		expect(debts[0]?.failingTestFiles).toEqual([COUNTS_TEST, "lib/other.test.ts"]);
	});

	// ===========================================
	// A thrown dependency-view query must degrade to "unknown", not crash
	// ===========================================
	//
	// Both graph queries (adjacency for coverage debts, affected-tests for
	// red-suite debts) are wrapped in their own try/catch specifically because
	// the daemon's real `ProjectGraph` can throw mid-query (a stale index, a
	// cyclic-walk edge case). Unknown must degrade the SAME way a missing view
	// does (strict pair rule, never a crash and never a false "related").

	it("adjacency falls back to unknown (not a crash) when the dependency graph throws", () => {
		// Coverage debt only (no red_suite evidence) — affectedTestsForEdit's
		// `hasEvidence` gate is false, so it returns null before ever touching
		// the view. This isolates the failure to adjacentDebtFilesForEdit.
		applyDebtMode(edit(THEMES), cfg(), uncovered(THEMES));
		expect(readOpenDebts(root)).toHaveLength(1);
		const brokenView: DependencyView = {
			answerScope: "repo",
			source: "internal",
			getDependents: () => {
				throw new Error("graph corrupted");
			},
			hasFile: () => {
				throw new Error("graph corrupted");
			},
			classifyModule: () => "leaf",
			getBlastRadius: () => ({ direct: 0, transitive: 0, domains: [] }),
			getCallers: () => [],
		};
		// P1 (above) proves this exact edit — COUNTS_TEST imports THEMES — is
		// ALLOWED via adjacency when the view answers normally. Here the view
		// throws instead: if adjacentDebtFilesForEdit's catch were removed, the
		// thrown error would propagate out of applyDebtMode uncaught and this
		// assertion would never run. Catching it degrades to the strict pair
		// rule instead, so the edit blocks like the graph was never available.
		const out = applyDebtMode(edit(COUNTS_TEST), cfg(), null, brokenView);
		expect(out?.decision).toBe("block");
	});

	it("affected-test selection falls back to unknown (not a crash) when the graph throws mid-walk", () => {
		// Red debt WITH failing-test evidence, so affectedTestsForEdit's
		// `hasEvidence` gate is true and it actually calls selectAffectedTests
		// (which queries the view) instead of short-circuiting to null first.
		applyDebtMode(edit(GENOMICS), cfg(), redBarWith(GENOMICS, [COUNTS_TEST]));
		const flakyView: DependencyView = {
			...repoView(),
			getDependents: () => {
				throw new Error("graph corrupted");
			},
			hasFile: () => {
				throw new Error("graph corrupted");
			},
		};
		// Without the throw, this exact edit is allowed: THEMES imports into
		// COUNTS_TEST, the red debt's own recorded failing test (see "allows the
		// cross-module themes.ts edit while red" above). If
		// affectedTestsForEdit's catch were removed, selectAffectedTests's
		// thrown error would propagate out of applyDebtMode uncaught, before
		// adjacentDebtFilesForEdit even runs — this assertion would never see a
		// decision at all. Catching it degrades relatedness to unknown, so the
		// strict pair rule blocks and names the real red debt.
		const out = applyDebtMode(edit(THEMES), cfg(), null, flakyView);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain(GENOMICS);
	});
});

describe("applyDebtMode — non-product paths are outside the debt domain (2026-07-17)", () => {
	it("does not wander-block a scratch/ probe write while debt is open", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		expect(readOpenDebts(root)).toHaveLength(1);
		const out = applyDebtMode(edit("scratch/probe.mjs"), cfg(), null);
		expect(out).toBeNull(); // exempt from the focus rule — no block, no note
	});

	it("neither opens debt nor blocks for a scratch/ write", () => {
		const out = applyDebtMode(edit("scratch/probe.ts"), cfg(), null);
		expect(out).toBeNull();
		expect(readOpenDebts(root)).toHaveLength(0);
	});

	it("does not wander-block a .interlinked/ tool-state write while debt is open", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit(".interlinked/probe.mjs"), cfg(), null);
		expect(out).toBeNull();
	});

	it("keeps a nested src/scratch/ module IN the debt domain", () => {
		applyDebtMode(edit("src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(edit("src/scratch/module.ts"), cfg(), null);
		expect(out?.decision).toBe("block"); // not the root probe dir — still a wander
	});
});

describe("applyDebtMode — foreign-session debts (ownership scoping, 2026-07-17)", () => {
	function editAs(session: string, file: string): HarnessEvent {
		return { ...edit(file), session_id: session };
	}

	beforeEach(() => {
		resetForeignDebtNotesForTests();
	});

	it("warns once for a foreign debt, then stays quiet for the same (session, debt)", () => {
		applyDebtMode(editAs("owner", "src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const first = applyDebtMode(editAs("visitor", "src/bar.ts"), cfg(), null);
		expect(first?.decision).toBe("allow");
		expect(first?.warnings?.[0]).toContain("another session");
		expect(first?.warnings?.[0]).toContain("src/foo.ts");
		const second = applyDebtMode(editAs("visitor", "src/baz.ts"), cfg(), null);
		expect(second).toBeNull(); // dedup'd — quiet allow
	});

	it("still blocks the owner session's own wander", () => {
		applyDebtMode(editAs("owner", "src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		const out = applyDebtMode(editAs("owner", "src/bar.ts"), cfg(), null);
		expect(out?.decision).toBe("block");
		expect(out?.reason).toContain("src/foo.ts");
	});

	it("gives each visiting session its own single note (per-session dedup key)", () => {
		applyDebtMode(editAs("owner", "src/foo.ts"), cfg(), uncovered("src/foo.ts"));
		applyDebtMode(editAs("visitor-a", "src/bar.ts"), cfg(), null);
		const b = applyDebtMode(editAs("visitor-b", "src/bar2.ts"), cfg(), null);
		expect(b?.decision).toBe("allow");
		expect(b?.warnings?.[0]).toContain("another session");
	});
});
