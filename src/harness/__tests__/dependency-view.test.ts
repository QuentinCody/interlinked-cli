// ===========================================
// DependencyView — provider seam tests (plan-08 §3b)
// ===========================================
// Covers: the resolver's freshness gate (Supermodel view only on E-fresh,
// internal fallback on A/B/C/D/E-stale and on shard-load failure), both
// backends satisfying the interface, the Supermodel shard mapping, and
// InternalDependencyView matching raw ProjectGraph outputs.

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildPredictionOracle,
	type DependencyView,
	InternalDependencyView,
	resolveDependencyView,
	SupermodelDependencyView,
} from "../dependency-view.js";
import { classifyCase, resetWorkspaceActiveCache } from "../graph-prediction-classifier.js";
import { ProjectGraph } from "../project-graph.js";
import { loadGraphForFile, parseGraphFile, type SupermodelGraph } from "../supermodel-graph.js";

// -------------------------------------------
// Helpers
// -------------------------------------------

const tmpDirs: string[] = [];

// Fixed epoch (seconds) for deterministic file mtimes. The resolver's
// freshness gate is purely relative — shard mtime vs source mtime against
// a 60s grace window — so any fixed base works and keeps the test off the
// real clock.
const FIXED_EPOCH_S = 1_700_000_000;

function makeTmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dependency-view-"));
	tmpDirs.push(dir);
	return dir;
}

/** Parse a shard fixture string into a SupermodelGraph (non-null asserted). */
function shardFrom(lines: string[]): SupermodelGraph {
	const graph = parseGraphFile(lines.join("\n"), "x.ts", "x.graph.ts");
	if (!graph) throw new Error("fixture failed to parse");
	return graph;
}

const HIGH_RISK_SHARD = [
	"// @generated supermodel-shard — do not edit",
	"// [deps]",
	"// imports     src/lib/util.ts",
	"// imported-by src/api/users.ts",
	"// imported-by src/api/posts.ts",
	"// [calls]",
	"// process ← handle    src/api/users.ts:42",
	"// process ← handle    src/api/posts.ts:51",
	"// [impact]",
	"// risk        HIGH",
	"// domains     API · Database",
	"// direct      8",
	"// transitive  50",
	"// affects     src/api/users.ts · src/api/posts.ts · src/api/admin.ts",
];

/**
 * Build a repo with one source file + a matching `.graph` shard so
 * `workspaceSupermodelActive` detects Supermodel and `classifyCase`
 * reaches Case E. `freshness` controls whether the shard mtime is ahead
 * of ("fresh") or far behind ("stale") the source mtime.
 */
function makeSupermodelRepo(opts: {
	freshness: "fresh" | "stale";
	shardLines?: string[];
	sourceContent?: string;
}): { cwd: string; sourcePath: string } {
	const cwd = makeTmpDir();
	const srcDir = join(cwd, "src");
	mkdirSync(srcDir);
	const sourcePath = join(srcDir, "mod.ts");
	const shardPath = join(srcDir, "mod.graph.ts");

	writeFileSync(sourcePath, opts.sourceContent ?? "export const v = 1;\n");
	writeFileSync(shardPath, (opts.shardLines ?? HIGH_RISK_SHARD).join("\n"));

	const base = FIXED_EPOCH_S;
	if (opts.freshness === "fresh") {
		// Shard regenerated after the source edit.
		utimesSync(sourcePath, base - 100, base - 100);
		utimesSync(shardPath, base, base);
	} else {
		// Shard predates the source edit by well over the 60s grace window.
		utimesSync(sourcePath, base, base);
		utimesSync(shardPath, base - 600, base - 600);
	}
	return { cwd, sourcePath };
}

beforeEach(() => {
	resetWorkspaceActiveCache();
});

afterEach(() => {
	resetWorkspaceActiveCache();
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// -------------------------------------------
// resolveDependencyView — freshness gate (positive)
// -------------------------------------------

describe("resolveDependencyView — freshness gate", () => {
	it("returns the Supermodel view for a fresh shard (Case E-fresh)", () => {
		const { cwd, sourcePath } = makeSupermodelRepo({ freshness: "fresh" });
		const graph = new ProjectGraph(cwd);
		const view = resolveDependencyView(sourcePath, cwd, graph);
		expect(view.source).toBe("supermodel");
		expect(view).toBeInstanceOf(SupermodelDependencyView);
	});

	it("falls back to the internal view for a stale shard (Case E-stale)", () => {
		const { cwd, sourcePath } = makeSupermodelRepo({ freshness: "stale" });
		const graph = new ProjectGraph(cwd);
		const view = resolveDependencyView(sourcePath, cwd, graph);
		expect(view.source).toBe("internal");
		expect(view).toBeInstanceOf(InternalDependencyView);
	});

	it("falls back to the internal view when Supermodel is absent (Case A)", () => {
		// No shard anywhere → workspaceSupermodelActive false → Case A.
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"));
		const sourcePath = join(cwd, "src", "plain.ts");
		writeFileSync(sourcePath, "export const x = 1;\n");
		const graph = new ProjectGraph(cwd);
		const view = resolveDependencyView(sourcePath, cwd, graph);
		expect(view.source).toBe("internal");
		// Distinguishes this from every other fallback test below: the reason
		// this file fell back is specifically Case A (no Supermodel at all).
		expect(classifyCase(sourcePath, cwd).case).toBe("A");
	});

	it("falls back to the internal view for a greenfield file (Case C)", () => {
		// Repo IS a Supermodel repo, but the target file does not yet exist.
		const { cwd } = makeSupermodelRepo({ freshness: "fresh" });
		const graph = new ProjectGraph(cwd);
		const newFile = join(cwd, "src", "brand-new.ts");
		const view = resolveDependencyView(newFile, cwd, graph);
		expect(view.source).toBe("internal");
	});

	it("falls back to the internal view when the source has no shard (Case D)", () => {
		// Supermodel repo (the mod.* pair makes it active), but a *different*
		// existing source file carries no shard of its own → Case D.
		const { cwd } = makeSupermodelRepo({ freshness: "fresh" });
		const shardlessSource = join(cwd, "src", "shardless.ts");
		writeFileSync(shardlessSource, "export const y = 2;\n");
		const graph = new ProjectGraph(cwd);
		const view = resolveDependencyView(shardlessSource, cwd, graph);
		expect(view.source).toBe("internal");
		// Distinguishes this from Case A/C/parse-failure: the reason this
		// file fell back is specifically Case D (repo active, no own shard).
		expect(classifyCase(shardlessSource, cwd).case).toBe("D");
	});

	it("falls back to the internal view when a fresh shard fails to parse", () => {
		// Shard is fresh per mtime, but its contents have no recognizable
		// structure → loadGraphForFile returns null → internal fallback.
		const { cwd, sourcePath } = makeSupermodelRepo({
			freshness: "fresh",
			shardLines: ["this is not a shard", "no comment prefix at all"],
		});
		const graph = new ProjectGraph(cwd);
		const view = resolveDependencyView(sourcePath, cwd, graph);
		expect(view.source).toBe("internal");
		// Distinguishes this from Case A/D: classifyCase itself says the
		// shard IS fresh — it is loadGraphForFile that rejects the content.
		expect(classifyCase(sourcePath, cwd).case).toBe("E-fresh");
		expect(loadGraphForFile(sourcePath)).toBeNull();
	});
});

// -------------------------------------------
// Both backends satisfy the interface
// -------------------------------------------

describe("DependencyView — interface conformance", () => {
	function assertSatisfiesInterface(view: DependencyView): void {
		expect(typeof view.getDependents).toBe("function");
		expect(typeof view.hasFile).toBe("function");
		expect(typeof view.classifyModule).toBe("function");
		expect(typeof view.getBlastRadius).toBe("function");
		expect(typeof view.getCallers).toBe("function");
		expect(Array.isArray(view.getDependents("any.ts"))).toBe(true);
		expect(typeof view.hasFile("any.ts")).toBe("boolean");
		expect(Array.isArray(view.getCallers("any.ts"))).toBe(true);
		expect(["leaf", "internal", "hub", "root"]).toContain(
			view.classifyModule("any.ts"),
		);
	}

	it("InternalDependencyView satisfies the interface", () => {
		const view = new InternalDependencyView(new ProjectGraph(makeTmpDir()));
		expect(view.source).toBe("internal");
		assertSatisfiesInterface(view);
	});

	it("SupermodelDependencyView satisfies the interface", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		expect(view.source).toBe("supermodel");
		assertSatisfiesInterface(view);
	});
});

// -------------------------------------------
// SupermodelDependencyView — shard mapping
// -------------------------------------------

describe("SupermodelDependencyView — shard mapping", () => {
	it("maps dependents as the union of imported-by and impact.affects", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		const deps = view.getDependents("src/mod.ts");
		// imported-by: users, posts; affects adds admin (users/posts deduped).
		expect(deps).toContain("src/api/users.ts");
		expect(deps).toContain("src/api/posts.ts");
		expect(deps).toContain("src/api/admin.ts");
		// No duplicates from the union.
		expect(new Set(deps).size).toBe(deps.length);
	});

	it("classifies a HIGH-risk shard as a hub", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		expect(view.classifyModule("src/mod.ts")).toBe("hub");
	});

	it("hasFile is always true — the shard exists because its source does", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		expect(view.hasFile("src/mod.ts")).toBe(true);
		expect(view.hasFile("anything.ts")).toBe(true);
	});

	it("classifies direct>=5 as a hub even when risk is not HIGH", () => {
		const view = new SupermodelDependencyView(
			shardFrom([
				"// @generated supermodel-shard",
				"// [impact]",
				"// risk        MEDIUM",
				"// direct      6",
				"// transitive  20",
			]),
		);
		expect(view.classifyModule("x.ts")).toBe("hub");
		// Distinguishes this from the HIGH-risk hub test: this shard is
		// classified a hub on FAN-OUT (direct=6) even though risk is MEDIUM.
		expect(view.getBlastRadius("x.ts")?.direct).toBe(6);
	});

	it("classifies a low-fanout shard as internal, and a zero-fanout shard as leaf", () => {
		const internalView = new SupermodelDependencyView(
			shardFrom([
				"// @generated supermodel-shard",
				"// [impact]",
				"// risk        LOW",
				"// direct      2",
				"// transitive  3",
			]),
		);
		expect(internalView.classifyModule("x.ts")).toBe("internal");

		const leafView = new SupermodelDependencyView(
			shardFrom([
				"// @generated supermodel-shard",
				"// [impact]",
				"// risk        LOW",
				"// direct      0",
				"// transitive  0",
			]),
		);
		expect(leafView.classifyModule("x.ts")).toBe("leaf");
	});

	it("maps getBlastRadius from the impact section", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		expect(view.getBlastRadius("src/mod.ts")).toEqual({
			direct: 8,
			transitive: 50,
			domains: ["API", "Database"],
		});
	});

	it("returns null from getBlastRadius when the shard has no impact section", () => {
		const view = new SupermodelDependencyView(
			shardFrom([
				"// @generated supermodel-shard",
				"// [deps]",
				"// imports     a.ts",
			]),
		);
		expect(view.getBlastRadius("x.ts")).toBeNull();
		// Without an impact section the file classifies as a leaf.
		expect(view.classifyModule("x.ts")).toBe("leaf");
	});

	it("maps getCallers from the calls section", () => {
		const view = new SupermodelDependencyView(shardFrom(HIGH_RISK_SHARD));
		const callers = view.getCallers("src/mod.ts");
		expect(callers).toHaveLength(2);
		expect(callers[0]).toEqual({
			fn: "process",
			caller: "handle",
			file: "src/api/users.ts",
			line: 42,
		});
	});

	it("returns [] from getCallers when the shard has no calls section", () => {
		const view = new SupermodelDependencyView(
			shardFrom([
				"// @generated supermodel-shard",
				"// [impact]",
				"// risk        HIGH",
				"// direct      5",
				"// transitive  9",
			]),
		);
		expect(view.getCallers("x.ts")).toEqual([]);
	});
});

// -------------------------------------------
// InternalDependencyView — matches ProjectGraph
// -------------------------------------------

describe("InternalDependencyView — matches ProjectGraph", () => {
	/** Build an indexed ProjectGraph: `hub.ts` exported, imported by N files. */
	function buildHubRepo(dependentCount: number): {
		graph: ProjectGraph;
		hubPath: string;
	} {
		const cwd = makeTmpDir();
		const srcDir = join(cwd, "src");
		mkdirSync(srcDir);
		const hubPath = join(srcDir, "hub.ts");
		writeFileSync(hubPath, "export const shared = 1;\n");
		for (let i = 0; i < dependentCount; i++) {
			writeFileSync(
				join(srcDir, `dep${i}.ts`),
				`import { shared } from "./hub.js";\nexport const u${i} = shared;\n`,
			);
		}
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		return { graph, hubPath };
	}

	it("getDependents returns exactly ProjectGraph.getDependents", () => {
		const { graph, hubPath } = buildHubRepo(3);
		const view = new InternalDependencyView(graph);
		expect([...view.getDependents(hubPath)].sort()).toEqual(
			[...graph.getDependents(hubPath)].sort(),
		);
		expect(view.getDependents(hubPath)).toHaveLength(3);
	});

	it("hasFile is true for an indexed file and false for an unknown one", () => {
		const { graph, hubPath } = buildHubRepo(1);
		const view = new InternalDependencyView(graph);
		expect(view.hasFile(hubPath)).toBe(true);
		expect(view.hasFile(join(hubPath, "..", "never-indexed.ts"))).toBe(false);
	});

	it("classifyModule returns exactly ProjectGraph.classifyModule", () => {
		const { graph, hubPath } = buildHubRepo(6);
		const view = new InternalDependencyView(graph);
		expect(view.classifyModule(hubPath)).toBe(graph.classifyModule(hubPath));
		expect(view.classifyModule(hubPath)).toBe("hub");
	});

	it("getBlastRadius reports direct === transitive (no internal BFS in v1)", () => {
		const { graph, hubPath } = buildHubRepo(4);
		const view = new InternalDependencyView(graph);
		const radius = view.getBlastRadius(hubPath);
		expect(radius).not.toBeNull();
		expect(radius!.direct).toBe(4);
		expect(radius!.transitive).toBe(4);
		expect(radius!.domains).toEqual([]);
	});

	it("getCallers is always empty (no call graph)", () => {
		const { graph, hubPath } = buildHubRepo(2);
		const view = new InternalDependencyView(graph);
		expect(view.getCallers(hubPath)).toEqual([]);
	});

	it("getBlastRadius reports 0/0 for a leaf file with no dependents", () => {
		const { graph } = buildHubRepo(0);
		// dep-free file: use the hub itself, which nothing imports here.
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"));
		const leafPath = join(cwd, "src", "lonely.ts");
		writeFileSync(leafPath, "export const z = 1;\n");
		const leafGraph = new ProjectGraph(cwd);
		leafGraph.initialize();
		const view = new InternalDependencyView(leafGraph);
		expect(view.getBlastRadius(leafPath)).toEqual({
			direct: 0,
			transitive: 0,
			domains: [],
		});
		expect(view.classifyModule(leafPath)).toBe("leaf");
		void graph;
	});
});

// -------------------------------------------
// buildPredictionOracle — graph-prediction oracle (backend + shape)
// -------------------------------------------

describe("buildPredictionOracle — backend selection + unavailable sections", () => {
	/** A repo with `hub.ts` imported by N dep files, no shard. */
	function makeInternalRepo(dependentCount: number): { cwd: string; hubPath: string } {
		const cwd = makeTmpDir();
		const srcDir = join(cwd, "src");
		mkdirSync(srcDir);
		const hubPath = join(srcDir, "hub.ts");
		writeFileSync(hubPath, "export const shared = 1;\n");
		for (let i = 0; i < dependentCount; i++) {
			writeFileSync(
				join(srcDir, `dep${i}.ts`),
				`import { shared } from "./hub.js";\nexport const u${i} = shared;\n`,
			);
		}
		return { cwd, hubPath };
	}

	it("returns the full Supermodel oracle (no unavailable sections) on a fresh shard", () => {
		const { cwd, sourcePath } = makeSupermodelRepo({ freshness: "fresh" });
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const resolved = buildPredictionOracle(sourcePath, cwd, graph);
		expect(resolved).not.toBeNull();
		expect(resolved?.source).toBe("supermodel");
		expect(resolved?.unavailable.size).toBe(0);
		// HIGH_RISK_SHARD carries a [calls] section — the shard answers it.
		expect(resolved?.oracle.calls).not.toBeNull();
	});

	it("selects the internal backend and marks unanswerable sections unavailable", () => {
		const { cwd, hubPath } = makeInternalRepo(3);
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const resolved = buildPredictionOracle(hubPath, cwd, graph);
		expect(resolved?.source).toBe("internal");
		expect([...(resolved?.unavailable ?? [])].sort()).toEqual([
			"calls.callees",
			"calls.callers",
			"impact.domains",
			"impact.transitive",
		]);
	});

	it("populates answerable sections from the ProjectGraph (3 importers, no calls)", () => {
		const { cwd, hubPath } = makeInternalRepo(3);
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const o = buildPredictionOracle(hubPath, cwd, graph)?.oracle;
		expect(o?.calls).toBeNull();
		expect(o?.deps?.importedBy).toHaveLength(3);
		expect(o?.impact?.direct).toBe(3);
		expect(o?.impact?.domains).toEqual([]);
		// No reverse BFS in the internal view → transitive equals direct.
		expect(o?.impact?.transitive).toBe(o?.impact?.direct);
	});

	it("returns null for a file that does not exist (greenfield)", () => {
		const { cwd } = makeSupermodelRepo({ freshness: "fresh" });
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const missing = join(cwd, "src", "does-not-exist.ts");
		expect(buildPredictionOracle(missing, cwd, graph)).toBeNull();
	});

	it("returns null when no ProjectGraph is supplied and there is no fresh shard", () => {
		const { cwd, hubPath } = makeInternalRepo(1);
		// No graph arg → internal backend unavailable → null (shard-only).
		expect(buildPredictionOracle(hubPath, cwd)).toBeNull();
	});

	it("maps an 'internal' role (1-4 dependents, importing another file) to MEDIUM risk", () => {
		// `mid.ts` imports `hub.ts` (hasProjectImports = true) and has exactly
		// 2 dependents of its own → ProjectGraph.classifyModule returns
		// "internal", not "root" (which needs !hasProjectImports).
		const cwd = makeInternalRepo(0).cwd;
		const srcDir = join(cwd, "src");
		const midPath = join(srcDir, "mid.ts");
		writeFileSync(midPath, `import { shared } from "./hub.js";\nexport const m = shared;\n`);
		for (let i = 0; i < 2; i++) {
			writeFileSync(
				join(srcDir, `mdep${i}.ts`),
				`import { m } from "./mid.js";\nexport const v${i} = m;\n`,
			);
		}
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		expect(graph.classifyModule(midPath)).toBe("internal");
		const resolved = buildPredictionOracle(midPath, cwd, graph);
		expect(resolved?.oracle.impact?.risk).toBe("MEDIUM");
	});

	it("maps a 'leaf' role (0 dependents) to LOW risk", () => {
		const cwd = makeTmpDir();
		mkdirSync(join(cwd, "src"));
		const leafPath = join(cwd, "src", "lonely.ts");
		writeFileSync(leafPath, "export const z = 1;\n");
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		expect(graph.classifyModule(leafPath)).toBe("leaf");
		const resolved = buildPredictionOracle(leafPath, cwd, graph);
		expect(resolved?.oracle.impact?.risk).toBe("LOW");
	});

	it("falls back to internal when a fresh shard fails to load (buildPredictionOracle)", () => {
		const { cwd, sourcePath } = makeSupermodelRepo({
			freshness: "fresh",
			shardLines: ["this is not a shard", "no comment prefix at all"],
		});
		const graph = new ProjectGraph(cwd);
		graph.initialize();
		const resolved = buildPredictionOracle(sourcePath, cwd, graph);
		expect(resolved?.source).toBe("internal");
		// Distinguishes this from "selects the internal backend..." above:
		// this repo IS Supermodel-active and the shard IS fresh — it is
		// loadGraphForFile that rejects the malformed content.
		expect(classifyCase(sourcePath, cwd).case).toBe("E-fresh");
		expect(loadGraphForFile(sourcePath)).toBeNull();
	});
});

// -------------------------------------------
// classifyCase failure → catch-block fallbacks
// -------------------------------------------

describe("resolveDependencyView / buildPredictionOracle — classifyCase throws", () => {
	it("resolveDependencyView falls back to InternalDependencyView", async () => {
		vi.resetModules();
		vi.doMock("../graph-prediction-classifier.js", () => ({
			classifyCase: () => {
				throw new Error("fs blew up");
			},
		}));
		const { resolveDependencyView: resolveThrowing, InternalDependencyView: InternalThrowing } =
			await import("../dependency-view.js");
		const { ProjectGraph: PG } = await import("../project-graph.js");
		const cwd = makeTmpDir();
		const graph = new PG(cwd);
		const view = resolveThrowing("x.ts", cwd, graph);
		expect(view.source).toBe("internal");
		expect(view).toBeInstanceOf(InternalThrowing);
		vi.doUnmock("../graph-prediction-classifier.js");
		vi.resetModules();
	});

	it("buildPredictionOracle returns null", async () => {
		vi.resetModules();
		vi.doMock("../graph-prediction-classifier.js", () => ({
			classifyCase: () => {
				throw new Error("fs blew up");
			},
		}));
		const { buildPredictionOracle: buildThrowing } = await import("../dependency-view.js");
		const { ProjectGraph: PG } = await import("../project-graph.js");
		const cwd = makeTmpDir();
		const graph = new PG(cwd);
		expect(buildThrowing("x.ts", cwd, graph)).toBeNull();
		vi.doUnmock("../graph-prediction-classifier.js");
		vi.resetModules();
	});
});

// -------------------------------------------
// SupermodelDependencyView.getDependents — dedupe within the SAME section
// -------------------------------------------

describe("SupermodelDependencyView — getDependents with no [deps] section", () => {
	it("falls back to [] for imported-by when the shard has no [deps] section", () => {
		const shard = shardFrom([
			"// @generated supermodel-shard — do not edit",
			"// [impact]",
			"// risk        LOW",
			"// direct      1",
			"// transitive  1",
			"// affects     src/api/only.ts",
		]);
		expect(shard.deps).toBeNull();
		const view = new SupermodelDependencyView(shard);
		expect(view.getDependents("src/mod.ts")).toEqual(["src/api/only.ts"]);
	});
});

describe("SupermodelDependencyView — getDependents dedupe within imported-by", () => {
	it("dedupes a repeated imported-by entry (not just across sections)", () => {
		const shard = shardFrom([
			"// @generated supermodel-shard — do not edit",
			"// [deps]",
			"// imported-by src/api/users.ts",
			"// imported-by src/api/users.ts",
			"// imported-by src/api/posts.ts",
		]);
		const view = new SupermodelDependencyView(shard);
		const deps = view.getDependents("src/mod.ts");
		expect(deps.filter((f) => f === "src/api/users.ts")).toHaveLength(1);
		expect(new Set(deps).size).toBe(deps.length);
	});
});
