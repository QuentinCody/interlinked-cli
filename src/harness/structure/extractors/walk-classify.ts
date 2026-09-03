// ===========================================
// Walk + classify — the shared path-only extractor traversal
// ===========================================
// The docs / examples / module / test extractors differ ONLY in how they
// classify one file path; the recursive walk around that classifier (skip-dir
// filtering, gitignore pruning, root-scratch exemption, bounded-walk budget,
// truncation warning) was copied verbatim into each of them. It is traversal
// infrastructure, not per-kind policy, so it lives here once — alongside the
// budget (bounded-walk.ts) and the skip list (skip-dirs.ts) that were extracted
// for the same reason.
//
// Extractors that must READ file CONTENT (env / config / package) keep their
// own walks: their per-file step is not a pure path classifier.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ArtifactEdge, ArtifactNode, ExtractorResult } from "../types.js";
import { consumeWalkEntry, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { isRootScratchDir, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

/** Classifies ONE repo-relative path into its nodes/edges, using path/name
 *  logic only (no filesystem read). Each extractor exports one of these. */
export type FileClassifier = (repoRoot: string, relPath: string) => ExtractorResult;

interface WalkContext {
	repoRoot: string;
	classify: FileClassifier;
	nodes: ArtifactNode[];
	edges: ArtifactEdge[];
	budget: WalkBudget;
	ignoredDirs: ReadonlySet<string>;
}

/** Directory entries of `dir`, or none when it cannot be read (missing,
 *  permission-denied, replaced mid-walk) — an unreadable directory contributes
 *  nothing rather than aborting the walk. */
function readEntries(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** A child directory is pruned when its basename is a universal artefact dir,
 *  it is the repo-root scratch tree, or this repo's .gitignore excludes it. */
function isPrunedDir(ctx: WalkContext, basename: string, absDir: string): boolean {
	return SHARED_SKIP_DIRS.has(basename) || isRootScratchDir(ctx.repoRoot, absDir) || ctx.ignoredDirs.has(absDir);
}

function collectFile(ctx: WalkContext, absFile: string): void {
	const relPath = path.relative(ctx.repoRoot, absFile);
	const result = ctx.classify(ctx.repoRoot, relPath);
	ctx.nodes.push(...result.nodes);
	ctx.edges.push(...result.edges);
}

function walkDir(dir: string, ctx: WalkContext): void {
	for (const entry of readEntries(dir)) {
		// Hard cap: stop descending/iterating once the entry or time budget trips.
		if (!consumeWalkEntry(ctx.budget)) return;
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (isPrunedDir(ctx, entry.name, abs)) continue;
			walkDir(abs, ctx);
			if (ctx.budget.truncated) return;
		} else if (entry.isFile()) {
			collectFile(ctx, abs);
		}
	}
}

export interface WalkClassifyOptions {
	/** The extractor's per-file path classifier. */
	classify: FileClassifier;
	/** Shared hard cap for this walk (see bounded-walk.ts). */
	budget: WalkBudget;
	/** Extractor name used in the truncation warning. */
	extractorName: string;
}

/**
 * Walks `repoRoot` under the given budget, applying `classify` to every file
 * that survives skip-dir and gitignore pruning, and returns everything it
 * produced. Warns once (stderr, non-blocking) under `extractorName` when the
 * budget truncated the walk, so a partial artifact graph is never silent.
 */
export function walkAndClassify(repoRoot: string, opts: WalkClassifyOptions): ExtractorResult {
	const nodes: ArtifactNode[] = [];
	const edges: ArtifactEdge[] = [];
	walkDir(repoRoot, {
		repoRoot,
		classify: opts.classify,
		nodes,
		edges,
		budget: opts.budget,
		ignoredDirs: resolveIgnoredDirs(repoRoot),
	});
	if (opts.budget.truncated) warnWalkTruncated(opts.extractorName, repoRoot);
	return { nodes, edges };
}
