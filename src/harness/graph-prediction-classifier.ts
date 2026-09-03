// ===========================================
// Graph-prediction case classifier
// ===========================================
// Two layers, each cheap, run on every PreToolUse for a file-write tool.
//
//  1. workspaceSupermodelActive(cwd) — is Supermodel's daemon active in
//     this repo? Detected via at least one shard-near-source pair in
//     non-excluded paths. Cached with a short TTL so cold-scan cost is
//     paid at most once per minute.
//
//  2. classifyCase(filePath, cwd) — per-target case A/B/C/D/E-fresh/
//     E-stale per `docs/design/graph-prediction-protocol.md §3`. Only
//     Case E-fresh activates the predict/reveal/reconcile protocol;
//     other cases are observation-only.
//
// The cwd-named exclude list intentionally covers the dirs that hold
// `.graph.*` files for non-Supermodel reasons — fixtures (this repo),
// vendored packages (reference-repos/), build outputs (dist/, build/,
// out/), and node_modules/. Without it, every edit in this repo would
// trip case detection against fixtures.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { shardPathFor } from "./supermodel-graph.js";

const STALENESS_GRACE_MS = 60_000;
const ACTIVE_CACHE_TTL_MS = 60_000;

const SKIP_DESCEND_DIRS = new Set([".git", ".interlinked"]);

const EXCLUDE_FRAGMENTS = [
	"/__tests__/fixtures/",
	"/__fixtures__/",
	"/test-fixtures/",
	"/reference-repos/",
	"/node_modules/",
	"/dist/",
	"/build/",
	"/out/",
];

const SHARD_RE = /\.graph(\.[a-zA-Z0-9]+)?$/i;

const IMPORT_RE =
	/(?:^|\n)\s*(?:import\b|from\s+['"]|require\s*\(|use\s+\w|#include\b)/;

interface ActiveCacheEntry {
	active: boolean;
	cachedAt: number;
}

const activeCache = new Map<string, ActiveCacheEntry>();

/** Test-only: reset the workspace-active cache between test cases.
 *  Production code never calls this. */
export function resetWorkspaceActiveCache(): void {
	activeCache.clear();
}

/** Returns true iff this repo runs Supermodel's daemon — at least one
 *  shard-near-source pair exists in non-excluded paths, and there is no
 *  explicit `.interlinked/config.json#supermodel.enabled: false` opt-out. */
export function workspaceSupermodelActive(cwd: string): boolean {
	const abs = resolve(cwd);
	const cached = activeCache.get(abs);
	const now = Date.now();
	if (cached && now - cached.cachedAt < ACTIVE_CACHE_TTL_MS) return cached.active;

	if (configOptOut(abs)) {
		activeCache.set(abs, { active: false, cachedAt: now });
		return false;
	}

	const active = scanForShardNearSourcePair(abs);
	activeCache.set(abs, { active, cachedAt: now });
	return active;
}

function configOptOut(absCwd: string): boolean {
	const configPath = join(absCwd, ".interlinked", "config.json");
	if (!existsSync(configPath)) return false;
	let cfg: unknown;
	try {
		cfg = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return false;
	}
	if (typeof cfg !== "object" || cfg === null) return false;
	const supermodel = (cfg as { supermodel?: unknown }).supermodel;
	if (typeof supermodel !== "object" || supermodel === null) return false;
	return (supermodel as { enabled?: unknown }).enabled === false;
}

function isExcluded(absPath: string): boolean {
	const p = absPath.replace(/\\/g, "/");
	const padded = p.endsWith("/") ? p : `${p}/`;
	for (const frag of EXCLUDE_FRAGMENTS) {
		if (padded.includes(frag)) return true;
	}
	return false;
}

/** Examines one directory entry: pushes a descendable subdirectory onto
 *  `stack`, and reports true iff the entry is a shard whose source file
 *  exists (a match for the caller's scan). */
function scanDirEntry(ent: import("node:fs").Dirent, dir: string, stack: string[]): boolean {
	const name = String(ent.name);
	const full = join(dir, name);
	if (ent.isDirectory()) {
		if (!SKIP_DESCEND_DIRS.has(name)) stack.push(full);
		return false;
	}
	if (!ent.isFile()) return false;
	if (!SHARD_RE.test(name)) return false;
	if (isExcluded(full)) return false;
	const sourcePath = sourcePathForShard(full);
	return sourcePath !== null && existsSync(sourcePath);
}

/** Processes one directory popped from the scan stack: pushes its
 *  subdirectories onto `stack` and returns true iff one of its files is a
 *  shard whose source file exists (a match for the caller's scan). */
function processStackLength(dir: string, stack: string[]): boolean {
	if (isExcluded(dir)) return false;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
	} catch {
		return false;
	}
	for (const ent of entries) {
		if (scanDirEntry(ent, dir, stack)) return true;
	}
	return false;
}

function scanForShardNearSourcePair(absCwd: string): boolean {
	const stack: string[] = [absCwd];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		if (processStackLength(dir, stack)) return true;
	}
	return false;
}

function sourcePathForShard(shardPath: string): string | null {
	const m = shardPath.match(SHARD_RE);
	if (!m) return null;
	const suffix = m[1] ?? "";
	return shardPath.slice(0, shardPath.length - m[0].length) + suffix;
}

export type GraphPredictionCase = "A" | "B" | "C" | "D" | "E-fresh" | "E-stale";

export interface CaseResult {
	case: GraphPredictionCase;
	sourcePath: string;
	shardPath: string | null;
	sourceMtime: string | null;
	shardMtime: string | null;
}

export interface CaseClassifyOptions {
	/** Planned content of the file being written (Write's `tool_input.content`
	 *  or first new_string of an Edit). Used to distinguish Case B (imports
	 *  declared) from Case C (greenfield). */
	toolInputContent?: string | undefined;
}

export function classifyCase(
	filePath: string,
	cwd: string,
	options: CaseClassifyOptions = {},
): CaseResult {
	const absCwd = resolve(cwd);
	const absSource = isAbsolute(filePath) ? resolve(filePath) : resolve(absCwd, filePath);

	if (!workspaceSupermodelActive(absCwd)) {
		return { case: "A", sourcePath: absSource, shardPath: null, sourceMtime: null, shardMtime: null };
	}

	if (!existsSync(absSource)) {
		const content = options.toolInputContent ?? "";
		return {
			case: IMPORT_RE.test(content) ? "B" : "C",
			sourcePath: absSource,
			shardPath: null,
			sourceMtime: null,
			shardMtime: null,
		};
	}

	const absShard = shardPathFor(absSource);
	if (!existsSync(absShard)) {
		return {
			case: "D",
			sourcePath: absSource,
			shardPath: null,
			sourceMtime: null,
			shardMtime: null,
		};
	}

	const sourceMtime = statSync(absSource).mtimeMs;
	const shardMtime = statSync(absShard).mtimeMs;
	const fresh = shardMtime >= sourceMtime - STALENESS_GRACE_MS;
	return {
		case: fresh ? "E-fresh" : "E-stale",
		sourcePath: absSource,
		shardPath: absShard,
		sourceMtime: new Date(sourceMtime).toISOString(),
		shardMtime: new Date(shardMtime).toISOString(),
	};
}
