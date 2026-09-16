// ===========================================
// coverage-test-selector — affected-test selection over the reverse import graph
// ===========================================
// The keystone of affordable per-edit coverage: given an edited file, BFS the
// reverse import graph (DependencyView.getDependents) transitively and return
// ONLY the test files that could be affected. Tri-state contract:
//   - transitive test dependents (deduped, sorted) when the file is in the graph;
//   - `null` when the file is NOT in the graph (caller → full suite);
//   - `[]` when the file IS in the graph but no test depends on it (caller →
//     strict-TDD block).
// The view is stubbed (no real ProjectGraph); a temp dir backs the companion-
// test existence check.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTestPath, selectAffectedTests } from "../coverage-test-selector.js";
import type { BlastRadius, CallerSite, DependencyView } from "../dependency-view.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-selector-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * A stub DependencyView whose reverse graph is an explicit absolute-path edge map
 * (`file → its importers`) and whose membership set is the union of every node
 * mentioned. `getDependents` reads the map; `hasFile` reads the membership set —
 * letting a test model "known leaf with no dependents" (in the set, empty edges)
 * distinctly from "unknown file" (absent from the set).
 */
function stubView(edges: Record<string, string[]>, known?: Set<string>): DependencyView {
	const membership = known ?? new Set<string>([...Object.keys(edges), ...Object.values(edges).flat()]);
	return {
		source: "internal",
		answerScope: "repo",
		getDependents: (file: string): string[] => edges[file] ?? [],
		hasFile: (file: string): boolean => membership.has(file),
		classifyModule: () => "internal",
		getBlastRadius: (): BlastRadius => ({ direct: 0, transitive: 0, domains: [] }),
		getCallers: (): CallerSite[] => [],
	};
}

/** Absolute path under the temp root for a repo-relative POSIX path. */
function abs(rel: string): string {
	return resolve(root, rel);
}

// ---------------------------------------------------------------------------
// Positive cases — transitive selection
// ---------------------------------------------------------------------------

describe("selectAffectedTests — positive (test dependents found)", () => {
	it("selects BOTH a direct companion test and an integration test that import the file", () => {
		// m.ts ← m.test.ts AND ← integration.test.ts (both direct importers).
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), abs("tests/integration.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts", "tests/integration.test.ts"]);
	});

	it("selects a TRANSITIVE test (test imports a module that imports the edited file)", () => {
		// m.ts ← helper.ts ← helper.test.ts. helper.ts is not a test, but the BFS
		// keeps walking and collects helper.test.ts two hops out.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/helper.ts")],
			[abs("src/helper.ts")]: [abs("src/helper.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/helper.test.ts"]);
	});

	it("dedupes a test reachable via multiple paths and sorts the result", () => {
		// big.test.ts imports both a.ts and b.ts, which both import m.ts → it is
		// reachable twice but appears once; z.test.ts sorts after big.test.ts.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/a.ts"), abs("src/b.ts"), abs("src/z.test.ts")],
			[abs("src/a.ts")]: [abs("src/big.test.ts")],
			[abs("src/b.ts")]: [abs("src/big.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/big.test.ts", "src/z.test.ts"]);
	});

	it("includes the edited file's on-disk companion test even if the graph missed it", () => {
		// The graph reports NO dependents, but src/m.test.ts exists on disk → it is
		// added as a companion. (File in the graph, so not null.)
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.test.ts"), "it('x', () => {});\n", "utf-8");
		const view = stubView({ [abs("src/m.ts")]: [] });
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("does not treat a populated graph as complete evidence for Python selection", () => {
		const view = stubView({
			[abs("src/m.py")]: [abs("tests/test_m.py"), abs("src/m_helper.py")],
			[abs("src/m_helper.py")]: [abs("pkg/m_test.go")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.py", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});
    it("falls back to the full Python suite despite an on-disk or co-created companion", () => {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "test_m.py"), "from m import behavior\n");
        const selected = selectAffectedTests({ editedRelPath: "src/m.py", projectRoot: root,
            depView: stubView({ [abs("src/m.py")]: [] }),
            overlaySections: [{ relPath: "tests/test_m.py", content: "from m import behavior\n" }] });
        expect(selected).toBeNull();
    });
    it("does not confuse an empty Python graph with proof that no tests exist", () => {
        expect(selectAffectedTests({ editedRelPath: "src/m.py", projectRoot: root,
            depView: stubView({ [abs("src/m.py")]: [] }) })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// New-file scoping — the fix: a brand-new file (not yet in the graph) still
// scopes to its companion / co-created test instead of deferring to commit.
// ---------------------------------------------------------------------------

describe("selectAffectedTests — new file not yet in the graph", () => {
	/** A view whose membership EXCLUDES `edited` (brand-new, unindexed file). */
	function viewWithout(edited: string): DependencyView {
		const membership = new Set<string>([abs("src/unrelated.ts")]);
		membership.delete(abs(edited));
		return stubView({}, membership);
	}

	it("scopes to the on-disk companion test (the test-first TDD flow)", () => {
		// src/m.ts is brand new (not in graph) but src/m.test.ts was written first.
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/m.test.ts"), "it('x', () => {});\n", "utf-8");
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: viewWithout("src/m.ts"),
		});
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("scopes to a companion created in the SAME overlay (atomic source+test patch)", () => {
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: viewWithout("src/m.ts"),
			overlaySections: [
				{ relPath: "src/m.ts", content: "export const x = 1;" },
				{ relPath: "src/m.test.ts", content: "import './m.js';\nit('x', () => {});" },
			],
		});
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("scopes to a non-convention overlay test that imports the new file by path", () => {
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: viewWithout("src/m.ts"),
			overlaySections: [
				{ relPath: "src/integration.test.ts", content: "import { x } from './m.js';" },
			],
		});
		expect(selected).toEqual(["src/integration.test.ts"]);
	});

	it("returns null for a new file with no resolvable test (defer/full — TDD gate owns 'no test')", () => {
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: viewWithout("src/m.ts"),
		});
		expect(selected).toBeNull();
	});

	it("does NOT scope to a same-prefix overlay test that imports a DIFFERENT file (/metrics. ≠ /m.)", () => {
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: viewWithout("src/m.ts"),
			overlaySections: [
				{ relPath: "src/metrics.test.ts", content: "import './metrics.js';" },
			],
		});
		expect(selected).toBeNull();
	});

	it("merges an overlay co-created test with the graph's dependents for an EXISTING file", () => {
		// src/m.ts IS in the graph (has m.test.ts dependent); the edit also adds a
		// new integration test in the same overlay → both run.
		const view = stubView({ [abs("src/m.ts")]: [abs("src/m.test.ts")] });
		const selected = selectAffectedTests({
			editedRelPath: "src/m.ts",
			projectRoot: root,
			depView: view,
			overlaySections: [
				{ relPath: "src/extra.test.ts", content: "import { x } from './m.js';" },
			],
		});
		expect(selected).toEqual(["src/extra.test.ts", "src/m.test.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Negative cases — null / [] / non-test filtering
// ---------------------------------------------------------------------------

describe("selectAffectedTests — negative (null / empty / filtering)", () => {
	it("returns null when the edited file is NOT in the graph", () => {
		// Membership set excludes the edited file → null → caller runs full suite.
		const view = stubView({}, new Set<string>([abs("src/other.ts")]));
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});

	it("returns [] when the file is in the graph but NO test depends on it", () => {
		// m.ts is imported by a non-test (app.ts) only, and has no companion on disk.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/app.ts")],
			[abs("src/app.ts")]: [abs("src/main.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual([]);
	});

	it("returns [] for a known leaf with zero dependents and no companion", () => {
		const view = stubView({ [abs("src/leaf.ts")]: [] });
		const selected = selectAffectedTests({ editedRelPath: "src/leaf.ts", projectRoot: root, depView: view });
		expect(selected).toEqual([]);
	});

	it("does NOT include non-test dependents (only real test files survive the filter)", () => {
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/consumer.ts"), abs("src/m.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
		expect(selected).not.toContain("src/consumer.ts");
	});

	it("drops a dependent that resolves OUTSIDE the project root", () => {
		// A foreign-repo importer (../other-repo/x.test.ts) is not part of this
		// repo's test run, so it is excluded; the in-tree test remains.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), join(root, "..", "other-repo", "x.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/m.test.ts"]);
	});

	it("terminates on a cyclic reverse graph (a ↔ b) without hanging", () => {
		// m.ts ← a.ts ← b.ts ← a.ts (cycle). The visited set bounds the walk; the
		// one test (a.test.ts) is found exactly once.
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/a.ts")],
			[abs("src/a.ts")]: [abs("src/b.ts"), abs("src/a.test.ts")],
			[abs("src/b.ts")]: [abs("src/a.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/a.test.ts"]);
	});
});

// ---------------------------------------------------------------------------
// isTestPath — the cross-language predicate
// ---------------------------------------------------------------------------

describe("isTestPath", () => {
	it("matches the pinned test-file conventions", () => {
		expect(isTestPath("src/m.test.ts")).toBe(true);
		expect(isTestPath("src/m.spec.tsx")).toBe(true);
		expect(isTestPath("src/__tests__/m.ts")).toBe(true);
		expect(isTestPath("tests/test_m.py")).toBe(true);
		expect(isTestPath("src/m_test.py")).toBe(true);
		expect(isTestPath("pkg/m_test.go")).toBe(true);
	});

	it("does not match plain source files", () => {
		expect(isTestPath("src/m.ts")).toBe(false);
		expect(isTestPath("src/testimony.ts")).toBe(false); // 'test' substring, not a test file
		expect(isTestPath("src/contest.py")).toBe(false);
		expect(isTestPath("src/latest.go")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Truncation honesty — a capped BFS must fall back, never return a partial set
// ---------------------------------------------------------------------------

/** Linear reverse-import chain of `length` hops ending in one test file:
 *  edited ← c0 ← c1 ← … ← c{length-1} ← far.test.ts */
function chainEdges(length: number): Record<string, string[]> {
	const edges: Record<string, string[]> = {};
	let prev = abs("src/m.ts");
	for (let i = 0; i < length; i++) {
		const node = abs(`src/c${i}.ts`);
		edges[prev] = [node];
		prev = node;
	}
	edges[prev] = [abs("src/far.test.ts")];
	return edges;
}

describe("selectAffectedTests — BFS node-cap truncation", () => {
	it("returns null (full-suite fallback) when the walk hits the node cap with frontier remaining", () => {
		// 1100 intermediate nodes > the 1000-node expansion cap: the far test lies
		// beyond the cap, so the collected set is incomplete → must be null, not [].
		const view = stubView(chainEdges(1100));
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});

	it("still completes (and finds the far test) on a deep chain UNDER the cap", () => {
		const view = stubView(chainEdges(900));
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/far.test.ts"]);
	});

	it("returns null rather than the partial set even when affected tests were already found before the cap", () => {
		// A direct companion test sits at hop 1 — found long before truncation —
		// but the walk still truncates, so the subset is not provably complete.
		const edges = chainEdges(1100);
		const seed = abs("src/m.ts");
		edges[seed] = [...(edges[seed] ?? []), abs("src/m.direct.test.ts")];
		const view = stubView(edges);
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Seed-only views (per-file Supermodel shard) — no honest transitive walk
// ---------------------------------------------------------------------------

describe("selectAffectedTests — seed-only dependency views", () => {
	/** The same edge map as stubView, but declaring the per-file-shard scope. */
	function seedOnlyView(edges: Record<string, string[]>): DependencyView {
		return { ...stubView(edges), answerScope: "seed-only" };
	}

	it("returns null for a seed-only view even when a direct test dependent exists", () => {
		const view = seedOnlyView({ [abs("src/m.ts")]: [abs("src/m.test.ts")] });
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});

	it("returns null for a seed-only view that would otherwise yield a nonempty-but-incomplete subset", () => {
		// Direct test + an indirect test two hops out: a per-file shard would
		// re-answer the seed's dependents at every hop and miss the indirect one.
		const view = seedOnlyView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), abs("src/mid.ts")],
			[abs("src/mid.ts")]: [abs("src/integration.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toBeNull();
	});

	it("the identical graph through a repo-scoped view selects BOTH tests (the contrast case)", () => {
		const view = stubView({
			[abs("src/m.ts")]: [abs("src/m.test.ts"), abs("src/mid.ts")],
			[abs("src/mid.ts")]: [abs("src/integration.test.ts")],
		});
		const selected = selectAffectedTests({ editedRelPath: "src/m.ts", projectRoot: root, depView: view });
		expect(selected).toEqual(["src/integration.test.ts", "src/m.test.ts"]);
	});
});
