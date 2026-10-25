import { execFileSync } from "node:child_process";
import { join } from "node:path";

const GIT_SCOPE_TIMEOUT_MS = 2_000;
const GIT_SCOPE_MAX_BYTES = 16 * 1024 * 1024;

/** Hook-provided selectors must not redirect queries away from the ledger root. */
function gitScopeEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key];
	return env;
}

/** Scope is captured once per ledger build, with no process-wide stale ignore cache. */
export function ignoredSpecPaths(repoRoot: string): ReadonlySet<string> {
	try {
		// Git excludes tracked paths from --others even if an ignore pattern matches.
		// --directory collapses ignored trees; -z preserves spaces, Unicode and newlines.
		const paths = execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
			env: gitScopeEnv(), encoding: "utf8", timeout: GIT_SCOPE_TIMEOUT_MS, maxBuffer: GIT_SCOPE_MAX_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(paths.split("\0").filter(Boolean).map((path) => join(repoRoot, path.replace(/\/$/, ""))));
	} catch {
		// Non-Git roots and unavailable Git retain the ordinary bounded walk.
		return new Set();
	}
}

/** One path the build's snapshot cannot name because it did not exist yet. Exit 0 means ignored; tracked files are
 *  never reported. Any other outcome (exit 1, no Git, timeout) keeps the path in scope, as the bounded walk does. */
export function isLateIgnoredSpecPath(repoRoot: string, relPath: string): boolean {
	try {
		execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", relPath], {
			env: gitScopeEnv(), timeout: GIT_SCOPE_TIMEOUT_MS, stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}
