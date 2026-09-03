import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { StructureConfig } from "../types.js";
import { evaluateStructureRules } from "./index.js";

function baseConfig(overrides: Partial<StructureConfig["builtins"]> = {}): StructureConfig {
	return {
		version: 1,
		mode: "minimal",
		artifacts: {},
		verify: {} as StructureConfig["verify"],
		posttooluse: {} as StructureConfig["posttooluse"],
		adoption: {} as StructureConfig["adoption"],
		builtins: {
			public_symbol_companions: false,
			public_symbol_test_case: false,
			env_key_companions: false,
			config_key_companions: false,
			layer_boundary_violations: false,
			package_boundary_violations: false,
			glossary_residue: false,
			...overrides,
		},
	};
}

describe("evaluateStructureRules", () => {
	it("returns empty when no built-ins are enabled", () => {
		const g = new ArtifactGraph();
		expect(evaluateStructureRules(g, baseConfig(), [])).toEqual([]);
	});

	it("runs public_symbol_companions when enabled + finds expected issue", () => {
		const g = new ArtifactGraph();
		const sym = {
			id: makeGlobalRef("public_symbol", "foo"),
			kind: "public_symbol" as const,
			label: "foo",
			file: "src/foo.ts",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		const doc = {
			id: makeGlobalRef("doc", "foo"),
			kind: "doc" as const,
			label: "foo",
			file: "docs/foo.md",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(sym.id, doc.id),
			kind: "documents",
			from: sym.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		const findings = evaluateStructureRules(g, baseConfig({ public_symbol_companions: true }), [
			"src/foo.ts",
		]);
		expect(findings.length).toBe(1);
		expect(nonNull(findings[0]).name).toBe("public_symbol_companion_untouched");
	});

	it("accepts the single-argument context form as well as positional args", () => {
		const g = new ArtifactGraph();
		expect(
			evaluateStructureRules({
				graph: g,
				config: baseConfig(),
				changedFiles: [],
			}),
		).toEqual([]);
	});

	// isRuleContext (unexported) decides whether the first positional argument
	// is a StructureRuleContext or a bare ArtifactGraph. It can only be
	// observed through evaluateStructureRules's routing: every candidate here
	// is passed positionally alongside a real, all-builtins-off config and an
	// empty changedFiles array. If isRuleContext wrongly classifies the
	// candidate as a context object, the function destructures graph/config
	// from the candidate itself (ignoring our positional config), leaving
	// `config` undefined/non-config — `const builtins = config.builtins`
	// then throws before any builtin check runs. Correct classification
	// (positional/graph form) always resolves cleanly to [] here since every
	// builtin is disabled.
	it("isRuleContext correctly treats null as the graph-positional form", () => {
		const candidate = null as unknown as ArtifactGraph;
		expect(() => evaluateStructureRules(candidate, baseConfig(), [])).not.toThrow();
		expect(evaluateStructureRules(candidate, baseConfig(), [])).toEqual([]);
	});

	it("isRuleContext correctly treats a string as the graph-positional form", () => {
		const candidate = "hello" as unknown as ArtifactGraph;
		expect(() => evaluateStructureRules(candidate, baseConfig(), [])).not.toThrow();
		expect(evaluateStructureRules(candidate, baseConfig(), [])).toEqual([]);
	});

	it("isRuleContext correctly treats a number as the graph-positional form", () => {
		const candidate = 42 as unknown as ArtifactGraph;
		expect(() => evaluateStructureRules(candidate, baseConfig(), [])).not.toThrow();
		expect(evaluateStructureRules(candidate, baseConfig(), [])).toEqual([]);
	});

	it("isRuleContext correctly treats a function carrying graph/config/changedFiles props as the graph-positional form", () => {
		const candidate = Object.assign(() => {}, {
			graph: 1,
			config: 2,
			changedFiles: 3,
		}) as unknown as ArtifactGraph;
		expect(() => evaluateStructureRules(candidate, baseConfig(), [])).not.toThrow();
		expect(evaluateStructureRules(candidate, baseConfig(), [])).toEqual([]);
	});

	it("isRuleContext correctly treats an object with config+changedFiles but no graph key as the graph-positional form", () => {
		const candidate = { config: 2, changedFiles: 3 } as unknown as ArtifactGraph;
		expect(() => evaluateStructureRules(candidate, baseConfig(), [])).not.toThrow();
		expect(evaluateStructureRules(candidate, baseConfig(), [])).toEqual([]);
	});

	it("does not run public_symbol_companions when the flag is off, even with a real finding available", () => {
		const g = new ArtifactGraph();
		const sym = {
			id: makeGlobalRef("public_symbol", "foo"),
			kind: "public_symbol" as const,
			label: "foo",
			file: "src/foo.ts",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		const doc = {
			id: makeGlobalRef("doc", "foo"),
			kind: "doc" as const,
			label: "foo",
			file: "docs/foo.md",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(sym.id, doc.id),
			kind: "documents",
			from: sym.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		expect(
			evaluateStructureRules(g, baseConfig({ public_symbol_companions: false }), ["src/foo.ts"]),
		).toEqual([]);
	});

	it("does not run env_key_companions when the flag is off, even with a real finding available", () => {
		const g = new ArtifactGraph();
		const env = {
			id: makeGlobalRef("env_key", "SAMPLE_FLAG"),
			kind: "env_key" as const,
			label: "SAMPLE_FLAG",
			file: ".env.example",
			provenance: "declared" as const,
			determinism_ceiling: "partially_deterministic" as const,
		};
		const doc = {
			id: makeGlobalRef("doc", "config"),
			kind: "doc" as const,
			label: "config",
			file: "docs/config.md",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		g.addNode(env);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(env.id, doc.id),
			kind: "documents",
			from: env.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		expect(
			evaluateStructureRules(g, baseConfig({ env_key_companions: false }), [".env.example"]),
		).toEqual([]);
	});

	it("does not run config_key_companions when the flag is off, even with a real finding available", () => {
		const g = new ArtifactGraph();
		const cfg = {
			id: makeGlobalRef("config_key", "server.url"),
			kind: "config_key" as const,
			label: "server.url",
			file: "src/config.ts",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		const doc = {
			id: makeGlobalRef("doc", "readme"),
			kind: "doc" as const,
			label: "README",
			file: "README.md",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		g.addNode(cfg);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(cfg.id, doc.id),
			kind: "documents",
			from: cfg.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		expect(
			evaluateStructureRules(g, baseConfig({ config_key_companions: false }), ["src/config.ts"]),
		).toEqual([]);
	});

	it("does not run layer_boundary_violations when the flag is off, even with a real crossing import", () => {
		const g = new ArtifactGraph();
		const uiLayer = {
			id: makeGlobalRef("layer", "ui"),
			kind: "layer" as const,
			label: "ui",
			file: ".",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
			metadata: { cannot_import: [makeGlobalRef("layer", "db")] },
		};
		const dbLayer = {
			id: makeGlobalRef("layer", "db"),
			kind: "layer" as const,
			label: "db",
			file: ".",
			provenance: "declared" as const,
			determinism_ceiling: "fully_deterministic" as const,
		};
		const uiMod = {
			id: makeGlobalRef("module", "ui-file"),
			kind: "module" as const,
			label: "ui-file",
			file: "src/ui/a.ts",
			provenance: "extracted" as const,
			determinism_ceiling: "partially_deterministic" as const,
		};
		const dbMod = {
			id: makeGlobalRef("module", "db-file"),
			kind: "module" as const,
			label: "db-file",
			file: "src/db/b.ts",
			provenance: "extracted" as const,
			determinism_ceiling: "partially_deterministic" as const,
		};
		for (const n of [uiLayer, dbLayer, uiMod, dbMod]) g.addNode(n);
		g.addEdge({
			id: makeEdgeId(uiMod.id, uiLayer.id),
			kind: "belongs_to_layer",
			from: uiMod.id,
			to: uiLayer.id,
			provenance: "extracted",
			confidence: 0.9,
		});
		g.addEdge({
			id: makeEdgeId(dbMod.id, dbLayer.id),
			kind: "belongs_to_layer",
			from: dbMod.id,
			to: dbLayer.id,
			provenance: "extracted",
			confidence: 0.9,
		});
		g.addEdge({
			id: makeEdgeId(uiMod.id, dbMod.id),
			kind: "imports",
			from: uiMod.id,
			to: dbMod.id,
			provenance: "extracted",
			confidence: 0.9,
		});

		expect(
			evaluateStructureRules(g, baseConfig({ layer_boundary_violations: false }), []),
		).toEqual([]);
	});

	function pkgNode(id: string, file: string) {
		return {
			id: makeGlobalRef("package", id),
			kind: "package" as const,
			label: id,
			file,
			provenance: "extracted" as const,
			determinism_ceiling: "partially_deterministic" as const,
		};
	}
	function modNode(id: string, file: string) {
		return {
			id: makeGlobalRef("module", id),
			kind: "module" as const,
			label: id,
			file,
			provenance: "extracted" as const,
			determinism_ceiling: "partially_deterministic" as const,
		};
	}
	function buildCrossPackageGraph(): ArtifactGraph {
		const g = new ArtifactGraph();
		const p1 = pkgNode("app", "app/package.json");
		const p2 = pkgNode("lib", "lib/package.json");
		const appMod = modNode("app-mod", "app/src/x.ts");
		const libInternal = modNode("lib-internal", "lib/src/internals.ts");
		for (const n of [p1, p2, appMod, libInternal]) g.addNode(n);
		g.addEdge({
			id: makeEdgeId(appMod.id, p1.id),
			kind: "belongs_to_package",
			from: appMod.id,
			to: p1.id,
			provenance: "extracted",
			confidence: 0.9,
		});
		g.addEdge({
			id: makeEdgeId(libInternal.id, p2.id),
			kind: "belongs_to_package",
			from: libInternal.id,
			to: p2.id,
			provenance: "extracted",
			confidence: 0.9,
		});
		g.addEdge({
			id: makeEdgeId(appMod.id, libInternal.id),
			kind: "imports",
			from: appMod.id,
			to: libInternal.id,
			provenance: "extracted",
			confidence: 0.9,
		});
		return g;
	}

	it("does not run package_boundary_violations when the flag is off, even with a real violation", () => {
		const g = buildCrossPackageGraph();
		expect(
			evaluateStructureRules(g, baseConfig({ package_boundary_violations: false }), []),
		).toEqual([]);
	});

	it("runs package_boundary_violations and returns the exact finding when the flag is on", () => {
		const g = buildCrossPackageGraph();
		const findings = evaluateStructureRules(
			g,
			baseConfig({ package_boundary_violations: true }),
			[],
		);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("package_boundary_violation");
		expect(nonNull(findings[0]).file).toBe("app/src/x.ts");
	});

	describe("public_symbol_test_case gating (2026-09-02: registered)", () => {
		function buildUnreferencedSymbolGraph(): ArtifactGraph {
			const g = new ArtifactGraph();
			const sym = {
				id: makeGlobalRef("public_symbol", "bar"),
				kind: "public_symbol" as const,
				label: "bar",
				file: "src/bar.ts",
				provenance: "declared" as const,
				determinism_ceiling: "fully_deterministic" as const,
			};
			const test = {
				id: makeGlobalRef("test", "bar.test"),
				kind: "test" as const,
				label: "bar.test",
				file: "src/bar.test.ts",
				provenance: "declared" as const,
				determinism_ceiling: "fully_deterministic" as const,
			};
			g.addNode(sym);
			g.addNode(test);
			g.addEdge({
				id: makeEdgeId(test.id, sym.id),
				kind: "tests",
				from: test.id,
				to: sym.id,
				provenance: "declared",
				confidence: 1.0,
			});
			return g;
		}

		// P1: enabled + a real gap (companion test file exists, but never
		// references the symbol by name) → the finding surfaces through the
		// orchestrator, not just the standalone unit test.
		it("P1: runs public_symbol_test_case and returns the exact finding when the flag is on", () => {
			const g = buildUnreferencedSymbolGraph();
			const findings = evaluateStructureRules(
				g,
				baseConfig({ public_symbol_test_case: true }),
				["src/bar.ts"],
			);
			expect(findings).toHaveLength(1);
			expect(nonNull(findings[0]).name).toBe("public_symbol_test_case_missing");
			expect(nonNull(findings[0]).file).toBe("src/bar.ts");
		});

		// N1: same graph, same changed file — flag off ⇒ no findings. Proves
		// the orchestrator actually gates the call rather than always running it.
		it("N1: does not run public_symbol_test_case when the flag is off, even with a real gap", () => {
			const g = buildUnreferencedSymbolGraph();
			expect(
				evaluateStructureRules(
					g,
					baseConfig({ public_symbol_test_case: false }),
					["src/bar.ts"],
				),
			).toEqual([]);
		});
	});

	describe("glossary_residue gating", () => {
		let tmp: string;

		beforeEach(() => {
			tmp = mkdtempSync(join(tmpdir(), "structure-rules-index-"));
		});

		afterEach(() => {
			rmSync(tmp, { recursive: true, force: true });
		});

		it("does not run glossary_residue when the flag is off, even with real repoRoot + residue", () => {
			const g = new ArtifactGraph();
			g.addNode({
				id: makeGlobalRef("term", "Workspace"),
				kind: "term",
				label: "Workspace",
				file: "docs/glossary.md",
				provenance: "declared",
				determinism_ceiling: "fully_deterministic",
				metadata: { deprecated: ["old_workspace"] },
			});
			writeFileSync(join(tmp, "a.ts"), "const x = old_workspace;");

			expect(
				evaluateStructureRules(g, baseConfig({ glossary_residue: false }), ["a.ts"], tmp),
			).toEqual([]);
		});
	});
});
