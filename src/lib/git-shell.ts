// ===========================================
// Git Shell Runner — `git <args>` through the shell
// ===========================================
// The shell variant exists because some callers depend on shell features that
// `execFileSync` cannot provide: attribution pipes a diff into `wc -l`.
//
// Use gitArgs for input-bearing operations, preserving each argument literally.
// Only reach for gitShell when the
// command genuinely needs a shell, and never interpolate untrusted input.

import { execFileSync, execSync } from "node:child_process";

/** Run a fixed Git operation with input values preserved as individual arguments. */
export function gitArgs(args: readonly string[], cwd: string): string {
	return gitArgsRaw(args, cwd).trim();
}

/** Preserve whitespace and NUL delimiters in Git path inventories. */
export function gitArgsRaw(args: readonly string[], cwd: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

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
