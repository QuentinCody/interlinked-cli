// ===========================================
// Remote Repository Cloning
// ===========================================
// Git URL detection, normalization, and shallow cloning into a temp directory.
// Rejects URLs/branches containing shell metacharacters to prevent command
// injection via `git clone` argv (belt-and-suspenders — we use execFileSync,
// not a shell, but still guard against weird inputs reaching git itself).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonNull } from "../../lib/non-null.js";

/** Public API — consumed by `verify.ts` and `__tests__/verify.test.ts`. */
export function isGitUrl(target: string): boolean {
	if (/^https?:\/\//.test(target)) return true;
	if (target.startsWith("git@")) return true;
	if (target.startsWith("ssh://")) return true;
	if (/^[\w.-]+\.(com|org|io|dev|net)\/[\w.-]+\/[\w.-]+/.test(target)) return true;
	if (target.endsWith(".git")) return true;
	return false;
}

/** Public API — consumed by `verify.ts`. */
export function normalizeGitUrl(target: string): string {
	if (/^[\w.-]+\.(com|org|io|dev|net)\//.test(target)) return `https://${target}`;
	return target;
}

/** Public API — consumed by `verify.ts`. */
export function repoDisplayName(url: string): string {
	const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) return nonNull(sshMatch[1]);
	const httpsMatch = url.match(/\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) return nonNull(httpsMatch[1]);
	return url;
}

export const CLONE_TIMEOUT_MS = 120_000;
export const SHELL_META = /[;|&`$(){}!<>'"\\#\n\r]/;

/**
 * Public API — consumed by `verify.ts`.
 *
 * Shallow-clones `url` into a unique temp directory. Throws if the URL or
 * branch contains shell metacharacters.
 */
export function cloneRepo(
	url: string,
	opts: { branch?: string | undefined; timeoutMs?: number },
): { dir: string; elapsed_ms: number } {
	if (SHELL_META.test(url)) {
		throw new Error(`Refusing to clone — URL contains shell metacharacters: ${url}`);
	}
	if (opts.branch && SHELL_META.test(opts.branch)) {
		throw new Error(`Refusing to clone — branch contains shell metacharacters: ${opts.branch}`);
	}

	const tempDir = join(tmpdir(), `interlinked-verify-${randomUUID().slice(0, 8)}`);
	const args = ["clone", "--depth", "1"];
	if (opts.branch) args.push("--branch", opts.branch);
	args.push(url, tempDir);

	const start = Date.now();
	try {
		execFileSync("git", args, {
			stdio: ["pipe", "pipe", "inherit"],
			timeout: opts.timeoutMs ?? CLONE_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
	} catch (err: unknown) {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (cleanupError) {
			// Preserve the clone failure when best-effort cleanup also fails.
			void cleanupError;
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Clone failed: ${msg}`);
	}

	return { dir: tempDir, elapsed_ms: Date.now() - start };
}
