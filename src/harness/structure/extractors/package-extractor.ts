// ===========================================
// Package Extractor — discovers packages from manifest files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { isRootScratchDir, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

const PACKAGE_MARKERS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

const SKIP_DIRS = SHARED_SKIP_DIRS;

export const metadata: ExtractorMetadata = {
	name: "package-extractor",
	supported_patterns: PACKAGE_MARKERS,
	output_kinds: ["package"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

/** Classify ONE file into its package node, if its basename is a package
 *  marker. Pure path logic (no fs read) — exported for the barrel's per-file
 *  path. `extract` keeps its own walk + the root-fallback + depth sort (those
 *  are aggregate concerns a single-file classify can't decide). */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	const name = path.basename(relPath);
	if (!PACKAGE_MARKERS.includes(name)) return { nodes: [], edges: [] };
	const relDir = path.dirname(relPath);
	const isRoot = relDir === "." || relDir === "";
	const localId = isRoot ? "root" : relDir.replace(/\//g, "-");
	return {
		nodes: [
			{
				id: makeGlobalRef("package", localId),
				kind: "package",
				label: isRoot ? "root" : relDir,
				file: relPath,
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		],
		edges: [],
	};
}

interface WalkContext {
	repoRoot: string;
	results: Array<{ relDir: string; file: string }>;
	budget: WalkBudget;
	ignoredDirs?: ReadonlySet<string>;
}

/** Process one directory entry during the package walk. Returns true when the
 *  caller should stop iterating, i.e. a recursive descent tripped the
 *  truncation flag — mirrors the `return`/`continue` split that used to live
 *  inline in `findPackages`'s loop body. */
function processEntry(entry: fs.Dirent, dir: string, ctx: WalkContext): boolean {
	if (entry.isDirectory()) {
		const sub = path.join(dir, entry.name);
		if (SKIP_DIRS.has(entry.name) || isRootScratchDir(ctx.repoRoot, sub) || ctx.ignoredDirs?.has(sub)) return false;
		findPackages(sub, ctx);
		return ctx.budget.truncated;
	}
	if (entry.isFile() && PACKAGE_MARKERS.includes(entry.name)) {
		const relDir = path.relative(ctx.repoRoot, dir) || ".";
		const relFile = path.relative(ctx.repoRoot, path.join(dir, entry.name));
		ctx.results.push({ relDir, file: relFile });
	}
	return false;
}

function findPackages(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Hard cap: stop descending/iterating once the entry or time budget trips.
		if (!consumeWalkEntry(ctx.budget)) return;
		if (processEntry(entry, dir, ctx)) return;
	}
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	const edges: ArtifactEdge[] = [];
	const packages: Array<{ relDir: string; file: string }> = [];

	findPackages(repoRoot, { repoRoot, results: packages, budget, ignoredDirs: resolveIgnoredDirs(repoRoot) });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);

	if (packages.length === 0) {
		const localId = "root";
		nodes.push({
			id: makeGlobalRef("package", localId),
			kind: "package",
			label: "root",
			file: ".",
			provenance: "extracted",
			determinism_ceiling: "partially_deterministic",
		});
		return { nodes, edges };
	}

	// Sort by directory depth (shallowest first) for containment matching
	packages.sort((a, b) => a.relDir.length - b.relDir.length);

	for (const pkg of packages) {
		const localId = pkg.relDir === "." ? "root" : pkg.relDir.replace(/\//g, "-");
		nodes.push({
			id: makeGlobalRef("package", localId),
			kind: "package",
			label: pkg.relDir === "." ? "root" : pkg.relDir,
			file: pkg.file,
			provenance: "extracted",
			determinism_ceiling: "partially_deterministic",
		});
	}

	return { nodes, edges };
}

/**
 * Creates belongs_to_package edges from module nodes to the nearest containing package.
 * Call after merging module-extractor and package-extractor results.
 */
export function linkModulesToPackages(
	moduleNodes: ArtifactNode[],
	packageNodes: ArtifactNode[],
): ArtifactEdge[] {
	const edges: ArtifactEdge[] = [];
	// Sort packages by path length descending so longest (most specific) match wins
	const sorted = [...packageNodes].sort((a, b) => b.file.length - a.file.length);

	for (const mod of moduleNodes) {
		for (const pkg of sorted) {
			const pkgDir = pkg.file === "." ? "" : path.dirname(pkg.file);
			const isRoot = pkgDir === "" || pkgDir === ".";
			if (isRoot || mod.file.startsWith(`${pkgDir}/`) || mod.file === pkgDir) {
				const edgeId = makeEdgeId(mod.id, pkg.id);
				edges.push({
					id: edgeId,
					kind: "belongs_to_package",
					from: mod.id,
					to: pkg.id,
					provenance: "extracted",
					confidence: 0.95,
				});
				break;
			}
		}
	}
	return edges;
}
