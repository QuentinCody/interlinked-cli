// ===========================================
// Git-visible path discovery for workspace effect capture
// ===========================================
//
// Enumerates the file paths a workspace snapshot should fingerprint: git's
// tracked/untracked view when available, or a bounded directory walk when
// git is unavailable. Companion to workspace-effects.ts.

import { execFileSync } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const MAX_FILES = 25_000;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
export const FALLBACK_SKIP_DIRS = new Set([
	".git",
	".interlinked",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".next",
	".wrangler",
	".stryker-tmp",
	"stryker-tmp",
	".scratch",
	"scratch",
	"tmp",
]);

export function isInside(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

export function gitVisiblePaths(root: string): string[] | null {
	try {
		const raw = execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{
				cwd: root,
				encoding: "utf8",
				maxBuffer: MAX_GIT_LIST_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return [...new Set(raw.split("\0").filter(Boolean))];
	} catch {
		return null;
	}
}

export function gitStandaloneIgnoredPaths(root: string): { paths: string[]; complete: boolean } {
	try {
		const raw = execFileSync(
			"git",
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
			{
				cwd: root,
				encoding: "utf8",
				maxBuffer: MAX_GIT_LIST_BYTES,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		// `--directory` deliberately collapses wholly ignored trees to `dir/`.
		// Skip those markers; standalone ignored files (for example `.env` or
		// `.claude/settings.local.json`) retain concrete paths and are observed.
		const entries = raw.split("\0").filter(Boolean);
		const paths = [...new Set(entries.filter((path) => {
			if (!path || path.endsWith("/")) return false;
			const parentSegments = path.split(/[\\/]/).slice(0, -1);
			return !parentSegments.some((segment) => FALLBACK_SKIP_DIRS.has(segment));
		}))];
		return { paths, complete: !entries.some((path) => path.endsWith("/")) };
	} catch {
		return { paths: [], complete: false };
	}
}

// Processes one directory's entries: pushes subdirectories onto `queue`,
// pushes files/symlinks onto `paths`. Returns true once `paths` has reached
// MAX_FILES, signaling the caller to stop scanning further directories.
function processDirEntries(
	dir: string,
	root: string,
	entries: Dirent[],
	paths: string[],
	queue: string[],
): boolean {
	for (const entry of entries) {
		if (entry.isDirectory() && FALLBACK_SKIP_DIRS.has(entry.name)) continue;
		const absolute = resolve(dir, entry.name);
		if (!isInside(root, absolute)) continue;
		if (entry.isDirectory()) queue.push(absolute);
		else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative(root, absolute));
		if (paths.length >= MAX_FILES) return true;
	}
	return false;
}

export function fallbackVisiblePaths(root: string): { paths: string[]; complete: boolean } {
	const paths: string[] = [];
	const queue = [root];
	let complete = true;
	while (queue.length > 0 && paths.length < MAX_FILES) {
		const dir = queue.pop();
		if (!dir) break;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			complete = false;
			continue;
		}
		if (processDirEntries(dir, root, entries, paths, queue)) complete = false;
	}
	if (queue.length > 0) complete = false;
	return { paths, complete };
}
