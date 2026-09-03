// ===========================================
// Git Shell Runner — `git <args>` through the shell
// ===========================================
// The shell variant exists because some callers depend on shell features that
// `execFileSync` cannot provide: attribution pipes a diff into `wc -l`, and the
// checkpoint writer passes a quoted stash message that carries spaces.
//
// Prefer the argv-based helpers in `git-utils.ts` for fixed commands — they
// avoid shell interpolation entirely. Only reach for `gitShell` when the
// command genuinely needs a shell, and never interpolate untrusted input.

import { execSync } from "node:child_process";

/**
 * Run `git <args>` through the shell and return trimmed stdout.
 * Throws on a non-zero exit.
 */
export function gitShell(args: string, cwd: string): string {
	return execSync(`git ${args}`, {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}
