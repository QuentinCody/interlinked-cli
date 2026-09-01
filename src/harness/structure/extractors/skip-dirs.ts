// ===========================================
// Shared skip-dir list for extractors
// ===========================================
// Centralised so a new "obviously not project code" directory only needs
// to be added once instead of seven times. Each extractor walks the repo
// from `repoRoot` and skips any directory whose basename is in this set OR
// whose path the repo's .gitignore excludes (see resolveDirSkipper).
//
// History: `reference-repos/` was missing from this list, and 7 extractors
// were each walking 38K+ files there on every PostToolUse Edit (273k+ stat
// syscalls per event, ~25s of `scored_suggestions` phase time). Adding it
// here closed that — but a static basename list can only ever name UNIVERSAL
// artefact dirs. A project's OWN heavy non-source trees (gitignored model
// weights, build output under a custom name, vendored data) are exactly what
// its `.gitignore` already declares, so we honour that too: one `git` call per
// repo prunes gigabytes the basename list can't name — e.g. a 2.4G gitignored
// `evals/local-models/` that was driving the daemon into OOM restarts on a
// large monorepo.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Basename-only directory names that no extractor should descend into.
 *  Order is irrelevant; new entries can be appended at any time. */
export const SHARED_SKIP_DIRS: ReadonlySet<string> = new Set([
	// VCS + generic build artefacts
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	"out",
	"__pycache__",
	"target",
	// Framework / bundler build + cache output (never project source)
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	".parcel-cache",
	".wrangler",
	"coverage",
	// Python virtualenvs + tool caches
	".venv",
	"venv",
	".tox",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	// JVM
	".gradle",
	// Interlinked's own data dirs
	".interlinked",
	"interlinked",
	// External code the user keeps locally for browsing / cross-referencing.
	// Contains tens of thousands of files from cloned upstream repos and is
	// not part of this project's artefact graph by definition.
	"reference-repos",
]);

/** Whether `absDir` is the repository-root scratch home provisioned by
 * `interlinked scratch`. This is deliberately path-specific: a real nested
 * package such as `src/scratch/` remains ordinary project source. */
export function isRootScratchDir(repoRoot: string, absDir: string): boolean {
	return absDir === join(repoRoot, "scratch");
}

// ── Gitignore-aware directory skipping ───────────────────────────────────────

/** Runs the `git ls-files` ignored-directory listing and returns raw stdout,
 *  or null when git is unavailable / the path is not a repo / it times out.
 *  Injectable so the walk's gitignore awareness is unit-testable without git. */
type GitIgnoredDirRunner = (repoRoot: string) => string | null;

/** Cap git's stdout so a pathological ignore listing can't balloon memory. */
const GIT_LS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Hard timeout for the ignored-dir query; on a slow disk we fail open rather
 *  than stall the structure build. */
const GIT_LS_TIMEOUT_MS = 2_000;

const defaultGitIgnoredDirRunner: GitIgnoredDirRunner = (repoRoot) => {
	try {
		return execFileSync(
			"git",
			["-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
			{
				encoding: "utf-8",
				timeout: GIT_LS_TIMEOUT_MS,
				maxBuffer: GIT_LS_MAX_BUFFER_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
	} catch {
		return null; // not a git repo / git missing / timed out → fail open
	}
};

interface CachedIgnoredDirs {
	at: number;
	dirs: ReadonlySet<string>;
}

const ignoredDirCache = new Map<string, CachedIgnoredDirs>();

/** Re-query git at most this often per repo. Structure builds fire on every
 *  edit; `.gitignore` changes rarely, so a short TTL keeps the cost to ~one
 *  git call per repo per minute while still picking up edits within a minute. */
const IGNORED_DIRS_TTL_MS = 60_000;

/** Absolute paths of the directories this repo's `.gitignore` fully excludes,
 *  under `repoRoot`. Memoized per repo (TTL). `git ls-files --directory`
 *  collapses a fully-ignored directory to "<path>/"; we keep only those
 *  (ignored FILES are irrelevant to directory pruning) and resolve each to an
 *  absolute path so a walk can test `ignored.has(join(dir, name))` directly.
 *  Fails open to an empty set (non-git repo / git missing) — the basename list
 *  still applies. */
export function resolveIgnoredDirs(
	repoRoot: string,
	runner: GitIgnoredDirRunner = defaultGitIgnoredDirRunner,
	clock: () => number = Date.now,
): ReadonlySet<string> {
	const now = clock();
	const cached = ignoredDirCache.get(repoRoot);
	if (cached && now - cached.at < IGNORED_DIRS_TTL_MS) return cached.dirs;
	const dirs = parseIgnoredDirs(repoRoot, runner(repoRoot));
	ignoredDirCache.set(repoRoot, { at: now, dirs });
	return dirs;
}

function parseIgnoredDirs(repoRoot: string, stdout: string | null): ReadonlySet<string> {
	const dirs = new Set<string>();
	if (!stdout) return dirs;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		// Only fully-ignored directories (trailing "/"); ignored files are skipped.
		if (!trimmed.endsWith("/")) continue;
		dirs.add(join(repoRoot, trimmed.slice(0, -1)));
	}
	return dirs;
}

/** Predicate an extractor walk applies to each child directory: skip it when
 *  its basename is a universal artefact dir OR its absolute path is gitignored
 *  in this repo. */
type DirSkipper = (basename: string, absDir: string) => boolean;

/** Build the dir-skip predicate for one walk over `repoRoot`: the universal
 *  basename set plus this repo's gitignored directories (resolved once,
 *  memoized). Every extractor calls this at the top of its `extract()` so
 *  gigabytes of gitignored data are never descended into. */
export function resolveDirSkipper(
	repoRoot: string,
	runner: GitIgnoredDirRunner = defaultGitIgnoredDirRunner,
): DirSkipper {
	const ignored = resolveIgnoredDirs(repoRoot, runner);
	return (basename, absDir) => SHARED_SKIP_DIRS.has(basename) || ignored.has(absDir);
}
