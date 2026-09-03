// ===========================================
// Config Extractor — discovers config access patterns in JS/TS files
// ===========================================

import * as fs from "node:fs";
import * as path from "node:path";
import { nonNull } from "../../../lib/non-null.js";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode, ExtractorMetadata, ExtractorResult } from "../types.js";
import { consumeWalkEntry, createWalkBudget, type WalkBudget, warnWalkTruncated } from "./bounded-walk.js";
import { isRootScratchDir, resolveIgnoredDirs, SHARED_SKIP_DIRS } from "./skip-dirs.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const SKIP_DIRS = SHARED_SKIP_DIRS;

const CONFIG_PATTERNS = [
	/config\.get\(["']([a-zA-Z0-9_.]+)["']\)/g,
	/config\[["']([a-zA-Z0-9_.]+)["']\]/g,
	/config\.([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)/g,
];

export const metadata: ExtractorMetadata = {
	name: "config-extractor",
	supported_patterns: ['config.get("key")', 'config["key"]', "config.key.subkey"],
	output_kinds: ["config_key"],
	provenance: "extracted",
	max_determinism: "heuristic",
	version: 1,
};

function scanFile(content: string, configKeys: Map<string, string>, relPath: string): void {
	for (const pattern of CONFIG_PATTERNS) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(content);
			if (match === null) break;
			const key = nonNull(match[1]);
			if (!configKeys.has(key)) {
				configKeys.set(key, relPath);
			}
		}
	}
}

/** Classify ONE source file into its config_key nodes by scanning for config
 *  access patterns. Reads the file (catch → no keys) so it works per-edited-file
 *  in the incremental refresh; aggregate dedup (first-seen key) is the caller's
 *  job. Exported for the barrel's per-file path; `extract` keeps its own walk. */
export function classifyFile(repoRoot: string, relPath: string): ExtractorResult {
	if (!SOURCE_EXTENSIONS.has(path.extname(relPath))) return { nodes: [], edges: [] };
	let content: string;
	try {
		content = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
	} catch {
		return { nodes: [], edges: [] };
	}
	const configKeys = new Map<string, string>();
	scanFile(content, configKeys, relPath);
	const nodes: ArtifactNode[] = [];
	for (const [key, file] of configKeys) {
		nodes.push({
			id: makeGlobalRef("config_key", key),
			kind: "config_key",
			label: key,
			file,
			provenance: "extracted",
			determinism_ceiling: "heuristic",
		});
	}
	return { nodes, edges: [] };
}

interface WalkContext {
	repoRoot: string;
	configKeys: Map<string, string>;
	budget: WalkBudget;
	ignoredDirs?: ReadonlySet<string>;
}

/** Handle one directory entry for `walkDir`: recurse into subdirectories
 *  (skipping ignored ones) or scan a source file's config-access patterns.
 *  A Dirent is never both a directory and a file, so the guard-clause
 *  returns below are mutually exclusive, matching the original else-if. */
function processWalkEntry(dir: string, entry: fs.Dirent, ctx: WalkContext): void {
	if (entry.isDirectory()) {
		const sub = path.join(dir, entry.name);
		if (SKIP_DIRS.has(entry.name) || isRootScratchDir(ctx.repoRoot, sub) || ctx.ignoredDirs?.has(sub)) return;
		walkDir(sub, ctx);
		return;
	}
	if (!entry.isFile()) return;
	const ext = path.extname(entry.name);
	if (!SOURCE_EXTENSIONS.has(ext)) return;
	const fullPath = path.join(dir, entry.name);
	const relPath = path.relative(ctx.repoRoot, fullPath);
	try {
		const content = fs.readFileSync(fullPath, "utf-8");
		scanFile(content, ctx.configKeys, relPath);
	} catch (_err) {
		void 0; /* intentional: skip unreadable files */
	}
}

function walkDir(dir: string, ctx: WalkContext): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		// Hard cap: stop descending/iterating once the entry or time budget trips.
		if (!consumeWalkEntry(ctx.budget)) return;
		processWalkEntry(dir, entry, ctx);
		if (ctx.budget.truncated) return;
	}
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	const configKeys = new Map<string, string>();
	walkDir(repoRoot, { repoRoot, configKeys, budget, ignoredDirs: resolveIgnoredDirs(repoRoot) });
	if (budget.truncated) warnWalkTruncated(metadata.name, repoRoot);
	const nodes: ArtifactNode[] = [];
	for (const [key, file] of configKeys) {
		const localId = key;
		nodes.push({
			id: makeGlobalRef("config_key", localId),
			kind: "config_key",
			label: key,
			file,
			provenance: "extracted",
			determinism_ceiling: "heuristic",
		});
	}
	return { nodes, edges: [] };
}
