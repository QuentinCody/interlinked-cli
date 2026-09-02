// ===========================================
// Session Git Baseline — SessionStart working-tree snapshot
// ===========================================
// Standalone helper lifted out of session-state.ts. Captures the git
// working-tree state once at session start so downstream channels (the
// git-session-scope-gate, rollback feasibility) can separate "pre-existing
// dirty" from "this session touched it". Kept dependency-free (just
// `execFileSync`) so it stays trivially testable in isolation.

import { execFileSync } from "node:child_process";
import { nonNull } from "../lib/non-null.js";

/** Timeout for the SessionStart git-baseline snapshot. Both `git rev-parse HEAD`
 *  and `git status --porcelain` should complete in milliseconds on a normal
 *  repo; the timeout is defensive against hung git (lock contention, NFS, etc.). */
const GIT_BASELINE_TIMEOUT_MS = 2000;

/** Capture the git working-tree state at session start: HEAD sha + porcelain-
 *  classified sets of modified/staged/untracked paths. Tolerates non-git dirs
 *  (returns empty baseline). Cached for the lifetime of the session — never
 *  re-snapshotted. Exported for direct testing. */
export function captureGitBaseline(cwd: string): {
	modified: Set<string>;
	staged: Set<string>;
	untracked: Set<string>;
	head_sha: string;
} {
	const empty = {
		modified: new Set<string>(),
		staged: new Set<string>(),
		untracked: new Set<string>(),
		head_sha: "",
	};
	const headSha = readHeadSha(cwd);
	const porcelain = readPorcelainStatus(cwd);
	if (porcelain === null) return empty;
	const { modified, staged, untracked } = parsePorcelainEntries(porcelain);
	return { modified, staged, untracked, head_sha: headSha };
}

/** `git rev-parse HEAD`, trimmed. Returns "" for a non-git dir or any failure. */
function readHeadSha(cwd: string): string {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		}).trim();
	} catch {
		return "";
	}
}

/** `git status --porcelain -z -uall` raw output. Returns null on failure (non-git dir, hung git, etc.). */
function readPorcelainStatus(cwd: string): string | null {
	try {
		return execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		});
	} catch {
		return null;
	}
}

/** Classifies one porcelain `-z` entry into the modified/staged/untracked sets in place.
 *  Returns the number of extra entries consumed (1 when the entry is a rename/copy whose
 *  old-path entry must be skipped, 0 otherwise). */
function classifyPorcelainEntry(
	raw: string,
	sets: { modified: Set<string>; staged: Set<string>; untracked: Set<string> },
): number {
	if (raw.length < 3) return 0;
	const indexStatus = raw[0];
	const worktreeStatus = raw[1];
	const path = raw.slice(3);
	const consumedExtra = indexStatus === "R" || indexStatus === "C" ? 1 : 0;
	if (indexStatus === "?" && worktreeStatus === "?") {
		sets.untracked.add(path);
		return consumedExtra;
	}
	if (indexStatus === "!" && worktreeStatus === "!") return consumedExtra;
	if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
		sets.staged.add(path);
	}
	if (worktreeStatus !== " " && worktreeStatus !== "?" && worktreeStatus !== "!") {
		sets.modified.add(path);
	}
	return consumedExtra;
}

/** Parses the full `-z`-delimited porcelain output into modified/staged/untracked path sets. */
function parsePorcelainEntries(porcelain: string): {
	modified: Set<string>;
	staged: Set<string>;
	untracked: Set<string>;
} {
	const modified = new Set<string>();
	const staged = new Set<string>();
	const untracked = new Set<string>();
	const sets = { modified, staged, untracked };
	const entries = porcelain.split("\0").filter((e) => e.length > 0);
	for (let i = 0; i < entries.length; i++) {
		const raw = nonNull(entries[i]);
		i += classifyPorcelainEntry(raw, sets);
	}
	return { modified, staged, untracked };
}
