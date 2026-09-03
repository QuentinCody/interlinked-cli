import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractorResult } from "../types.js";
import { createWalkBudget } from "./bounded-walk.js";
import { walkAndClassify } from "./walk-classify.js";

/** Minimal classifier: one node per `.ts` file, labelled with its relative path. */
function tsClassifier(_repoRoot: string, relPath: string): ExtractorResult {
	if (!relPath.endsWith(".ts")) return { nodes: [], edges: [] };
	return {
		nodes: [
			{
				id: `module:${relPath}`,
				kind: "module",
				label: relPath,
				file: relPath,
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		],
		edges: [],
	};
}

/** Classifier that also emits an edge, to prove edges are collected. */
function edgeClassifier(_repoRoot: string, relPath: string): ExtractorResult {
	const base = tsClassifier(_repoRoot, relPath);
	if (base.nodes.length === 0) return base;
	return {
		nodes: base.nodes,
		edges: [
			{
				id: `edge:${relPath}`,
				kind: "tests",
				from: `module:${relPath}`,
				to: "module:other",
				provenance: "inferred",
				confidence: 0.7,
			},
		],
	};
}

describe("walkAndClassify", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "walk-classify-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("classifies every file under the root, recursing into subdirectories", () => {
		mkdirSync(join(tmp, "src", "deep"), { recursive: true });
		writeFileSync(join(tmp, "top.ts"), "");
		writeFileSync(join(tmp, "src", "a.ts"), "");
		writeFileSync(join(tmp, "src", "deep", "b.ts"), "");
		writeFileSync(join(tmp, "src", "skip.md"), "");

		const { nodes, edges } = walkAndClassify(tmp, { classify: tsClassifier, budget: createWalkBudget(), extractorName: "probe" });
		expect(nodes.map((n) => n.label).sort()).toEqual(["src/a.ts", "src/deep/b.ts", "top.ts"]);
		expect(edges).toEqual([]);
	});

	it("collects edges the classifier returns", () => {
		writeFileSync(join(tmp, "a.ts"), "");
		const { nodes, edges } = walkAndClassify(tmp, { classify: edgeClassifier, budget: createWalkBudget(), extractorName: "probe" });
		expect(nodes).toHaveLength(1);
		expect(edges.map((e) => e.id)).toEqual(["edge:a.ts"]);
	});

	it("skips the shared artefact directories", () => {
		mkdirSync(join(tmp, "node_modules", "lib"), { recursive: true });
		writeFileSync(join(tmp, "node_modules", "lib", "a.ts"), "");
		mkdirSync(join(tmp, "dist"), { recursive: true });
		writeFileSync(join(tmp, "dist", "b.ts"), "");
		writeFileSync(join(tmp, "keep.ts"), "");

		const { nodes } = walkAndClassify(tmp, { classify: tsClassifier, budget: createWalkBudget(), extractorName: "probe" });
		expect(nodes.map((n) => n.label)).toEqual(["keep.ts"]);
	});

	it("skips the repo-root scratch directory but not a nested one", () => {
		mkdirSync(join(tmp, "scratch"), { recursive: true });
		writeFileSync(join(tmp, "scratch", "probe.ts"), "");
		mkdirSync(join(tmp, "src", "scratch"), { recursive: true });
		writeFileSync(join(tmp, "src", "scratch", "real.ts"), "");

		const { nodes } = walkAndClassify(tmp, { classify: tsClassifier, budget: createWalkBudget(), extractorName: "probe" });
		expect(nodes.map((n) => n.label)).toEqual(["src/scratch/real.ts"]);
	});

	it("returns an empty result when the root cannot be read", () => {
		const result = walkAndClassify(join(tmp, "missing"), {
			classify: tsClassifier,
			budget: createWalkBudget(),
			extractorName: "probe",
		});
		expect(result).toEqual({ nodes: [], edges: [] });
	});

	it("stops and warns once the walk budget is exhausted", () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		mkdirSync(join(tmp, "src"), { recursive: true });
		for (let i = 0; i < 5; i += 1) writeFileSync(join(tmp, "src", `f${i}.ts`), "");

		const budget = createWalkBudget();
		budget.entriesVisited = Number.MAX_SAFE_INTEGER;
		const { nodes } = walkAndClassify(tmp, { classify: tsClassifier, budget: budget, extractorName: "probe-extractor" });
		expect(nodes).toEqual([]);
		expect(budget.truncated).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("probe-extractor");
	});

	it("does not warn when the walk completes inside its budget", () => {
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		writeFileSync(join(tmp, "a.ts"), "");
		walkAndClassify(tmp, { classify: tsClassifier, budget: createWalkBudget(), extractorName: "probe" });
		expect(warn).not.toHaveBeenCalled();
	});
});
