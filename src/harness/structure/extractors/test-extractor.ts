// ===========================================
// Test Extractor — discovers test files by naming conventions
// ===========================================

import * as path from "node:path";
import { makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { createWalkBudget, type WalkBudget } from "./bounded-walk.js";
import { walkAndClassify } from "./walk-classify.js";

const TEST_PATTERNS = [
	/\.test\.[tj]sx?$/,
	/\.spec\.[tj]sx?$/,
	/_test\.go$/,
	/_test\.py$/,
	/^test_.*\.py$/,
];

const TEST_DIRS = new Set(["__tests__", "tests", "test"]);

export const metadata: ExtractorMetadata = {
	name: "test-extractor",
	supported_patterns: [
		"*.test.ts",
		"*.spec.ts",
		"*.test.js",
		"*.spec.js",
		"*_test.go",
		"*_test.py",
		"test_*.py",
	],
	output_kinds: ["test"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

function isTestFile(name: string): boolean {
	return TEST_PATTERNS.some((p) => p.test(name));
}

function isUnderTestDir(relPath: string): boolean {
	const parts = relPath.split("/");
	return parts.some((p) => TEST_DIRS.has(p));
}

function inferTestedModule(relPath: string): string | null {
	const dir = path.dirname(relPath);
	const base = path.basename(relPath);
	// src/foo.test.ts -> src/foo.ts
	const stripped = base
		.replace(/\.test(\.[tj]sx?)$/, "$1")
		.replace(/\.spec(\.[tj]sx?)$/, "$1")
		.replace(/_test(\.go)$/, "$1")
		.replace(/_test(\.py)$/, "$1")
		.replace(/^test_(.*\.py)$/, "$1");
	if (stripped === base) return null;
	// If under __tests__/, look one directory up
	const parentDir = path.basename(dir);
	const moduleDir = TEST_DIRS.has(parentDir) ? path.dirname(dir) : dir;
	return path.join(moduleDir, stripped);
}

/** Classify ONE file into its test node (+ a tests→module edge when the tested
 *  module can be inferred), if it is a test file by naming convention or
 *  location. The single source of the test-node shape for the full walk and the
 *  per-edited-file refresh. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	const name = path.basename(relPath);
	if (!isTestFile(name) && !isUnderTestDir(relPath)) return { nodes: [], edges: [] };
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	const testRef = makeGlobalRef("test", localId);
	const nodes: ArtifactNode[] = [
		{
			id: testRef,
			kind: "test",
			label: relPath,
			file: relPath,
			provenance: "inferred",
			determinism_ceiling: "heuristic",
		},
	];
	const edges: ArtifactEdge[] = [];
	const testedPath = inferTestedModule(relPath);
	if (testedPath) {
		const moduleRef = makeGlobalRef("module", testedPath.replace(/\//g, "-").replace(/\.[^.]+$/, ""));
		edges.push({
			id: makeEdgeId(testRef, moduleRef),
			kind: "tests",
			from: testRef,
			to: moduleRef,
			provenance: "inferred",
			confidence: 0.7,
		});
	}
	return { nodes, edges };
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	return walkAndClassify(repoRoot, { classify: classifyFile, budget, extractorName: metadata.name });
}
