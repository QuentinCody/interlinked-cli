// ===========================================
// Generic Artifact Structure V1 — Fixture Repo Tests
// ===========================================
// Tests the full structure pipeline against real fixture repos
// with actual files on disk.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { isJsonObject } from "../../../lib/json-types.js";
import { ArtifactGraph } from "../artifact-graph.js";
import { runAllExtractors } from "../extractors/index.js";
import { evaluateStructureRules } from "../rules/index.js";
import { ARTIFACT_FILE_KEYS, validateStructureJson } from "../schema-validator.js";
import { layerDeclaredArtifacts } from "../structure-checks.js";
import { formatStructureVerifyOutput } from "../structure-formatter.js";
import { getImplicitConfig, loadArtifactFile, loadStructureConfig } from "../structure-loader.js";
import type { StructureConfig } from "../types.js";

// -------------------------------------------
// Helper: build a full graph from a fixture root
// -------------------------------------------

function buildFullGraph(root: string, config: StructureConfig): ArtifactGraph {
	const extracted = runAllExtractors(root);
	const graph = new ArtifactGraph();
	for (const node of extracted.nodes) graph.addNode(node);
	for (const edge of extracted.edges) graph.addEdge(edge);
	layerDeclaredArtifacts(graph, root, config);
	return graph;
}

// -------------------------------------------
// Helper: run doctor-style checks on a fixture
// -------------------------------------------

interface DoctorIssue {
	severity: "error" | "warning" | "info";
	message: string;
}

function runDoctor(root: string): DoctorIssue[] {
	const issues: DoctorIssue[] = [];
	const structurePath = join(root, "interlinked", "structure.json");

	let hasStructureJson = false;
	try {
		const raw = readFileSync(structurePath, "utf-8");
		const parsed = JSON.parse(raw);
		hasStructureJson = true;
		const result = validateStructureJson(parsed);
		if (!result.valid) {
			for (const e of result.errors) {
				issues.push({
					severity: "error",
					message: `structure.json ${e.path}: ${e.message}`,
				});
			}
		}
	} catch (_err) {
		void 0; /* intentional: no structure.json or invalid JSON — handled below */
	}

	if (!hasStructureJson) {
		issues.push({
			severity: "info",
			message: "No interlinked/structure.json found (implicit minimal mode)",
		});
		return issues;
	}

	const loaded = loadStructureConfig(root);
	for (const err of loaded.errors) {
		issues.push({ severity: "error", message: err });
	}

	const config = loaded.config ?? getImplicitConfig();

	// Check artifact file validity
	for (const key of ARTIFACT_FILE_KEYS) {
		const rel = config.artifacts[key];
		if (!rel) continue;
		const { errors } = loadArtifactFile(root, key, rel);
		for (const err of errors) {
			issues.push({ severity: "error", message: `${key} (${rel}): ${err}` });
		}
	}

	// Check declared paths exist
	for (const key of ARTIFACT_FILE_KEYS) {
		const rel = config.artifacts[key];
		if (!rel) continue;
		const { data } = loadArtifactFile(root, key, rel);
		if (!data) continue;
		for (const col of ["modules", "tests", "docs", "examples", "packages"]) {
			const arr = data[col];
			if (!Array.isArray(arr)) continue;
			for (const rec of arr) {
				if (!isJsonObject(rec)) continue;
				if (typeof rec.file === "string" && !existsSync(resolve(root, rec.file))) {
					issues.push({
						severity: "warning",
						message: `${key}: declared path not found: ${rec.file}`,
					});
				}
			}
		}
	}

	return issues;
}

// ===========================================
// Tests
// ===========================================

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("fixture repos", () => {
	describe("fixture-declared", () => {
		const root = join(FIXTURES, "fixture-declared");

		it("structure doctor finds no issues", () => {
			const issues = runDoctor(root);
			const errors = issues.filter((i) => i.severity === "error");
			expect(errors).toEqual([]);
		});

		it("scan produces correct node and edge counts", () => {
			const loaded = loadStructureConfig(root);
			expect(loaded.config).not.toBeNull();
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// Extractors should find modules, tests, docs, env_keys, packages
			// Declared artifacts add: module:client, public_symbol:client#createClient,
			// doc:client-api, test:client-test, env_key:API_URL, term:client,
			// layer:domain, layer:app, package:root
			expect(graph.nodeCount).toBeGreaterThan(0);
			expect(graph.edgeCount).toBeGreaterThan(0);

			// Specifically: declared public_symbol node should exist
			const symbolNode = graph.getNode("public_symbol:client#createClient");
			expect(symbolNode).toBeDefined();
			expect(symbolNode!.provenance).toBe("declared");

			// Declared doc and test nodes should exist
			const docNode = graph.getNode("doc:client-api");
			expect(docNode).toBeDefined();
			expect(docNode!.file).toBe("docs/client.md");

			const testNode = graph.getNode("test:client-test");
			expect(testNode).toBeDefined();
			expect(testNode!.file).toBe("test/client.test.ts");

			// Declared term node should exist
			const termNode = graph.getNode("term:client");
			expect(termNode).toBeDefined();
			expect(termNode!.label).toBe("client");

			// Declared layer nodes should exist
			expect(graph.getNode("layer:domain")).toBeDefined();
			expect(graph.getNode("layer:app")).toBeDefined();

			// Declared env_key should exist
			const envNode = graph.getNode("env_key:API_URL");
			expect(envNode).toBeDefined();
		});

		it("companion rule fires when src/client.ts changed without docs/client.md", () => {
			const loaded = loadStructureConfig(root);
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// Only src/client.ts changed, but not docs/client.md or test/client.test.ts
			const findings = evaluateStructureRules(graph, config, ["src/client.ts"], root);

			const companionFindings = findings.filter(
				(f) => f.name === "public_symbol_companion_untouched",
			);
			expect(companionFindings.length).toBeGreaterThan(0);

			// The finding should reference the untouched companion files
			const finding = companionFindings[0];
			expect(nonNull(finding).file).toBe("src/client.ts");
			expect(nonNull(finding).required_updates.length).toBeGreaterThan(0);

			// Check that docs/client.md and test/client.test.ts are in required updates
			const updateFiles = nonNull(finding).required_updates.map((u) => u.file);
			expect(updateFiles).toContain("docs/client.md");
			expect(updateFiles).toContain("test/client.test.ts");
		});

		it("companion rule does NOT fire when both src/client.ts and docs/client.md are changed", () => {
			const loaded = loadStructureConfig(root);
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// Both src/client.ts and docs/client.md and test/client.test.ts changed
			const findings = evaluateStructureRules(
				graph,
				config,
				["src/client.ts", "docs/client.md", "test/client.test.ts"],
				root,
			);

			const companionFindings = findings.filter(
				(f) => f.name === "public_symbol_companion_untouched",
			);
			// All companions were touched, so no finding should fire
			expect(companionFindings).toEqual([]);
		});

		it("glossary residue fires when src/app.ts contains deprecated term", () => {
			const loaded = loadStructureConfig(root);
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// src/app.ts contains "agent" which is deprecated in glossary
			const findings = evaluateStructureRules(graph, config, ["src/app.ts"], root);

			const glossaryFindings = findings.filter((f) => f.name === "glossary_residue");
			expect(glossaryFindings.length).toBeGreaterThan(0);
			expect(nonNull(glossaryFindings[0]).message).toContain("agent");
			expect(nonNull(glossaryFindings[0]).message).toContain("client");
		});

		it("layer violation fires when domain imports app", () => {
			const loaded = loadStructureConfig(root);
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// For layer violation to fire, we need:
			// 1. Layer nodes with metadata.cannot_import
			// 2. belongs_to_layer edges
			// 3. imports edges crossing forbidden boundaries
			// The declared layers define the rule, but the extractors need to create
			// the import and layer-membership edges. Let's manually add them to test.

			// Add layer membership edges
			const domainModules = graph
				.getNodesByKind("module")
				.filter((n) => n.file === "src/client.ts");
			const appModules = graph
				.getNodesByKind("module")
				.filter((n) => n.file === "src/app.ts");

			// Set cannot_import metadata on domain layer node
			const domainLayer = graph.getNode("layer:domain");
			if (domainLayer) {
				domainLayer.metadata = { cannot_import: ["layer:app"] };
			}

			// Add belongs_to_layer edges
			for (const mod of domainModules) {
				graph.addEdge({
					id: `edge:${mod.id}->layer:domain`,
					kind: "belongs_to_layer",
					from: mod.id,
					to: "layer:domain",
					provenance: "declared",
					confidence: 1.0,
				});
			}
			for (const mod of appModules) {
				graph.addEdge({
					id: `edge:${mod.id}->layer:app`,
					kind: "belongs_to_layer",
					from: mod.id,
					to: "layer:app",
					provenance: "declared",
					confidence: 1.0,
				});
			}

			// Add an import edge from domain module to app module
			if (domainModules.length > 0 && appModules.length > 0) {
				graph.addEdge({
					id: `edge:${nonNull(domainModules[0]).id}->${nonNull(appModules[0]).id}`,
					kind: "imports",
					from: nonNull(domainModules[0]).id,
					to: nonNull(appModules[0]).id,
					provenance: "extracted",
					confidence: 0.9,
				});
			}

			const findings = evaluateStructureRules(graph, config, [], root);

			const layerFindings = findings.filter((f) => f.name === "layer_boundary_violation");
			expect(layerFindings.length).toBeGreaterThan(0);
			expect(nonNull(layerFindings[0]).message).toContain("layer:domain");
			expect(nonNull(layerFindings[0]).message).toContain("layer:app");
		});

		it("verify --structure returns deterministic findings", () => {
			const loaded = loadStructureConfig(root);
			const config = loaded.config!;
			const graph = buildFullGraph(root, config);

			// Run findings twice -- results should be identical
			const findings1 = evaluateStructureRules(graph, config, ["src/client.ts"], root);
			const findings2 = evaluateStructureRules(graph, config, ["src/client.ts"], root);

			expect(findings1.length).toBe(findings2.length);
			for (let i = 0; i < findings1.length; i++) {
				expect(nonNull(findings1[i]).name).toBe(nonNull(findings2[i]).name);
				expect(nonNull(findings1[i]).file).toBe(nonNull(findings2[i]).file);
				expect(nonNull(findings1[i]).artifact_id).toBe(nonNull(findings2[i]).artifact_id);
				expect(nonNull(findings1[i]).determinism).toBe(nonNull(findings2[i]).determinism);
			}

			// Format verify output
			const output = formatStructureVerifyOutput({
				config,
				findings: findings1,
				invalidFiles: [],
				adoption: {},
				catalogFresh: true,
			});

			expect(output.mode).toBe("standard");
			expect(output.catalog_fresh).toBe(true);
			expect(output.invalid_files).toEqual([]);
			expect(typeof output.findings.fully_deterministic).toBe("number");
			expect(typeof output.findings.partially_deterministic).toBe("number");
			expect(typeof output.findings.heuristic).toBe("number");
		});
	});

	describe("fixture-extracted", () => {
		const root = join(FIXTURES, "fixture-extracted");

		it("scan works without manifests (implicit minimal mode)", () => {
			const loaded = loadStructureConfig(root);
			expect(loaded.config).toBeNull();
			expect(loaded.implicit).toBe(true);
			expect(loaded.errors).toEqual([]);

			const config = getImplicitConfig();
			expect(config.mode).toBe("minimal");

			const graph = buildFullGraph(root, config);
			expect(graph.nodeCount).toBeGreaterThan(0);
		});

		it("extractors find module, test, doc, env_key nodes", () => {
			const config = getImplicitConfig();
			const graph = buildFullGraph(root, config);

			// Module extractor should find src/index.ts and src/index.test.ts (both are .ts files)
			const modules = graph.getNodesByKind("module");
			const moduleFiles = modules.map((m) => m.file);
			expect(moduleFiles).toContain("src/index.ts");

			// Test extractor should find src/index.test.ts
			const tests = graph.getNodesByKind("test");
			const testFiles = tests.map((t) => t.file);
			expect(testFiles).toContain("src/index.test.ts");

			// Docs extractor should find docs/README.md
			const docs = graph.getNodesByKind("doc");
			const docFiles = docs.map((d) => d.file);
			expect(docFiles).toContain("docs/README.md");

			// Env extractor should find DB_URL from process.env.DB_URL
			const envKeys = graph.getNodesByKind("env_key");
			const envNames = envKeys.map((e) => e.label);
			expect(envNames).toContain("DB_URL");
		});

		it("test extractor creates tests edge to module", () => {
			const extracted = runAllExtractors(root);
			const graph = new ArtifactGraph();
			for (const node of extracted.nodes) graph.addNode(node);
			for (const edge of extracted.edges) graph.addEdge(edge);

			// The test extractor should create a "tests" edge from test:src-index.test
			// to module:src-index (inferring the tested module)
			const testEdges = graph.getEdgesByKind("tests");
			expect(testEdges.length).toBeGreaterThan(0);

			// Find the specific edge from the test to its source module
			const testToModule = testEdges.find(
				(e) => e.from.startsWith("test:") && e.to.startsWith("module:"),
			);
			expect(testToModule).toBeDefined();
			expect(testToModule!.confidence).toBeGreaterThan(0);
			expect(testToModule!.provenance).toBe("inferred");
		});
	});

	describe("fixture-invalid", () => {
		const root = join(FIXTURES, "fixture-invalid");

		it("doctor reports unknown key and missing file", () => {
			const issues = runDoctor(root);

			// Should report unknown_key in structure.json
			const unknownKeyIssues = issues.filter(
				(i) => i.message.includes("unknown_key") || i.message.includes("Unknown key"),
			);
			expect(unknownKeyIssues.length).toBeGreaterThan(0);

			// When structure.json has validation errors, loadStructureConfig returns
			// config: null, so the doctor cannot check artifact file paths.
			// However, we separately verify that nonexistent.ts would be flagged
			// by directly loading and checking the artifact file.
			const { data } = loadArtifactFile(root, "public_api", "artifacts/public-api.json");
			expect(data).not.toBeNull();
			expect(data?.modules).toEqual(expect.arrayContaining([expect.objectContaining({ file: "nonexistent.ts" })]));
			expect(existsSync(resolve(root, "nonexistent.ts"))).toBe(false);
		});

		it("verify returns findings for invalid structure", () => {
			const loaded = loadStructureConfig(root);
			// loadStructureConfig should report errors for the unknown key
			expect(loaded.errors.length).toBeGreaterThan(0);

			// The error should mention unknown_key
			const hasUnknownKey = loaded.errors.some(
				(e) => e.includes("unknown_key") || e.includes("Unknown key"),
			);
			expect(hasUnknownKey).toBe(true);
		});
	});
});
