import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock ../harness/project-graph.js so extractEdges() (exercised only through
// metricsArchCommand) can be driven with a controlled, in-memory file graph.
// ---------------------------------------------------------------------------
const graphState = vi.hoisted((): { files: string[]; deps: Record<string, string[]> } => ({
	files: [],
	deps: {},
}));

vi.mock("../harness/project-graph.js", () => {
	class FakeProjectGraph {
		cwd: string;
		constructor(cwd: string) {
			this.cwd = cwd;
		}
		initialize(): void {}
		allFiles(): string[] {
			return graphState.files.map((f) => `${this.cwd}/${f}`);
		}
		toRelative(abs: string): string {
			return abs.startsWith(`${this.cwd}/`) ? abs.slice(this.cwd.length + 1) : abs;
		}
		getDependencies(fromAbs: string): { toFile: string }[] {
			const fromRel = this.toRelative(fromAbs);
			return (graphState.deps[fromRel] ?? []).map((to) => ({ toFile: `${this.cwd}/${to}` }));
		}
	}
	return { ProjectGraph: FakeProjectGraph };
});

import { computeDirMetrics, computePropagationCost, isProductionSource } from "./metrics-arch.js";
import { metricsArchCommand } from "./metrics-arch.js";

afterEach(() => {
	graphState.files = [];
	graphState.deps = {};
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isProductionSource — kills the six regex mutants on TEST_PATH_RE / CODE_EXT_RE
// (symbol bef365a3ba8e7da1)
// ---------------------------------------------------------------------------
describe("isProductionSource — regex anchoring and character classes", () => {
	// test-contract: public-api — isProductionSource's TEST_PATH_RE first
	// alternative is anchored with $; an embedded ".test.ts" run must not
	// match unless it sits at the string end.
	it("does not treat a code file with an embedded '.test.ts' substring as a test file (first-alt $ anchor)", () => {
		expect(isProductionSource("foo.test.ts.bak.ts")).toBe(true);
	});

	// test-contract: public-api — TEST_PATH_RE's [cm]? class must still
	// accept "c" so ".test.cts" is classified as a test file.
	it("still classifies a '.test.cts' file as a non-production test file ([cm]? class)", () => {
		expect(isProductionSource("foo.test.cts")).toBe(false);
	});

	// test-contract: public-api — the third TEST_PATH_RE alternative
	// (\.d\.ts$) is end-anchored; an embedded ".d.ts" run mid-string must
	// not disqualify the file.
	it("does not treat an embedded '.d.ts' substring (not at end) as a declaration file ($ anchor on third alt)", () => {
		expect(isProductionSource("foo.d.ts.orig.ts")).toBe(true);
	});

	// test-contract: public-api — CODE_EXT_RE is end-anchored; a file whose
	// tail is not a recognized extension must not count as production
	// source even if an earlier substring looks like one.
	it("does not classify a file with an embedded code-ext-like substring but a non-code tail as production ($ anchor on CODE_EXT_RE)", () => {
		expect(isProductionSource("foo.ts.txt")).toBe(false);
	});

	// test-contract: public-api — CODE_EXT_RE's [cm]? class must accept
	// "c" so ".cts" is recognized as a code extension.
	it("still classifies a plain '.cts' file as production source ([cm]? class on CODE_EXT_RE)", () => {
		expect(isProductionSource("foo.cts")).toBe(true);
	});

	// test-contract: public-api — TEST_PATH_RE's (^|\/)__tests__\/
	// alternative must match a __tests__ dir at the very start of the
	// path, not only when preceded by a slash.
	it("excludes a top-level __tests__ directory with no preceding slash (^| alt)", () => {
		expect(isProductionSource("__tests__/foo.ts")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// computeDirMetrics — accumulation guard + sort comparator
// ---------------------------------------------------------------------------
describe("computeDirMetrics — outbound set accumulation (!outSet guard)", () => {
	// test-contract: public-api — computeDirMetrics.ce must count distinct
	// efferent files per directory; the outSet guard exists to accumulate
	// across edges instead of resetting the Set on every iteration.
	it("accumulates distinct efferent files for the same directory across multiple edges", () => {
		const rows = computeDirMetrics(
			[
				{ from: "d1/a.ts", to: "d2/x.ts" },
				{ from: "d1/b.ts", to: "d2/y.ts" },
			],
			1,
		);
		const d1 = rows.find((r) => r.dir === "d1");
		expect(d1).toBeDefined();
		// Two distinct files (a.ts, b.ts) inside d1 each import outward.
		// If the outSet guard always re-creates the Set, only the last
		// iteration's addition survives and ce collapses to 1.
		expect(d1?.ce).toBe(2);
	});
});

describe("computeDirMetrics — row sort order (comparator + arithmetic + tie-break)", () => {
	// test-contract: public-api — computeDirMetrics rows must be sorted by
	// descending (ca+ce), name-tie-broken, per the documented comparator;
	// this exercises the comparator, its arithmetic, and the || tie-break.
	it("sorts rows by descending (ca+ce), tie-broken by dir name, regardless of insertion order", () => {
		const edges = [
			// dd_low2: ca=1, ce=1 (sum 2) — inserted first
			{ from: "dd_low2/a.ts", to: "sinkA/x.ts" },
			{ from: "srcA/p.ts", to: "dd_low2/z.ts" },
			// cc_low: ca=1, ce=1 (sum 2) — inserted second
			{ from: "cc_low/a.ts", to: "sinkB/x.ts" },
			{ from: "srcB/p.ts", to: "cc_low/z.ts" },
			// aaa_mid: ca=4, ce=1 (sum 5) — inserted third; name alphabetically
			// precedes zzz_high even though its sum is lower, so a comparator
			// that falls back to name comparison instead of the numeric
			// difference gets caught.
			{ from: "aaa_mid/a.ts", to: "sinkC/x.ts" },
			{ from: "srcC1/p.ts", to: "aaa_mid/z.ts" },
			{ from: "srcC2/p.ts", to: "aaa_mid/z.ts" },
			{ from: "srcC3/p.ts", to: "aaa_mid/z.ts" },
			{ from: "srcC4/p.ts", to: "aaa_mid/z.ts" },
			// zzz_high: ca=2, ce=5 (sum 7) — inserted last
			{ from: "zzz_high/a.ts", to: "sinkD/x.ts" },
			{ from: "zzz_high/b.ts", to: "sinkD/x.ts" },
			{ from: "zzz_high/c.ts", to: "sinkD/x.ts" },
			{ from: "zzz_high/d.ts", to: "sinkD/x.ts" },
			{ from: "zzz_high/e.ts", to: "sinkD/x.ts" },
			{ from: "srcD1/p.ts", to: "zzz_high/z.ts" },
			{ from: "srcD2/p.ts", to: "zzz_high/z.ts" },
		];
		const rows = computeDirMetrics(edges, 1);
		const tracked = ["zzz_high", "aaa_mid", "cc_low", "dd_low2"];
		const order = rows.filter((r) => tracked.includes(r.dir)).map((r) => r.dir);
		expect(order).toEqual(["zzz_high", "aaa_mid", "cc_low", "dd_low2"]);

		// Confirm the ca/ce values used to derive the expected order.
		const byDir = Object.fromEntries(rows.map((r) => [r.dir, r]));
		expect(byDir.zzz_high).toMatchObject({ ca: 2, ce: 5 });
		expect(byDir.aaa_mid).toMatchObject({ ca: 4, ce: 1 });
		expect(byDir.cc_low).toMatchObject({ ca: 1, ce: 1 });
		expect(byDir.dd_low2).toMatchObject({ ca: 1, ce: 1 });
	});
});

// ---------------------------------------------------------------------------
// extractEdges (only reachable through metricsArchCommand) — path-filter guards
// ---------------------------------------------------------------------------
describe("metricsArchCommand output — extractEdges keep() filtering", () => {
	// test-contract: public-api — metricsArchCommand's extractEdges keep()
	// filter must drop an edge whose target is not production source
	// (!keep(to)), so the JSON dirs report shows zero cross-dir coupling.
	it("excludes an edge whose target is outside the production-source filter (!keep(to))", async () => {
		graphState.files = ["src/a.ts", "src/a.test.ts"];
		graphState.deps = { "src/a.ts": ["src/a.test.ts"] };
		let logged = "";
		const logSpy = vi.spyOn(console, "log").mockImplementation((chunk: unknown) => {
			logged = String(chunk);
		});
		await metricsArchCommand({ cwd: "/repo", json: true });
		logSpy.mockRestore();
		const payload = JSON.parse(logged);
		// src/a.ts -> src/a.test.ts should be dropped (target is a test file,
		// includeTests defaults to false), so no cross-dir edges exist and
		// there should be zero directories with nonzero ca/ce.
		const anyCoupling = payload.dirs.some((d: { ca: number; ce: number }) => d.ca > 0 || d.ce > 0);
		expect(anyCoupling).toBe(false);
	});

	// test-contract: public-api — the keep() closure must drop any file
	// whose relative path starts with ".." (outside the repo root), so an
	// edge originating there never contributes to the dirs report.
	it("excludes a from-file outside the repo root (rel.startsWith(''..''))", async () => {
		graphState.files = ["../outside/a.ts", "src/b.ts"];
		graphState.deps = { "../outside/a.ts": ["src/b.ts"] };
		let logged = "";
		const logSpy = vi.spyOn(console, "log").mockImplementation((chunk: unknown) => {
			logged = String(chunk);
		});
		await metricsArchCommand({ cwd: "/repo", json: true });
		logSpy.mockRestore();
		const payload = JSON.parse(logged);
		// The only edge originates outside the repo (rel starts with "..") so
		// it must be dropped entirely — no directory should show coupling.
		const anyCoupling = payload.dirs.some((d: { ca: number; ce: number }) => d.ca > 0 || d.ce > 0);
		expect(anyCoupling).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// computePropagationCost — sanity coverage for the reachable-count math
// ---------------------------------------------------------------------------
describe("computePropagationCost", () => {
	// test-contract: public-api — computePropagationCost's mean-reach
	// formula (sum of BFS closures / n^2) must match a hand-computed
	// chain-graph value.
	it("computes mean reachable share across a small chain graph", () => {
		const result = computePropagationCost([
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
		]);
		// nodes = {a,b,c}; reach(a)=2 (b,c), reach(b)=1 (c), reach(c)=0
		// total = 3, n*n = 9 -> cost = 1/3
		expect(result.files).toBe(3);
		expect(result.cost).toBeCloseTo(1 / 3, 10);
	});
});
