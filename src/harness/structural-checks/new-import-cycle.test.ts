// Behavioral companion tests for checkNewImportCycle (new-import-cycle.ts).
//
// Delta semantics: the function keeps its own cross-call snapshot of each
// file's resolved import targets (the graph itself has already been
// re-indexed to the POST-edit state by the time this check runs, so there is
// nowhere else to read "what did this file import before this edit" from).
// Every scenario below therefore drives the function across two sequential
// calls against a mutable fake graph: call 1 primes the snapshot, call 2
// exercises the comparison.
//
// Check Evidence Contract (post / default-gate tier: 2 positive / 2 negative
// minimum) — this file carries 3 positive / 5 negative labeled cases.

import { beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { HarnessEvent } from "../types.js";
import type { ImportEdge } from "../types/graph.js";
import { __resetNewImportCycleSnapshotForTesting, checkNewImportCycle } from "./new-import-cycle.js";

const A = "/repo/src/a.ts";
const B = "/repo/src/b.ts";
const C = "/repo/src/c.ts";

/** Minimal resolved import edge — only `toFile` matters to this check. */
function edge(toFile: string): ImportEdge {
	return { fromFile: A, toFile, specifier: toFile, symbols: [], isTypeOnly: false };
}

/** Minimal PostToolUse-shaped event; only `dry_run` matters to this check. */
function evt(dryRun?: boolean): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s1",
		agent_source: "claude",
		timestamp: "2026-08-17T00:00:00Z",
		// exactOptionalPropertyTypes: only include the key when a caller
		// actually passed a value — `dry_run: undefined` is a type error.
		...(dryRun !== undefined ? { dry_run: dryRun } : {}),
	};
}

/** Mutable graph-shape state a test edits between calls to simulate an edit landing. */
interface GraphState {
	deps: Record<string, ImportEdge[]>;
	cycles: Record<string, string[][]>;
}

/**
 * Mutable ProjectGraph stand-in exposing only the three members
 * checkNewImportCycle touches: getDependencies (the post-edit resolved
 * edges), findCyclesThrough (the whole-state cycle set), and toRelative.
 * `state` is a plain object the test mutates BETWEEN calls to simulate "the
 * edit landed" — mirrors the fakeGraph idiom used throughout
 * structural-checks/*.test.ts (e.g. cycles.test.ts).
 */
function fakeGraph(state: GraphState): Pick<ProjectGraph, "getDependencies" | "findCyclesThrough" | "toRelative"> {
	return {
		getDependencies: (f: string): ImportEdge[] => state.deps[f] ?? [],
		findCyclesThrough: (f: string): string[][] => state.cycles[f] ?? [],
		toRelative: (f: string): string => f.replace(/^\/repo\//, ""),
	};
}

beforeEach(() => {
	__resetNewImportCycleSnapshotForTesting();
});

describe("checkNewImportCycle — positive (must fire)", () => {
	// test-contract: public-api — checkNewImportCycle must emit a
	// new_import_cycle warning naming the shortest new cycle path when an
	// edit adds the import that closes a 2-node loop (plan 25 lane 5 spec).
	it("P1: fires when an edit closes a 2-node cycle (A → B → A)", () => {
		const state: GraphState = { deps: { [A]: [] }, cycles: {} };
		const graph = fakeGraph(state);

		// Call 1: A imports nothing yet — primes the baseline.
		const primed = checkNewImportCycle(A, "src/a.ts", evt(), graph);
		expect(primed).toEqual([]);

		// Edit: A gains a new import of B. B already imports A (unaffected by
		// this edit), so the graph now reports a 2-node cycle through A.
		state.deps[A] = [edge(B)];
		state.cycles[A] = [[A, B, A]];

		const results = checkNewImportCycle(A, "src/a.ts", evt(), graph);
		expect(results).toHaveLength(1);
		const r = nonNull(results[0]);
		expect(r.check).toBe("new_import_cycle");
		expect(r.severity).toBe("warning");
		expect(r.file).toBe(A);
		expect(r.affectedFiles).toEqual([A, B, A]);
		expect(r.message).toContain("src/a.ts → src/b.ts → src/a.ts");
	});

	// test-contract: public-api — same contract, a 3-node loop, so the
	// resolve-and-DFS path is proven for more than the minimal cycle length.
	it("P2: fires when an edit closes a 3-node cycle (A → B → C → A)", () => {
		const state: GraphState = { deps: { [A]: [] }, cycles: {} };
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(), graph); // prime

		// Edit: A gains a new import of B. B → C → A already exists elsewhere
		// in the graph (unaffected by this edit).
		state.deps[A] = [edge(B)];
		state.cycles[A] = [[A, B, C, A]];

		const results = checkNewImportCycle(A, "src/a.ts", evt(), graph);
		expect(results).toHaveLength(1);
		const r = nonNull(results[0]);
		expect(r.affectedFiles).toEqual([A, B, C, A]);
		expect(r.message).toContain("src/a.ts → src/b.ts → src/c.ts → src/a.ts");
	});

	// test-contract: invariant — exactly one warning per call (never one per
	// cycle), and it must be the SHORTEST new cycle, mirroring the sibling
	// checkImportCycles' shortest-cycle-wins contract in cycles.ts.
	it("P3: among multiple new cycles, reports only the shortest", () => {
		const state: GraphState = { deps: { [A]: [] }, cycles: {} };
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(), graph); // prime — baseline has no imports

		// Edit adds imports of BOTH B and C in one call; each independently
		// closes its own new cycle back to A.
		state.deps[A] = [edge(B), edge(C)];
		state.cycles[A] = [
			[A, B, C, A], // longer, via B
			[A, C, A], // shorter, via C
		];

		const results = checkNewImportCycle(A, "src/a.ts", evt(), graph);
		expect(results).toHaveLength(1);
		const r = nonNull(results[0]);
		expect(r.affectedFiles).toEqual([A, C, A]);
		expect(r.message).toContain("src/a.ts → src/c.ts → src/a.ts");
		expect(r.message).not.toContain("src/b.ts");
	});
});

describe("checkNewImportCycle — negative (must not fire)", () => {
	// test-contract: boundary — a new import that closes no loop must never
	// be reported; only cycle-closing imports are in scope for this check.
	it("N1: a non-cycle import addition stays silent", () => {
		const state: GraphState = { deps: { [A]: [] }, cycles: {} };
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(), graph); // prime

		// Edit: A gains a new import of B, but nothing leads back to A.
		state.deps[A] = [edge(B)];
		state.cycles[A] = [];

		expect(checkNewImportCycle(A, "src/a.ts", evt(), graph)).toEqual([]);
	});

	// test-contract: public-api — the check's whole reason to exist
	// (distinct from circular_imports) is silence on debt this edit did not
	// introduce; a cycle already present at priming time must never re-fire.
	it("N2: a cycle that already existed before this edit stays silent", () => {
		// Baseline call already sees A importing B, and the cycle already
		// exists at priming time — this is pre-existing debt, not this edit's.
		const state: GraphState = { deps: { [A]: [edge(B)] }, cycles: { [A]: [[A, B, A]] } };
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(), graph); // prime — snapshot now has {B}

		// "Edit" leaves A's imports and the cycle unchanged (e.g. an unrelated
		// line in the file changed).
		expect(checkNewImportCycle(A, "src/a.ts", evt(), graph)).toEqual([]);
	});

	// test-contract: boundary — an edge with an empty toFile (unresolved bare
	// specifier) must be filtered out of the target set rather than crashing
	// or being treated as a real, comparable import target.
	it("N3: an unresolvable import is skipped, never crashes, never counts as a target", () => {
		const state: GraphState = { deps: { [A]: [edge("")] }, cycles: {} }; // bare/unresolved specifier
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(), graph); // prime

		expect(() => checkNewImportCycle(A, "src/a.ts", evt(), graph)).not.toThrow();
		expect(checkNewImportCycle(A, "src/a.ts", evt(), graph)).toEqual([]);
	});

	// test-contract: invariant — with no prior snapshot for this file this
	// daemon lifetime, the check cannot attribute a cycle to THIS edit, so it
	// must stay silent rather than guess — that whole-state debt belongs to
	// circular_imports (checkImportCycles), not this delta check.
	it("N4: the first time a file is seen this daemon lifetime, stays silent even if a cycle is already present", () => {
		const state: GraphState = { deps: { [A]: [edge(B)] }, cycles: { [A]: [[A, B, A]] } };
		const graph = fakeGraph(state);

		// First-ever call for A after a reset — no prior snapshot exists.
		expect(checkNewImportCycle(A, "src/a.ts", evt(), graph)).toEqual([]);
	});

	// test-contract: bug — regression guard for the class documented in
	// CLAUDE.md "A dry run must not move the gate": `interlinked harness
	// test` sets event.dry_run, and a check that persists cross-call state
	// must not let a hypothetical probe advance that state. Without the
	// event.dry_run guard, the preview call below would seed {B} into the
	// snapshot and the following REAL call would wrongly stay silent.
	it("N5: a dry-run probe never advances the persisted baseline, so a later real edit with the same new edge still fires", () => {
		const state: GraphState = { deps: { [A]: [] }, cycles: {} };
		const graph = fakeGraph(state);

		checkNewImportCycle(A, "src/a.ts", evt(false), graph); // prime for real

		// A dry-run probe (`interlinked harness test`) previews the same edit
		// that would close a cycle.
		state.deps[A] = [edge(B)];
		state.cycles[A] = [[A, B, A]];
		const preview = checkNewImportCycle(A, "src/a.ts", evt(true), graph);
		expect(preview).toHaveLength(1); // the preview itself is still informative

		// The REAL edit lands next, with the identical resulting state. If the
		// dry run above had corrupted the snapshot to already include B, this
		// call would wrongly stay silent.
		const real = checkNewImportCycle(A, "src/a.ts", evt(false), graph);
		expect(real).toHaveLength(1);
	});
});
