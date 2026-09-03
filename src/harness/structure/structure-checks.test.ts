// ===========================================
// structure-checks — behavioral coverage
// ===========================================
// Drives every export + branch of ./structure-checks.ts. The module reaches the
// filesystem only through three sibling boundaries — extractors/index (graph
// build), rules/index (finding evaluation), and structure-loader (structure.json
// + artifact files). We vi.mock exactly those three, so there is zero real I/O
// and every fixture is deterministic. The real ArtifactGraph is used unmocked
// (a pure in-memory data structure with no I/O) so layerDeclaredArtifacts and
// refreshFileInGraph can be asserted against the actual node/edge contents they
// produce — a far stronger check than a mocked graph.
//
// We assert real emitted values: returned CheckResultEntry shapes, the actual
// nodes/edges layered onto the graph (every artifact-file switch case + helper),
// emission-filter output, pending-completion shapes, and every conditional
// (abs-vs-rel path, config/graph fallbacks, session-touched-file dedup,
// determinism gates, max_heuristics overflow, required-update filter).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactGraph } from "./artifact-graph.js";
import type {
	ArtifactEdge,
	ArtifactNode,
	StructureConfig,
	StructureFinding,
	StructurePostToolUseConfig,
} from "./types.js";

// ---- ./extractors/index mock -----------------------------------------------
// runAllExtractors returns whatever the current test queued. Default: empty.
let extractorNodes: ArtifactNode[];
let extractorEdges: ArtifactEdge[];
const runAllExtractors = vi.fn((_repoRoot: string) => ({
	nodes: extractorNodes,
	edges: extractorEdges,
	truncated: false,
}));
// refreshFileInGraph now delegates the per-file re-extract to relinkEditedFile;
// its node/edge behavior is unit-tested in extractors/index.test.ts. Here it is a
// spy so the delegation contract can be asserted without real I/O.
const relinkEditedFile = vi.fn((_graph: ArtifactGraph, _repoRoot: string, _relPath: string) => {});
vi.mock("./extractors/index.js", () => ({
	runAllExtractors: (repoRoot: string) => runAllExtractors(repoRoot),
	relinkEditedFile: (graph: ArtifactGraph, repoRoot: string, relPath: string) =>
		relinkEditedFile(graph, repoRoot, relPath),
}));

// ---- ./rules/index mock ----------------------------------------------------
// evaluateStructureRules is called positionally (graph, config, changedFiles,
// repoRoot). The mock records its args and returns whatever the test queued.
let ruleFindings: StructureFinding[];
const evaluateStructureRules = vi.fn(
	(
		_graph: ArtifactGraph,
		_config: StructureConfig,
		_changedFiles: string[],
		_repoRoot: string,
	): StructureFinding[] => ruleFindings,
);
vi.mock("./rules/index.js", () => ({
	evaluateStructureRules: (
		g: ArtifactGraph,
		c: StructureConfig,
		cf: string[],
		rr: string,
	) => evaluateStructureRules(g, c, cf, rr),
}));

// ---- ./structure-loader mock -----------------------------------------------
// loadStructureConfig → { config, ... }; getImplicitConfig → implicit config;
// loadArtifactFile → { data } keyed by the artifact-file key the caller passes.
let loadedConfig: StructureConfig | null;
let implicitConfig: StructureConfig;
let artifactData: Partial<Record<string, Record<string, unknown> | null>>;
const loadStructureConfig = vi.fn((_repoRoot: string) => ({
	config: loadedConfig,
	errors: [] as string[],
	implicit: loadedConfig === null,
}));
const getImplicitConfig = vi.fn((): StructureConfig => implicitConfig);
const loadArtifactFile = vi.fn((_repoRoot: string, key: string, _relPath: string) => ({
	data: key in artifactData ? artifactData[key] : null,
	errors: [] as string[],
}));
vi.mock("./structure-loader.js", () => ({
	loadStructureConfig: (rr: string) => loadStructureConfig(rr),
	getImplicitConfig: () => getImplicitConfig(),
	loadArtifactFile: (rr: string, key: string, rp: string) => loadArtifactFile(rr, key, rp),
}));

// SUT — imported after the mocks are declared (hoisted by vitest regardless).
import {
	layerDeclaredArtifacts,
	runStructureChecks,
	structureFindingToCheckResult,
} from "./structure-checks.js";

// ---- fixture builders ------------------------------------------------------

function postToolUse(over: Partial<StructurePostToolUseConfig> = {}): StructurePostToolUseConfig {
	return {
		emit_deterministic: true,
		emit_partial: true,
		emit_heuristic: true,
		max_heuristics: 3,
		...over,
	};
}

function makeConfig(over: Partial<StructureConfig> = {}): StructureConfig {
	return {
		version: 1,
		mode: "standard",
		artifacts: {},
		verify: {
			fail_on_deterministic: true,
			fail_on_invalid_structure: true,
			fail_on_partial: false,
			fail_on_heuristic: false,
		},
		posttooluse: postToolUse(),
		adoption: {
			coverage_thresholds: {
				public_api: 0.6,
				env: 0.8,
				config: 0.8,
				tests: 0.5,
				docs: 0.5,
				examples: 0.3,
				glossary: 0.4,
				layers: 0.7,
				packages: 1.0,
			},
		},
		builtins: {
			public_symbol_companions: true,
			public_symbol_test_case: true,
			env_key_companions: true,
			config_key_companions: true,
			layer_boundary_violations: true,
			glossary_residue: true,
			package_boundary_violations: true,
		},
		...over,
	};
}

function makeFinding(over: Partial<StructureFinding> = {}): StructureFinding {
	return {
		name: "public_symbol_companion_untouched",
		severity: "warning",
		message: "companion not updated",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		provenance: "declared",
		artifact_kind: "public_symbol",
		artifact_id: "foo#bar",
		required_updates: [],
		confidence: 1,
		...over,
	};
}

beforeEach(() => {
	extractorNodes = [];
	extractorEdges = [];
	ruleFindings = [];
	loadedConfig = makeConfig();
	implicitConfig = makeConfig({ mode: "minimal" });
	artifactData = {};
	runAllExtractors.mockClear();
	relinkEditedFile.mockClear();
	evaluateStructureRules.mockClear();
	loadStructureConfig.mockClear();
	getImplicitConfig.mockClear();
	loadArtifactFile.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ===========================================================================
// structureFindingToCheckResult
// ===========================================================================

describe("structureFindingToCheckResult", () => {
	it("maps every StructureFinding field onto the CheckResultEntry, tagging source=structure", () => {
		const finding = makeFinding({
			name: "env_key_companion_untouched",
			severity: "error",
			message: "env doc stale",
			file: "src/env.ts",
			detail: "details here",
			line: 42,
			affected_files: ["docs/env.md"],
			determinism: "partially_deterministic",
			provenance: "extracted",
			artifact_kind: "env_key",
			artifact_id: "API_BASE_URL",
			required_updates: [{ file: "docs/env.md", kind: "doc", reason: "stale" }],
			confidence: 0.75,
		});

		const entry = structureFindingToCheckResult(finding);

		expect(entry).toEqual({
			source: "structure",
			name: "env_key_companion_untouched",
			severity: "error",
			message: "env doc stale",
			file: "src/env.ts",
			detail: "details here",
			line: 42,
			affected_files: ["docs/env.md"],
			determinism: "partially_deterministic",
			provenance: "extracted",
			artifact_kind: "env_key",
			artifact_id: "API_BASE_URL",
			required_updates: [{ file: "docs/env.md", kind: "doc", reason: "stale" }],
			confidence: 0.75,
		});
	});

	it("carries undefined through for optional fields that were absent on the finding", () => {
		const entry = structureFindingToCheckResult(makeFinding());
		expect(entry.detail).toBeUndefined();
		expect(entry.line).toBeUndefined();
		expect(entry.affected_files).toBeUndefined();
		expect(entry.source).toBe("structure");
		expect(entry.required_updates).toEqual([]);
	});
});

// ===========================================================================
// runStructureChecks — orchestration
// ===========================================================================

describe("runStructureChecks", () => {
	it("converts an absolute edited path to repo-relative before passing it to the rules", () => {
		runStructureChecks("/repo/src/foo.ts", "/repo", new ArtifactGraph(), makeConfig());

		const [, , changedFiles, repoRoot] = evaluateStructureRules.mock.calls[0]!;
		expect(changedFiles).toEqual(["src/foo.ts"]);
		expect(repoRoot).toBe("/repo");
	});

	it("leaves an already-relative edited path untouched", () => {
		runStructureChecks("src/bar.ts", "/repo", new ArtifactGraph(), makeConfig());
		const [, , changedFiles] = evaluateStructureRules.mock.calls[0]!;
		expect(changedFiles).toEqual(["src/bar.ts"]);
	});

	it("uses the supplied config and graph without re-resolving or rebuilding either", () => {
		const graph = new ArtifactGraph();
		const config = makeConfig();

		runStructureChecks("src/foo.ts", "/repo", graph, config);

		// supplied config → no loader call; supplied graph → build pass skipped, so
		// no full runAllExtractors; only the per-file refresh (relinkEditedFile) runs.
		expect(loadStructureConfig).not.toHaveBeenCalled();
		expect(getImplicitConfig).not.toHaveBeenCalled();
		expect(runAllExtractors).not.toHaveBeenCalled();
		expect(relinkEditedFile).toHaveBeenCalledTimes(1);
		// rules ran against the exact graph instance we passed in
		expect(evaluateStructureRules.mock.calls[0]![0]).toBe(graph);
		expect(evaluateStructureRules.mock.calls[0]![1]).toBe(config);
	});

	it("resolves config from the loader when config is null", () => {
		loadedConfig = makeConfig({ mode: "strict" });
		runStructureChecks("src/foo.ts", "/repo", new ArtifactGraph(), null);

		expect(loadStructureConfig).toHaveBeenCalledWith("/repo");
		expect(getImplicitConfig).not.toHaveBeenCalled();
		expect(evaluateStructureRules.mock.calls[0]![1]!.mode).toBe("strict");
	});

	it("falls back to the implicit config when the loader returns no config", () => {
		loadedConfig = null;
		implicitConfig = makeConfig({ mode: "minimal" });
		runStructureChecks("src/foo.ts", "/repo", new ArtifactGraph(), null);

		expect(getImplicitConfig).toHaveBeenCalledTimes(1);
		expect(evaluateStructureRules.mock.calls[0]![1]!.mode).toBe("minimal");
	});

	it("builds the graph from extractors (nodes AND edges) when graph is null, layering declared artifacts", () => {
		extractorNodes = [
			{
				id: "module:src/foo.ts",
				kind: "module",
				label: "foo",
				file: "src/foo.ts",
				provenance: "extracted",
				determinism_ceiling: "fully_deterministic",
			},
		];
		// an extractor edge whose endpoint is the edited file: added in the build
		// pass (buildGraph edge loop) and re-added in the refresh pass.
		extractorEdges = [
			{
				id: "edge:module:src/foo.ts->package:core",
				kind: "belongs_to_package",
				from: "module:src/foo.ts",
				to: "package:core",
				provenance: "extracted",
				confidence: 1,
			},
		];
		// declared package layered on during the build pass
		artifactData = { packages: { packages: [{ id: "core", root: "packages/core" }] } };
		const config = makeConfig({ artifacts: { packages: "packages.json" } });

		runStructureChecks("src/foo.ts", "/repo", null, config);

		// build pass calls the full extractor once; the per-file refresh delegates to
		// relinkEditedFile (no second full walk — that was the per-edit starvation fix).
		expect(runAllExtractors).toHaveBeenCalledTimes(1);
		expect(relinkEditedFile).toHaveBeenCalledTimes(1);
		const builtGraph = evaluateStructureRules.mock.calls[0]![0]!;
		// the extracted module added during the build pass is present
		expect(builtGraph.getNode("module:src/foo.ts")).toBeDefined();
		// the extracted edge was added during the build pass
		expect(builtGraph.getEdgesFrom("module:src/foo.ts")).toHaveLength(1);
		// the declared package was layered on
		expect(builtGraph.getNode("package:core")?.file).toBe("packages/core");
	});

	it("appends session-touched files (made relative) to changedFiles, skipping the edited file itself", () => {
		const touched = new Set<string>(["/repo/src/a.ts", "src/b.ts", "/repo/src/foo.ts"]);
		runStructureChecks("src/foo.ts", "/repo", new ArtifactGraph(), makeConfig(), touched);

		const [, , changedFiles] = evaluateStructureRules.mock.calls[0]!;
		// edited file first; duplicate (foo.ts) filtered; others normalized to rel
		expect(changedFiles![0]).toBe("src/foo.ts");
		expect(changedFiles).toContain("src/a.ts");
		expect(changedFiles).toContain("src/b.ts");
		expect(changedFiles).not.toContain("/repo/src/foo.ts");
		expect(changedFiles!.filter((f) => f === "src/foo.ts")).toHaveLength(1);
	});

	it("returns findings, derived results, the graph instance, and pending completions", () => {
		const graph = new ArtifactGraph();
		ruleFindings = [
			makeFinding({
				name: "public_symbol_companion_untouched",
				required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "x" }],
			}),
		];

		const out = runStructureChecks("src/foo.ts", "/repo", graph, makeConfig());

		expect(out.graph).toBe(graph);
		expect(out.findings).toHaveLength(1);
		expect(out.results).toHaveLength(1);
		expect(out.results[0]!.source).toBe("structure");
		expect(out.results[0]!.name).toBe("public_symbol_companion_untouched");
		expect(out.pendingCompletions).toHaveLength(1);
		expect(out.pendingCompletions[0]!.required_companion_files).toEqual(["docs/foo.md"]);
	});

	it("applies emission filtering before producing results and pending completions", () => {
		// emit_heuristic off → a heuristic finding is dropped from results AND
		// from the pending-completion list, even though it carries required_updates.
		ruleFindings = [
			makeFinding({ determinism: "fully_deterministic" }),
			makeFinding({
				name: "glossary_residue",
				determinism: "heuristic",
				required_updates: [{ file: "GLOSSARY.md", kind: "doc", reason: "y" }],
			}),
		];
		const config = makeConfig({ posttooluse: postToolUse({ emit_heuristic: false }) });

		const out = runStructureChecks("src/foo.ts", "/repo", new ArtifactGraph(), config);

		expect(out.findings).toHaveLength(1);
		expect(out.findings[0]!.determinism).toBe("fully_deterministic");
		expect(out.pendingCompletions).toHaveLength(0);
	});
});

// ===========================================================================
// runStructureChecks — refreshFileInGraph (incremental refresh internals)
// ===========================================================================

describe("runStructureChecks → refreshFileInGraph", () => {
	// The node/edge re-extract logic now lives in (and is unit-tested by)
	// extractors/index.ts::relinkEditedFile. Here we assert the delegation +
	// path normalization that refreshFileInGraph is responsible for.
	it("delegates the per-file re-extract to relinkEditedFile(graph, repoRoot, relPath)", () => {
		const graph = new ArtifactGraph();
		runStructureChecks("src/foo.ts", "/repo", graph, makeConfig());
		expect(relinkEditedFile).toHaveBeenCalledTimes(1);
		expect(relinkEditedFile).toHaveBeenCalledWith(graph, "/repo", "src/foo.ts");
	});

	it("normalizes an absolute edited path to repo-relative before relinkEditedFile", () => {
		const graph = new ArtifactGraph();
		runStructureChecks("/repo/src/foo.ts", "/repo", graph, makeConfig());
		expect(relinkEditedFile).toHaveBeenCalledWith(graph, "/repo", "src/foo.ts");
	});
});

// ===========================================================================
// layerDeclaredArtifacts — every artifact-file switch case + helper
// ===========================================================================

describe("layerDeclaredArtifacts", () => {
	function layer(
		artifacts: StructureConfig["artifacts"],
		data: Partial<Record<string, Record<string, unknown> | null>>,
	): ArtifactGraph {
		artifactData = data;
		const graph = new ArtifactGraph();
		layerDeclaredArtifacts(graph, "/repo", makeConfig({ artifacts }));
		return graph;
	}

	it("skips artifact keys whose configured path is empty/falsy", () => {
		const graph = new ArtifactGraph();
		// path is empty string → `if (!relPath) continue` short-circuits before load
		layerDeclaredArtifacts(graph, "/repo", makeConfig({ artifacts: { docs: "" } }));
		expect(loadArtifactFile).not.toHaveBeenCalled();
		expect(graph.nodeCount).toBe(0);
	});

	it("skips a configured artifact file that fails to load (null data)", () => {
		const graph = layer({ docs: "docs.json" }, { docs: null });
		expect(loadArtifactFile).toHaveBeenCalledWith("/repo", "docs", "docs.json");
		expect(graph.nodeCount).toBe(0);
	});

	// ---- public_api -------------------------------------------------------

	it("public_api: layers module nodes, public_symbol nodes, and an exports edge", () => {
		const graph = layer(
			{ public_api: "api.json" },
			{
				public_api: {
					modules: [{ id: "src/foo.ts", file: "src/foo.ts", symbols: [{ name: "bar" }] }],
				},
			},
		);

		expect(graph.getNode("module:src/foo.ts")?.provenance).toBe("declared");
		expect(graph.getNode("public_symbol:src/foo.ts#bar")).toBeDefined();
		const exportsEdges = graph.getEdgesByKind("exports");
		expect(exportsEdges).toHaveLength(1);
		expect(exportsEdges[0]!.from).toBe("module:src/foo.ts");
		expect(exportsEdges[0]!.to).toBe("public_symbol:src/foo.ts#bar");
	});

	it("public_api: returns nothing when modules is not an array", () => {
		const graph = layer({ public_api: "api.json" }, { public_api: { modules: "nope" } });
		expect(graph.nodeCount).toBe(0);
	});

	it("public_api: a module without a symbols array contributes only the module node", () => {
		const graph = layer(
			{ public_api: "api.json" },
			{ public_api: { modules: [{ id: "src/foo.ts", file: "src/foo.ts" }] } },
		);
		expect(graph.getNode("module:src/foo.ts")).toBeDefined();
		expect(graph.getNodesByKind("public_symbol")).toHaveLength(0);
	});

	it("public_api: symbol docs/tests/examples arrays each produce a companion edge", () => {
		const graph = layer(
			{ public_api: "api.json" },
			{
				public_api: {
					modules: [
						{
							id: "m",
							file: "src/m.ts",
							symbols: [{ name: "fn", docs: ["d1"], tests: ["t1"], examples: ["e1"] }],
						},
					],
				},
			},
		);

		const sym = "public_symbol:m#fn";
		expect(
			graph.getEdgesByKind("documents").some((e) => e.from === sym && e.to === "doc:d1"),
		).toBe(true);
		expect(graph.getEdgesByKind("tests").some((e) => e.from === sym && e.to === "test:t1")).toBe(
			true,
		);
		expect(
			graph.getEdgesByKind("illustrates").some((e) => e.from === sym && e.to === "example:e1"),
		).toBe(true);
	});

	// ---- env / config (simple-key contributions) --------------------------

	it("env: layers an env_key node sourced from default_sources[0], with companion edges", () => {
		const graph = layer(
			{ env: "env.json" },
			{
				env: {
					keys: [
						{
							name: "API_BASE_URL",
							default_sources: ["src/env.ts"],
							docs: ["d1"],
							tests: ["t1"],
							examples: ["e1"],
						},
					],
				},
			},
		);

		expect(graph.getNode("env_key:API_BASE_URL")?.file).toBe("src/env.ts");
		const ref = "env_key:API_BASE_URL";
		expect(graph.getEdgesByKind("documents").some((e) => e.from === ref && e.to === "doc:d1")).toBe(
			true,
		);
		expect(graph.getEdgesByKind("tests").some((e) => e.from === ref)).toBe(true);
		expect(graph.getEdgesByKind("illustrates").some((e) => e.from === ref)).toBe(true);
	});

	it("env: falls back to declared_in[0] for the source file when default_sources is absent", () => {
		const graph = layer(
			{ env: "env.json" },
			{ env: { keys: [{ name: "FEATURE_FLAG", declared_in: ["src/flags.ts"] }] } },
		);
		expect(graph.getNode("env_key:FEATURE_FLAG")?.file).toBe("src/flags.ts");
	});

	it("env: uses an empty source file when neither default_sources nor declared_in is present", () => {
		const graph = layer({ env: "env.json" }, { env: { keys: [{ name: "BARE_KEY" }] } });
		expect(graph.getNode("env_key:BARE_KEY")?.file).toBe("");
	});

	it("env: returns nothing when keys is not an array", () => {
		const graph = layer({ env: "env.json" }, { env: { keys: 5 } });
		expect(graph.nodeCount).toBe(0);
	});

	it("config: layers a config_key node (distinct kind from env)", () => {
		const graph = layer(
			{ config: "config.json" },
			{ config: { keys: [{ name: "timeout_ms", default_sources: ["src/cfg.ts"] }] } },
		);
		expect(graph.getNode("config_key:timeout_ms")?.kind).toBe("config_key");
		expect(graph.getNode("config_key:timeout_ms")?.file).toBe("src/cfg.ts");
	});

	// ---- tests / docs / examples (file-entry contributions) ---------------

	it("tests: layers a test node and a `tests` edge back to each covered artifact", () => {
		const graph = layer(
			{ tests: "tests.json" },
			{
				tests: {
					tests: [
						{
							id: "foo.test",
							file: "src/foo.test.ts",
							covers: [{ artifact_kind: "public_symbol", artifact_id: "m#fn" }],
						},
					],
				},
			},
		);

		expect(graph.getNode("test:foo.test")?.file).toBe("src/foo.test.ts");
		const e = graph.getEdgesByKind("tests");
		expect(e).toHaveLength(1);
		expect(e[0]!.from).toBe("public_symbol:m#fn");
		expect(e[0]!.to).toBe("test:foo.test");
	});

	it("docs: uses the `documents` edge kind for covered artifacts", () => {
		const graph = layer(
			{ docs: "docs.json" },
			{
				docs: {
					docs: [
						{
							id: "guide",
							file: "docs/guide.md",
							covers: [{ artifact_kind: "module", artifact_id: "src/foo.ts" }],
						},
					],
				},
			},
		);
		const e = graph.getEdgesByKind("documents");
		expect(e).toHaveLength(1);
		expect(e[0]!.to).toBe("doc:guide");
	});

	it("examples: uses the `illustrates` edge kind for covered artifacts", () => {
		const graph = layer(
			{ examples: "examples.json" },
			{
				examples: {
					examples: [
						{
							id: "demo",
							file: "examples/demo.ts",
							covers: [{ artifact_kind: "public_symbol", artifact_id: "m#fn" }],
						},
					],
				},
			},
		);
		expect(graph.getEdgesByKind("illustrates")).toHaveLength(1);
		expect(graph.getNode("example:demo")).toBeDefined();
	});

	it("tests: a file entry without a covers array contributes only the node (no edges)", () => {
		const graph = layer(
			{ tests: "tests.json" },
			{ tests: { tests: [{ id: "bare.test", file: "src/bare.test.ts" }] } },
		);
		expect(graph.getNode("test:bare.test")).toBeDefined();
		expect(graph.edgeCount).toBe(0);
	});

	it("docs: returns nothing when the docs array is not an array", () => {
		const graph = layer({ docs: "docs.json" }, { docs: { docs: {} } });
		expect(graph.nodeCount).toBe(0);
	});

	// ---- glossary ---------------------------------------------------------

	it("glossary: layers a term node labelled by its canonical form, attaching alias+deprecated metadata", () => {
		const graph = layer(
			{ glossary: "glossary.json" },
			{
				glossary: {
					terms: [
						{
							id: "harness",
							canonical: "Harness",
							aliases: ["guard"],
							deprecated: ["watcher"],
						},
					],
				},
			},
		);

		const node = graph.getNode("term:harness");
		expect(node?.label).toBe("Harness");
		expect(node?.metadata).toEqual({ aliases: ["guard"], deprecated: ["watcher"] });
	});

	it("glossary: attaches only aliases when deprecated is empty", () => {
		const graph = layer(
			{ glossary: "glossary.json" },
			{ glossary: { terms: [{ id: "t", canonical: "T", aliases: ["a"] }] } },
		);
		expect(graph.getNode("term:t")?.metadata).toEqual({ aliases: ["a"] });
	});

	it("glossary: attaches only deprecated when aliases is empty", () => {
		const graph = layer(
			{ glossary: "glossary.json" },
			{ glossary: { terms: [{ id: "t", canonical: "T", deprecated: ["old"] }] } },
		);
		expect(graph.getNode("term:t")?.metadata).toEqual({ deprecated: ["old"] });
	});

	it("glossary: leaves metadata unset when neither aliases nor deprecated is present", () => {
		const graph = layer(
			{ glossary: "glossary.json" },
			{ glossary: { terms: [{ id: "t", canonical: "T" }] } },
		);
		expect(graph.getNode("term:t")?.metadata).toBeUndefined();
	});

	it("glossary: returns nothing when terms is not an array", () => {
		const graph = layer({ glossary: "glossary.json" }, { glossary: { terms: null } });
		expect(graph.nodeCount).toBe(0);
	});

	// ---- layers (label-only) ----------------------------------------------

	it("layers: layers a label-only layer node with no edges", () => {
		const graph = layer({ layers: "layers.json" }, { layers: { layers: [{ id: "domain" }] } });
		expect(graph.getNode("layer:domain")?.kind).toBe("layer");
		expect(graph.edgeCount).toBe(0);
	});

	it("layers: returns nothing when the layers array is not an array", () => {
		const graph = layer({ layers: "layers.json" }, { layers: { layers: "x" } });
		expect(graph.nodeCount).toBe(0);
	});

	// ---- packages ---------------------------------------------------------

	it("packages: layers a package node whose file is its root", () => {
		const graph = layer(
			{ packages: "packages.json" },
			{ packages: { packages: [{ id: "core", root: "packages/core" }] } },
		);
		expect(graph.getNode("package:core")?.file).toBe("packages/core");
	});

	it("packages: returns nothing when the packages array is not an array", () => {
		const graph = layer({ packages: "packages.json" }, { packages: { packages: 0 } });
		expect(graph.nodeCount).toBe(0);
	});
});

// ===========================================================================
// filterByEmissionConfig (exercised through runStructureChecks)
// ===========================================================================

describe("runStructureChecks → emission filtering", () => {
	function run(findings: StructureFinding[], pt: Partial<StructurePostToolUseConfig>) {
		ruleFindings = findings;
		return runStructureChecks(
			"src/foo.ts",
			"/repo",
			new ArtifactGraph(),
			makeConfig({ posttooluse: postToolUse(pt) }),
		).findings;
	}

	it("drops fully_deterministic findings when emit_deterministic is false", () => {
		const out = run([makeFinding({ determinism: "fully_deterministic" })], {
			emit_deterministic: false,
		});
		expect(out).toHaveLength(0);
	});

	it("keeps fully_deterministic findings when emit_deterministic is true", () => {
		const out = run([makeFinding({ determinism: "fully_deterministic" })], {
			emit_deterministic: true,
		});
		expect(out).toHaveLength(1);
	});

	it("drops partially_deterministic findings when emit_partial is false", () => {
		const out = run([makeFinding({ determinism: "partially_deterministic" })], {
			emit_partial: false,
		});
		expect(out).toHaveLength(0);
	});

	it("drops heuristic findings when emit_heuristic is false", () => {
		const out = run([makeFinding({ determinism: "heuristic" })], { emit_heuristic: false });
		expect(out).toHaveLength(0);
	});

	it("emits heuristic findings up to max_heuristics, then drops the overflow", () => {
		const out = run(
			[
				makeFinding({ name: "h1", determinism: "heuristic" }),
				makeFinding({ name: "h2", determinism: "heuristic" }),
				makeFinding({ name: "h3", determinism: "heuristic" }),
			],
			{ emit_heuristic: true, max_heuristics: 2 },
		);
		expect(out.map((f) => f.name)).toEqual(["h1", "h2"]);
	});

	it("counts only heuristic findings against max_heuristics (deterministic ones pass freely)", () => {
		const out = run(
			[
				makeFinding({ name: "d1", determinism: "fully_deterministic" }),
				makeFinding({ name: "h1", determinism: "heuristic" }),
				makeFinding({ name: "p1", determinism: "partially_deterministic" }),
				makeFinding({ name: "h2", determinism: "heuristic" }),
			],
			{ max_heuristics: 1 },
		);
		// h2 is the 2nd heuristic → dropped; the two non-heuristic ones survive
		expect(out.map((f) => f.name)).toEqual(["d1", "h1", "p1"]);
	});
});

// ===========================================================================
// buildPendingCompletions (exercised through runStructureChecks)
// ===========================================================================

describe("runStructureChecks → buildPendingCompletions", () => {
	it("creates a pending completion only for findings that carry required updates", () => {
		const before = Date.now();
		ruleFindings = [
			makeFinding({
				name: "with_updates",
				file: "src/a.ts",
				artifact_kind: "public_symbol",
				artifact_id: "a#fn",
				determinism: "partially_deterministic",
				provenance: "extracted",
				required_updates: [
					{ file: "docs/a.md", kind: "doc", reason: "r1" },
					{ file: "src/a.test.ts", kind: "test", reason: "r2" },
				],
			}),
			makeFinding({ name: "no_updates", required_updates: [] }),
		];

		const { pendingCompletions } = runStructureChecks(
			"src/a.ts",
			"/repo",
			new ArtifactGraph(),
			makeConfig(),
		);

		expect(pendingCompletions).toHaveLength(1);
		const pc = pendingCompletions[0]!;
		expect(pc.source_artifact_ref).toBe("public_symbol:a#fn");
		expect(pc.source_file).toBe("src/a.ts");
		expect(pc.finding_class).toBe("with_updates");
		expect(pc.required_companion_files).toEqual(["docs/a.md", "src/a.test.ts"]);
		expect(pc.resolved_companion_files).toBeInstanceOf(Set);
		expect(pc.resolved_companion_files.size).toBe(0);
		expect(pc.determinism).toBe("partially_deterministic");
		expect(pc.provenance).toBe("extracted");
		expect(pc.first_detected_tool_call).toBeGreaterThanOrEqual(before);
	});

	it("produces no pending completions when no finding carries required updates", () => {
		ruleFindings = [makeFinding({ required_updates: [] })];
		const { pendingCompletions } = runStructureChecks(
			"src/a.ts",
			"/repo",
			new ArtifactGraph(),
			makeConfig(),
		);
		expect(pendingCompletions).toHaveLength(0);
	});
});
