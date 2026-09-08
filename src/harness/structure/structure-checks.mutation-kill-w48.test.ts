import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// -------------------------------------------
// Use the real graph's public serialization API to inspect declared contributions.
// Only repository extraction and rule evaluation are mocked.

vi.mock("./extractors/index.js", () => ({
	runAllExtractors: () => ({ nodes: [], edges: [] }),
	relinkEditedFile: () => {},
}));

const { evaluateStructureRulesMock } = vi.hoisted(() => ({
	evaluateStructureRulesMock: vi.fn(),
}));
vi.mock("./rules/index.js", () => ({
	evaluateStructureRules: evaluateStructureRulesMock,
}));

import { ArtifactGraph } from "./artifact-graph.js";
import { getImplicitConfig } from "./structure-loader.js";
import { layerDeclaredArtifacts, runStructureChecks } from "./structure-checks.js";

// -------------------------------------------
// Shared tmp repo for the layerDeclaredArtifacts (real fs) tests
// -------------------------------------------

let repoRoot: string;

beforeAll(() => {
	repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "structure-checks-w48-"));
	fs.mkdirSync(path.join(repoRoot, "interlinked"), { recursive: true });
});

afterAll(() => {
	fs.rmSync(repoRoot, { recursive: true, force: true });
});

function writeArtifact(relPath: string, data: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(repoRoot, "interlinked", relPath),
		JSON.stringify({ version: 1, ...data }),
	);
}

function freshConfig() {
	const config = getImplicitConfig();
	config.artifacts = {};
	return config;
}

// -------------------------------------------
// declaredNode: determinism_ceiling literal ("fully_deterministic")
// via extractPackageContributions (also covers its `edges: []` default)
// -------------------------------------------

describe("layerDeclaredArtifacts — packages (declaredNode + extractPackageContributions)", () => {
	it("produces a declared package node with fully_deterministic ceiling and no edges", () => {
		writeArtifact("packages.json", {
			packages: [{ id: "pkg1", root: "src/pkg1" }],
		});
		const config = freshConfig();
		config.artifacts.packages = "packages.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const node = graph.toNodesJson().nodes.find((n) => n.id === "package:pkg1");
		expect(node).toBeDefined();
		expect(node?.determinism_ceiling).toBe("fully_deterministic");
		expect(node?.provenance).toBe("declared");
		expect(node?.file).toBe("src/pkg1");
		// extractPackageContributions always contributes zero edges
		expect(graph.toEdgesJson().edges).toEqual([]);
	});
});

// -------------------------------------------
// extractLabelOnlyContributions: file arg literal ""
// -------------------------------------------

describe("layerDeclaredArtifacts — layers (extractLabelOnlyContributions)", () => {
	it("declares a layer node with an empty file, not a placeholder string", () => {
		writeArtifact("layers.json", { layers: [{ id: "L1" }], rules: [] });
		const config = freshConfig();
		config.artifacts.layers = "layers.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const node = graph.toNodesJson().nodes.find((n) => n.id === "layer:L1");
		expect(node).toBeDefined();
		expect(node?.file).toBe("");
	});
});

// -------------------------------------------
// extractGlossaryContributions: file arg literal "" + edges: [] default
// -------------------------------------------

describe("layerDeclaredArtifacts — glossary (extractGlossaryContributions)", () => {
	it("declares a term node with an empty file and contributes zero edges", () => {
		writeArtifact("glossary.json", { terms: [{ id: "T1", canonical: "Term One" }] });
		const config = freshConfig();
		config.artifacts.glossary = "glossary.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const node = graph.toNodesJson().nodes.find((n) => n.id === "term:T1");
		expect(node).toBeDefined();
		expect(node?.file).toBe("");
		expect(graph.toEdgesJson().edges).toEqual([]);
	});
});

// -------------------------------------------
// extractPublicApiContributions + extractModuleSymbols:
// module-level edges:[] default, and the symbol-level edge templates,
// "declared" provenance literals, and docs/tests/examples array defaults.
// -------------------------------------------

describe("layerDeclaredArtifacts — public_api (extractPublicApiContributions + extractModuleSymbols)", () => {
	it("builds exact edge ids/kinds/targets for a fully-annotated symbol, and only the exports edge for a bare one", () => {
		writeArtifact("public_api.json", {
			modules: [
				{
					id: "mod1",
					file: "src/mod1.ts",
					symbols: [
						{
							name: "fn1",
							kind: "function",
							stability: "public",
							docs: ["doc1"],
							tests: ["test1"],
							examples: ["ex1"],
						},
						{
							name: "fn2",
							kind: "function",
							stability: "public",
							docs: [],
							tests: [],
							examples: [],
						},
					],
				},
			],
		});
		const config = freshConfig();
		config.artifacts.public_api = "public_api.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const moduleNode = graph.toNodesJson().nodes.find((n) => n.id === "module:mod1");
		expect(moduleNode).toBeDefined();

		// Exactly 5 edges: module's own contribution is empty (0), fn1
		// contributes exports+doc+test+example (4), fn2 contributes only
		// exports (1). A mutated `[]` default anywhere in this path would
		// inflate this count or inject a non-edge entry.
		expect(graph.toEdgesJson().edges).toHaveLength(5);
		for (const e of graph.toEdgesJson().edges) {
			expect(typeof e).toBe("object");
		}

		const exportsFn1 = graph.toEdgesJson().edges.find(
			(e) => e.from === "module:mod1" && e.to === "public_symbol:mod1#fn1",
		);
		expect(exportsFn1).toMatchObject({
			id: "edge:module:mod1->public_symbol:mod1#fn1",
			kind: "exports",
			provenance: "declared",
		});

		const docEdge = graph.toEdgesJson().edges.find((e) => e.to === "doc:doc1");
		expect(docEdge).toMatchObject({
			id: "edge:public_symbol:mod1#fn1->doc:doc1",
			kind: "documents",
			from: "public_symbol:mod1#fn1",
			provenance: "declared",
		});

		const testEdge = graph.toEdgesJson().edges.find((e) => e.to === "test:test1");
		expect(testEdge).toMatchObject({
			id: "edge:public_symbol:mod1#fn1->test:test1",
			kind: "tests",
			from: "public_symbol:mod1#fn1",
			provenance: "declared",
		});

		const exampleEdge = graph.toEdgesJson().edges.find((e) => e.to === "example:ex1");
		expect(exampleEdge).toMatchObject({
			id: "edge:public_symbol:mod1#fn1->example:ex1",
			kind: "illustrates",
			from: "public_symbol:mod1#fn1",
			provenance: "declared",
		});

		// fn2 has no docs/tests/examples declared: it must contribute
		// exactly its exports edge and nothing else.
		const fn2Edges = graph.toEdgesJson().edges.filter(
			(e) => e.from === "public_symbol:mod1#fn2" || e.to === "public_symbol:mod1#fn2",
		);
		expect(fn2Edges).toHaveLength(1);
		expect(fn2Edges[0]).toMatchObject({ kind: "exports" });
	});
});

// -------------------------------------------
// extractSimpleKeyContributions: edge templates, "declared" literals,
// and the docs/tests/examples/(default_sources??declared_in) array defaults
// -------------------------------------------

describe("layerDeclaredArtifacts — env (extractSimpleKeyContributions)", () => {
	it("builds exact edges + file for an annotated key, and empty file/no edges for a bare one", () => {
		writeArtifact("env.json", {
			keys: [
				{
					name: "MY_ENV",
					required: false,
					docs: ["d1"],
					tests: ["t1"],
					examples: ["e1"],
					default_sources: ["src/env.ts"],
				},
				{ name: "OTHER_ENV", required: false },
			],
		});
		const config = freshConfig();
		config.artifacts.env = "env.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const myEnvNode = graph.toNodesJson().nodes.find((n) => n.id === "env_key:MY_ENV");
		expect(myEnvNode).toMatchObject({ file: "src/env.ts", provenance: "declared" });

		const docEdge = graph.toEdgesJson().edges.find((e) => e.from === "env_key:MY_ENV" && e.to === "doc:d1");
		expect(docEdge).toMatchObject({
			id: "edge:env_key:MY_ENV->doc:d1",
			kind: "documents",
			provenance: "declared",
		});

		const testEdge = graph.toEdgesJson().edges.find((e) => e.from === "env_key:MY_ENV" && e.to === "test:t1");
		expect(testEdge).toMatchObject({
			id: "edge:env_key:MY_ENV->test:t1",
			kind: "tests",
			provenance: "declared",
		});

		const exEdge = graph.toEdgesJson().edges.find((e) => e.from === "env_key:MY_ENV" && e.to === "example:e1");
		expect(exEdge).toMatchObject({
			id: "edge:env_key:MY_ENV->example:e1",
			kind: "illustrates",
			provenance: "declared",
		});

		// OTHER_ENV declares no docs/tests/examples/default_sources/declared_in:
		// file must fall back to "" and it must contribute zero edges.
		const otherNode = graph.toNodesJson().nodes.find((n) => n.id === "env_key:OTHER_ENV");
		expect(otherNode?.file).toBe("");
		const otherEdges = graph.toEdgesJson().edges.filter(
			(e) => e.from === "env_key:OTHER_ENV" || e.to === "env_key:OTHER_ENV",
		);
		expect(otherEdges).toHaveLength(0);
	});
});

// -------------------------------------------
// extractFileEntryContributions: "declared" provenance + covers-edge template
// -------------------------------------------

describe("layerDeclaredArtifacts — docs (extractFileEntryContributions)", () => {
	it("declares the doc node and a covers-edge with the exact template id", () => {
		writeArtifact("docs.json", {
			docs: [
				{
					id: "d1",
					file: "docs/d1.md",
					kind: "reference",
					covers: [{ artifact_kind: "module", artifact_id: "mod1" }],
				},
			],
		});
		const config = freshConfig();
		config.artifacts.docs = "docs.json";
		const graph = new ArtifactGraph();

		layerDeclaredArtifacts(graph, repoRoot, config);

		const docNode = graph.toNodesJson().nodes.find((n) => n.id === "doc:d1");
		expect(docNode).toMatchObject({ file: "docs/d1.md", provenance: "declared" });

		const coversEdge = graph.toEdgesJson().edges.find((e) => e.to === "doc:d1");
		expect(coversEdge).toMatchObject({
			id: "edge:module:mod1->doc:d1",
			kind: "documents",
			from: "module:mod1",
			to: "doc:d1",
		});
	});
});

// -------------------------------------------
// filterByEmissionConfig (private, exercised through runStructureChecks):
// the fully_deterministic / partially_deterministic comparisons must be
// exact — not collapsed into an always-true branch.
// -------------------------------------------

function makeFinding(determinism: string, artifactId: string) {
	return {
		name: `finding_${artifactId}`,
		severity: "warning",
		message: `msg ${artifactId}`,
		file: "some/file.ts",
		affected_files: [],
		determinism,
		provenance: "heuristic",
		artifact_kind: "module",
		artifact_id: artifactId,
		required_updates: [],
		confidence: 1,
	};
}

describe("runStructureChecks — filterByEmissionConfig determinism gating", () => {
	it("keeps a partially_deterministic finding when only emit_deterministic is off", () => {
		evaluateStructureRulesMock.mockReturnValue([
			makeFinding("fully_deterministic", "f1"),
			makeFinding("partially_deterministic", "f2"),
		]);
		const config = freshConfig();
		config.posttooluse = {
			emit_deterministic: false,
			emit_partial: true,
			emit_heuristic: true,
			max_heuristics: 999,
		};

		const result = runStructureChecks("file.ts", repoRoot, null, config);

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.artifact_id).toBe("f2");
	});

	it("keeps a fully_deterministic finding when only emit_partial is off", () => {
		evaluateStructureRulesMock.mockReturnValue([
			makeFinding("fully_deterministic", "f3"),
			makeFinding("partially_deterministic", "f4"),
		]);
		const config = freshConfig();
		config.posttooluse = {
			emit_deterministic: true,
			emit_partial: false,
			emit_heuristic: true,
			max_heuristics: 999,
		};

		const result = runStructureChecks("file.ts", repoRoot, null, config);

		expect(result.results).toHaveLength(1);
		expect(result.results[0]?.artifact_id).toBe("f3");
	});
});
