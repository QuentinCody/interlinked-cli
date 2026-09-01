// ============================================================
// Interlinked Harness — Recency-weighted check depth
// ============================================================
// Adapted from the Mythos AI security analysis of curl
// (daniel.haxx.se, 2026-05-11): Mythos found zero bugs in curl's
// hot paths (HTTP/1, TLS, URL parsing) — they were heavily audited.
// All findings landed in colder code that hadn't been touched in
// a long time.
//
// Implication for our harness: expensive advisory checks should
// run preferentially on RECENTLY-MODIFIED files. Files that
// haven't changed in months are well-audited by the previous
// pipeline runs and don't need re-checking every edit. We tier
// files by git-blame age:
//
//   - "hot"  : modified within 7 days   → run all advisory checks
//   - "warm" : modified within 6 months → run all advisory checks
//   - "cold" : older than 6 months      → block-class checks only
//
// Untracked / newly-added files are NOT in the priority map.
// shouldRunAdvisoryChecks fails OPEN for those — new code is
// where bugs live and never gets the cold treatment.
//
// Data source: one `git log` invocation at SessionStart populates
// the full repo's map (~1s for typical repos). Cached to
// `.interlinked/file-priority.json` with a 24h TTL so subsequent
// sessions skip the git call.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nonNull } from "../lib/non-null.js";

/** Priority tier for a tracked file. */
type PriorityTier = "hot" | "warm" |"cold";

/** Per-file priority entry. */
export interface FilePriority {
	/** Days since the file was last modified in git history.
	 *  -1 indicates unknown / never-tracked. */
	ageDays: number;
	/** Derived tier — see module header for thresholds. */
	tier: PriorityTier;
}

/** Cache file shape — written to `.interlinked/file-priority.json`. */
export interface PriorityCache {
	/** Schema version. Bump when shape changes. */
	version: 1;
	/** Unix-ms when computed. */
	computedAt: number;
	/** Map of relative-path → priority entry, serialized as a plain
	 *  object so it round-trips through JSON. */
	files: Record<string, FilePriority>;
}

/** Tier thresholds. Exposed for tests and tuning. */
export const HOT_DAYS_MAX = 7;
export const WARM_DAYS_MAX = 180;

/** Cache TTL — refresh at most once per day. */
export const PRIORITY_TTL_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GIT_LOG_LOOKBACK_DAYS = 365;
const GIT_LOG_TIMEOUT_MS = 30_000;

/** Map a day-age to a priority tier. Negative values → "cold"
 *  (treated as unknown / never-tracked). */
export function priorityTierForAge(ageDays: number): PriorityTier {
	if (ageDays < 0) return "cold";
	if (ageDays < HOT_DAYS_MAX) return "hot";
	if (ageDays <= WARM_DAYS_MAX) return "warm";
	return "cold";
}

/** Parse `git log --format=%ct --name-only --since=<date>` output
 *  into a per-file priority map. The output is groups of
 *      <unix-timestamp>\n<file>\n<file>\n\n<unix-timestamp>\n...
 *  Most-recent-first (git default). For each file, the FIRST
 *  occurrence wins because subsequent ones are older. */
export function parseGitLogOutput(
	stdout: string,
	now: number,
): Map<string, FilePriority> {
	const out = new Map<string, FilePriority>();
	const blocks = stdout.split(/\n\s*\n/);
	for (const block of blocks) {
		const trimmed = block.trim();
		if (!trimmed) continue;
		const lines = trimmed.split("\n");
		const ts = Number.parseInt(nonNull(lines[0]), 10);
		if (!Number.isFinite(ts) || ts <= 0) continue;
		const commitMs = ts * 1000;
		const ageDays = Math.max(0, Math.round((now - commitMs) / MS_PER_DAY));
		for (let i = 1; i < lines.length; i++) {
			const path = nonNull(lines[i]).trim();
			if (!path) continue;
			if (out.has(path)) continue; // Most-recent wins.
			out.set(path, { ageDays, tier: priorityTierForAge(ageDays) });
		}
	}
	return out;
}

/** Decide whether to run advisory checks on a given file. Hot and
 *  warm files: yes. Cold files: no. Files not in the map (untracked
 *  / brand new): yes (fail-open). */
export function shouldRunAdvisoryChecks(
	filePath: string,
	priority: Map<string, FilePriority>,
): boolean {
	const entry = priority.get(filePath);
	if (!entry) return true;
	return entry.tier !== "cold";
}

/** Run `git log` to compute the priority map. Returns an empty map
 *  on any git failure — discovery is best-effort, never blocks. */
export function computeFilePriority(
	repoRoot: string,
	now: number = Date.now(),
): Map<string, FilePriority> {
	const result = spawnSync(
		"git",
		[
			"-C",
			repoRoot,
			"log",
			"--format=%ct",
			"--name-only",
			`--since=${GIT_LOG_LOOKBACK_DAYS} days ago`,
		],
		{ encoding: "utf-8", timeout: GIT_LOG_TIMEOUT_MS },
	);
	if (result.status !== 0 || !result.stdout) return new Map();
	return parseGitLogOutput(result.stdout, now);
}

function cachePath(repoRoot: string): string {
	return join(repoRoot, ".interlinked", "file-priority.json");
}

/** Load the cached priority map. Returns null when absent or malformed. */
export function loadPriorityCache(repoRoot: string): PriorityCache | null {
	const path = cachePath(repoRoot);
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		const c = raw as Partial<PriorityCache>;
		if (c.version !== 1 || typeof c.files !== "object" || !c.files) return null;
		return {
			version: 1,
			computedAt: typeof c.computedAt === "number" ? c.computedAt : 0,
			files: c.files as Record<string, FilePriority>,
		};
	} catch {
		return null;
	}
}

/** Persist the priority cache, creating `.interlinked/` if absent. */
export function savePriorityCache(repoRoot: string, cache: PriorityCache): void {
	const path = cachePath(repoRoot);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
}

/** Refresh the priority map if the cache is missing or stale.
 *  Returns the active per-file map. */
export function refreshPriorityIfStale(
	repoRoot: string,
	now: number = Date.now(),
	ttlMs: number = PRIORITY_TTL_MS,
): Map<string, FilePriority> {
	const cache = loadPriorityCache(repoRoot);
	if (cache && now - cache.computedAt < ttlMs) {
		return new Map(Object.entries(cache.files));
	}
	const fresh = computeFilePriority(repoRoot, now);
	const files: Record<string, FilePriority> = {};
	for (const [k, v] of fresh) files[k] = v;
	savePriorityCache(repoRoot, { version: 1, computedAt: now, files });
	return fresh;
}
