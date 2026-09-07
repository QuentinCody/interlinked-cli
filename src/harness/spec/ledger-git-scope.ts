import { execFileSync } from "node:child_process";
import { join } from "node:path";

const GIT_SCOPE_TIMEOUT_MS = 2_000;
const GIT_SCOPE_MAX_BYTES = 16 * 1024 * 1024;

/** Scope is captured once per ledger build, with no process-wide stale ignore cache. */
export function ignoredSpecPaths(repoRoot: string): ReadonlySet<string> {
	try {
		// Git excludes tracked paths from --others even if an ignore pattern matches.
		// --directory collapses ignored trees; -z preserves spaces, Unicode and newlines.
		const paths = execFileSync("git", ["-C", repoRoot, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
			encoding: "utf8", timeout: GIT_SCOPE_TIMEOUT_MS, maxBuffer: GIT_SCOPE_MAX_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(paths.split("\0").filter(Boolean).map((path) => join(repoRoot, path.replace(/\/$/, ""))));
	} catch {
		// Non-Git roots and unavailable Git retain the ordinary bounded walk.
		return new Set();
	}
}
