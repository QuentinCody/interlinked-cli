// interlinked-tdd: exempt
// ===========================================
// git-session-scope-gate: resolution helpers
// ===========================================
//
// Leaf helpers extracted from `git-session-scope-gate.ts` to keep the main
// module under the per-file line cap. Two cohesive clusters live here:
//
//   1. git invocations — read-only `git status` / `git diff --cached` shell
//      shell-outs plus the porcelain parser. Every function tolerates a
//      non-git cwd (or any git failure) by returning [].
//   2. flag handling — splits `git add` / `git commit` argument lists into
//      positional pathspecs, identifying the `commit -a` family.
//
// All functions are pure leaves: they depend only on their imports
// (`execFileSync`), the shared `GIT_TIMEOUT_MS` constant declared here, and
// each other. The main module imports the names it still references.

import { execFileSync } from "node:child_process";
import { nonNull } from "../../lib/non-null.js";

/** Shared timeout for the short-lived `git` invocations this gate runs. */
export const GIT_TIMEOUT_MS = 3000;

// ============================================================
// git invocations
// ============================================================

/** `git status --porcelain [-- <pathspec>...]` → cwd-relative path list,
 *  collapsing all status columns into one flat path set (any change
 *  counts). Returns [] on failure (non-git cwd, etc.).
 *
 *  Passes `-uall` so untracked files inside an entirely-untracked
 *  directory are listed individually instead of as `dir/`. Without
 *  this, `git add -A` resolution would see only the parent directory
 *  and the gate's per-file check would over-match. */
export function statusPaths(cwd: string, pathspecs: string[]): string[] {
	try {
		const args = ["status", "--porcelain", "-z", "-uall"];
		if (pathspecs.length > 0) {
			args.push("--");
			for (const p of pathspecs) args.push(p);
		}
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return parsePorcelainPaths(out);
	} catch {
		return [];
	}
}

/** Same as statusPaths but drops `??` (untracked) entries. Used by
 *  `git commit -a`, which only stages tracked modifications. */
export function statusPathsExcludingUntracked(cwd: string): string[] {
	try {
		const out = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return parsePorcelainPaths(out, { excludeUntracked: true });
	} catch {
		return [];
	}
}

/** `git diff --cached --name-only` → staged-only path list. */
export function stagedPaths(cwd: string): string[] {
	try {
		const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

function parsePorcelainPaths(
	out: string,
	opts?: { excludeUntracked?: boolean },
): string[] {
	const exclUntracked = !!opts?.excludeUntracked;
	const paths: string[] = [];
	const entries = out.split("\0").filter((e) => e.length > 0);
	for (let i = 0; i < entries.length; i++) {
		const raw = entries[i];
		if (nonNull(raw).length < 3) continue;
		const indexStatus = nonNull(raw)[0];
		const worktreeStatus = nonNull(raw)[1];
		const path = nonNull(raw).slice(3);
		if (indexStatus === "?" && worktreeStatus === "?") {
			if (exclUntracked) continue;
			paths.push(path);
			continue;
		}
		if (indexStatus === "!" && worktreeStatus === "!") continue;
		// Rename / copy: skip the OLD path that follows.
		if (indexStatus === "R" || indexStatus === "C") {
			paths.push(path);
			i++;
			continue;
		}
		paths.push(path);
	}
	return paths;
}

// ============================================================
// Flag handling
// ============================================================

const COMMIT_FLAGS_TAKING_VALUE = new Set([
	"-m",
	"--message",
	"-F",
	"--file",
	"-c",
	"--reedit-message",
	"-C",
	"--reuse-message",
	"--fixup",
	"--squash",
	"--author",
	"--date",
	"-t",
	"--template",
	"--cleanup",
	"--gpg-sign",
	"-S",
	"--trailer",
]);

const ADD_FLAGS_TAKING_VALUE = new Set([
	"--chmod",
	"--pathspec-from-file",
]);

/** Returns true when the token is one of the `commit -a` family. */
export function isCommitAllFlag(arg: string): boolean {
	if (arg === "-a" || arg === "--all") return true;
	// Combined short flags: `-am`, `-aS`, etc. — match any `-a` prefix
	// that isn't a long option.
	if (/^-[A-Za-z]+$/.test(arg) && arg.includes("a")) return true;
	return false;
}

/** Strip `commit` flags + their values, returning only positional args. */
/** For a `git commit` flag token, how many *additional* argv slots it
 *  consumes (its own value, if any) — or `null` if `tok` is not a flag at
 *  all (i.e. it is positional). */
function commitFlagValueSkip(tok: string): number | null {
	if (!tok.startsWith("-")) return null;
	// `--flag=value` — already self-contained.
	if (tok.includes("=")) return 0;
	if (COMMIT_FLAGS_TAKING_VALUE.has(tok)) return 1; // skip value
	// Combined short flag like `-am` followed by the message.
	if (/^-[A-Za-z]+$/.test(tok) && tok.includes("m") && tok !== "--message") {
		return 1; // the next arg is the message body, skip it
	}
	return 0;
}

export function stripCommitFlags(args: string[]): string[] {
	const positional: string[] = [];
	let sawDashDash = false;
	for (let i = 0; i < args.length; i++) {
		const tok = nonNull(args[i]);
		if (sawDashDash) {
			positional.push(tok);
			continue;
		}
		if (tok === "--") {
			sawDashDash = true;
			continue;
		}
		const valueSkip = commitFlagValueSkip(tok);
		if (valueSkip !== null) {
			i += valueSkip;
			continue;
		}
		positional.push(tok);
	}
	return positional;
}

/** Strip `add` flags + their values, returning only positional pathspecs. */
export function stripFlags(args: string[]): string[] {
	const positional: string[] = [];
	let sawDashDash = false;
	for (let i = 0; i < args.length; i++) {
		const tok = nonNull(args[i]);
		if (sawDashDash) {
			positional.push(tok);
			continue;
		}
		if (tok === "--") {
			sawDashDash = true;
			continue;
		}
		if (tok.startsWith("-")) {
			if (tok.includes("=")) continue;
			if (ADD_FLAGS_TAKING_VALUE.has(tok)) {
				i++;
				continue;
			}
			continue;
		}
		positional.push(tok);
	}
	return positional;
}
