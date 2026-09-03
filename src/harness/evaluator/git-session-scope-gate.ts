// ===========================================
// PreToolUse Bash gate: git-session scope
// ===========================================
//
// Intercepts `git add` / `git commit` / `git push` and asks the user
// before the operation pulls in files this session didn't write. The
// session's `git_session_baseline` (captured once at SessionStart in
// `session-state.ts::captureGitBaseline`) separates "pre-existing dirty"
// from "genuinely unknown" so the ask reason can be specific.
//
// Decision matrix:
//
//   op_files = files this git command would affect.
//   session_files = session.files_written (includes subagent rollups via
//                   `rollUpFileTracking`).
//   baseline_files = (baseline.modified ∪ baseline.staged) − session_files
//                    (pre-existing dirty paths the session didn't touch).
//
//   - op_files ⊆ session_files                              → allow
//   - any op_file ∈ baseline_files                          → ask
//     reason mentions "pre-existing"
//   - any op_file ∉ session_files ∧ ∉ baseline_files       → ask
//     reason mentions "unknown"
//
// Out of scope (handled by other gates):
//
//   - `git push --force` / `-f` — defers to the existing force-push rule.
//   - Bash-mediated writes (e.g. `sed -i src/foo.ts`) — these do not
//     populate `files_written` today, so the gate may over-ask on such
//     edits. Tracked in docs/design/bash-writes-through-content-gates.md.
//   - Files removed by `git rm` — `git status --porcelain` reports a
//     deletion under the staged column; we still ask because the
//     deletion is a change the session may not have authored.
//
// All git shell-outs are read-only (`git diff --name-only`, `git status
// --porcelain`, `git log --name-only @{u}..HEAD`). Tolerates non-git
// directories and command failures by returning `decision: "allow"`
// with a note explaining the degraded mode.

import { execFileSync } from "node:child_process";
import { nonNull } from "../../lib/non-null.js";
import type { SessionTrajectory } from "../types.js";
import {
	GIT_TIMEOUT_MS,
	isCommitAllFlag,
	stagedPaths,
	statusPaths,
	statusPathsExcludingUntracked,
	stripCommitFlags,
	stripFlags,
} from "./git-session-scope-gate-resolution-helpers.js";

/** Cap on how many files to list in the ask-reason — keep messages short
 *  so the agent's user prompt doesn't scroll off-screen. */
const REASON_FILE_LIMIT = 5;

interface GitScopeVerdict {
	decision: "allow" | "ask";
	reason?: string;
	/** Files the parser resolved out of the git command (post-pathspec
	 *  expansion). Empty when the command is e.g. `git commit` with no
	 *  staged content. */
	resolved_files: string[];
	/** Subset of `resolved_files` that are not in `session.files_written`. */
	unauthorized_files: string[];
	/** Subset of `unauthorized_files` that EXISTED in the working tree as
	 *  dirty/staged BEFORE this session started. */
	baseline_files: string[];
}

/**
 * Public API — consumed by `evaluator/pre-tool.ts`.
 *
 * Returns:
 *  - `null` when the command isn't a relevant git verb (e.g. `git status`,
 *    `git diff`, non-git bash) OR when we choose to defer (e.g. `--force`
 *    on push, where the existing force-push rule handles the call).
 *  - A `GitScopeVerdict` with `decision: "allow"` when every file the
 *    operation would touch was written by the session (or its subagents).
 *  - A `GitScopeVerdict` with `decision: "ask"` when one or more files
 *    weren't.
 *
 * The function is `async` for the contract documented in the task spec
 * (and to leave room for streaming reads on huge repos); the current
 * implementation is purely synchronous and delegates to
 * `evaluateGitScopeGateSync`. The synchronous variant is exported for
 * call sites (like `evaluator/pre-tool.ts`) that run inside a synchronous
 * PreToolUse handler.
 */
export async function evaluateGitScopeGate(
	bashCommand: string,
	session: SessionTrajectory,
	cwd: string,
): Promise<GitScopeVerdict | null> {
	return evaluateGitScopeGateSync(bashCommand, session, cwd);
}

/** Synchronous counterpart of `evaluateGitScopeGate`. Same contract; the
 *  pre-tool evaluator runs this directly to stay within its sync path. */
export function evaluateGitScopeGateSync(
	bashCommand: string,
	session: SessionTrajectory,
	cwd: string,
): GitScopeVerdict | null {
	const parsed = parseGitVerb(bashCommand);
	if (!parsed) return null;
	const { verb, args, deferToForcePush } = parsed;
	if (deferToForcePush) return null;

	// Resolve the file set the operation would touch.
	let resolution: ResolveResult;
	try {
		resolution = resolveOpFiles(verb, args, cwd);
	} catch (_e) {
		// `git` not on PATH, cwd missing, etc. — fail open so the gate
		// doesn't deadlock the agent on platforms where git is unusable.
		return {
			decision: "allow",
			reason: "git unavailable; gate degraded to allow.",
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		};
	}

	const { files, allowNote } = resolution;
	// `allowNote` lets a verb opt into "allow with annotation" — e.g.
	// `git push` with no upstream. We still compute the verdict (file
	// list may be empty), but force decision to allow.
	if (allowNote && files.length === 0) {
		return {
			decision: "allow",
			reason: allowNote,
			resolved_files: [],
			unauthorized_files: [],
			baseline_files: [],
		};
	}

	// Compute the session-known set (files this session wrote, including
	// subagent rollups). Both relative-to-cwd and the absolute form are
	// recorded by session-state, so we test both shapes per op-file.
	const sessionFiles = session.files_written;

	const baselineDirty = preSessionDirtyPaths(session);

	const unauthorized: string[] = [];
	const baselineHits: string[] = [];
	for (const f of files) {
		// `sessionFiles` may hold either relative or absolute paths.
		// `f` from `resolveOpFiles` is always cwd-relative (git emits
		// repo-root-relative paths and we run `git` with cwd === eventCwd).
		if (sessionFiles.has(f)) continue;
		unauthorized.push(f);
		if (baselineDirty.has(f)) baselineHits.push(f);
	}

	if (unauthorized.length === 0) {
		return {
			decision: "allow",
			resolved_files: files,
			unauthorized_files: [],
			baseline_files: [],
		};
	}

	// Build the ask reason. Use the baseline category first (it's the
	// more specific signal — "you've already started this work") with
	// the unknown-file message as a fallback.
	const verbDisplay = displayVerb(verb);
	const reason = formatReason(verbDisplay, unauthorized, baselineHits);

	return {
		decision: "ask",
		reason,
		resolved_files: files,
		unauthorized_files: unauthorized,
		baseline_files: baselineHits,
	};
}

/** Paths that were already dirty or staged when the session started AND that
 *  the session has not written since. Once the session has touched a
 *  pre-existing dirty file, the agent has authored the current state and we
 *  should not ask about it. */
function preSessionDirtyPaths(session: SessionTrajectory): Set<string> {
	const baseline = session.git_session_baseline;
	const baselineDirty = new Set<string>();
	if (baseline) {
		for (const f of baseline.modified) baselineDirty.add(f);
		for (const f of baseline.staged) baselineDirty.add(f);
	}
	for (const f of session.files_written) baselineDirty.delete(f);
	return baselineDirty;
}

// ============================================================
// Verb parsing
// ============================================================

type GitVerb = "add" | "commit" | "push";

interface ParsedGitCommand {
	verb: GitVerb;
	args: string[];
	deferToForcePush: boolean;
}

/** Parse a Bash command into a structured git verb + remaining args.
 *  Returns null when the command isn't a relevant git verb — i.e. anything
 *  other than `git add`, `git commit`, `git push`. Tolerates leading
 *  whitespace, `&&`-chained commands (only the first verb is parsed —
 *  compound chains are decomposed elsewhere in the pipeline), and quoted
 *  segments via a shell-aware splitter.
 *
 *  The parser is intentionally permissive — false negatives (failing to
 *  match a valid git command) are worse than false positives (a non-git
 *  command we then bail out of in `resolveOpFiles`). */
export function parseGitVerb(rawCommand: string): ParsedGitCommand | null {
	const cmd = rawCommand.trim();
	if (!cmd) return null;
	// Quick reject: must contain "git" as a top-level token.
	if (!/\bgit\b/.test(cmd)) return null;

	// We only parse the FIRST simple command in the line. Compound chains
	// (`a && b`, `a; b`, `a | b`) are handled by the existing compound
	// decomposer; if a chain starts with `git push`, only the push is
	// examined here.
	const firstSegment = nonNull(cmd.split(/&&|\|\||;/, 1)[0]).trim();
	const tokens = shellSplit(firstSegment);
	if (tokens.length === 0) return null;

	// Optional leading `env VAR=val`-style wrappers — rare in agent
	// commands; ignore for simplicity. The first token must be "git" or
	// end in "/git" (allow absolute paths).
	let i = 0;
	const first = nonNull(tokens[i]);
	if (first !== "git" && !/(^|\/)git$/.test(first)) return null;
	i++;

	// Skip git's global options (`-c key=val`, `-C path`, `--git-dir`,
	// `--work-tree`, etc.) until we hit the subcommand.
	i = skipGitGlobalOptions(tokens, i);

	const sub = tokens[i];
	if (sub !== "add" && sub !== "commit" && sub !== "push") return null;
	const args = tokens.slice(i + 1);

	if (sub === "push") {
		// Defer all force-push variants to the existing rule.
		for (const a of args) {
			if (a === "--force" || a === "-f" || a === "--force-with-lease" || /^--force/.test(a)) {
				return { verb: "push", args, deferToForcePush: true };
			}
		}
	}

	return { verb: sub, args, deferToForcePush: false };
}

/** Advances past git's global options (`-c key=val`, `-C path`, `--git-dir`,
 *  `--work-tree=...`, and any other leading `-`-prefixed flag) starting at
 *  `startIndex`, stopping at the first token that looks like the
 *  subcommand. Returns that token's index (== `tokens.length` if every
 *  remaining token was consumed as a flag). */
function skipGitGlobalOptions(tokens: string[], startIndex: number): number {
	let i = startIndex;
	while (i < tokens.length) {
		const tok = tokens[i];
		if (tok === "-c" || tok === "--git-dir" || tok === "--work-tree" || tok === "-C") {
			i += 2;
			continue;
		}
		if (nonNull(tok).startsWith("--git-dir=") || nonNull(tok).startsWith("--work-tree=")) {
			i++;
			continue;
		}
		if (nonNull(tok).startsWith("-")) {
			// Some other global flag (e.g. `-p`); skip.
			i++;
			continue;
		}
		break;
	}
	return i;
}

/** Minimal shell-aware splitter for the parser. Handles single + double
 *  quotes and backslash escapes; passes through everything else. NOT a
 *  general bash parser — it doesn't expand vars, glob, or subshells.
 *  The harness already runs a more thorough decomposer for compound
 *  commands; this splitter only needs to keep paths with spaces (in
 *  quotes) intact. */
function shellSplit(input: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < input.length; i++) {
		const c = nonNull(input[i]);
		if (c === "\\" && i + 1 < input.length && !inSingle) {
			cur += nonNull(input[i + 1]);
			i++;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (c === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (/\s/.test(c) && !inSingle && !inDouble) {
			flushToken(out, cur);
			cur = "";
			continue;
		}
		cur += c;
	}
	flushToken(out, cur);
	return out;
}

/** Appends the token `shellSplit` has accumulated so far, skipping the empty
 *  token that runs of whitespace would otherwise produce. */
function flushToken(out: string[], token: string): void {
	if (token.length > 0) out.push(token);
}

// ============================================================
// Op-file resolution per verb
// ============================================================

interface ResolveResult {
	files: string[];
	/** When set, the gate should emit decision=allow with this note,
	 *  bypassing the file check entirely. Used for the "no upstream"
	 *  case on `git push`. */
	allowNote?: string;
}

function resolveOpFiles(verb: GitVerb, args: string[], cwd: string): ResolveResult {
	if (verb === "add") return resolveAddOpFiles(args, cwd);
	if (verb === "commit") return resolveCommitOpFiles(args, cwd);
	return resolvePushOpFiles(args, cwd);
}

/** `git add` resolution.
 *  - `-A` / `--all` / `.` / no positional → status (all dirty paths).
 *  - `<pathspec>` → status filtered to that pathspec. */
function resolveAddOpFiles(args: string[], cwd: string): ResolveResult {
	const positional = stripFlags(args);
	const isAllForm =
		args.includes("-A") ||
		args.includes("--all") ||
		args.includes("-u") ||
		args.includes("--update") ||
		positional.includes(".") ||
		positional.length === 0;

	if (isAllForm) {
		return { files: dedup(statusPaths(cwd, [])) };
	}
	// Targeted pathspecs — narrow status by passing each as `-- <spec>`.
	const collected = new Set<string>();
	for (const spec of positional) {
		for (const f of statusPaths(cwd, [spec])) collected.add(f);
		// Also include the spec verbatim if it exists in the tree and
		// hasn't been modified (rare with `git add`, but allowed).
		// We deliberately don't stat the path — if status had nothing to
		// say about it, `git add` will no-op too, so over-listing is
		// harmless for the gate.
	}
	return { files: [...collected] };
}

/** `git commit` resolution.
 *  - `-a` / `--all` / `-am "msg"` → status filtered to tracked dirty.
 *  - `<pathspec>` (positional or after `--`) → those files.
 *  - bare → `git diff --cached --name-only` (staged-only). */
function resolveCommitOpFiles(args: string[], cwd: string): ResolveResult {
	const hasAllFlag = args.some((a) => isCommitAllFlag(a));
	const positional = stripCommitFlags(args);

	if (positional.length > 0) {
		// `git commit <files>` or `git commit -m "msg" -- <files>` —
		// the positional set is the op-files. We don't expand pathspecs
		// here (git would do glob/recursive matching on them); for the
		// gate's purpose, the raw token IS the file.
		return { files: dedup(positional) };
	}

	if (hasAllFlag) {
		// `git commit -a` includes tracked modified+deleted files (not
		// untracked). `status --porcelain` reports tracked changes in the
		// worktree column; filter out `??` entries.
		const tracked = statusPathsExcludingUntracked(cwd);
		return { files: dedup(tracked) };
	}

	// Bare `git commit` — staged content only.
	return { files: dedup(stagedPaths(cwd)) };
}

/** `git push` resolution. Enumerate files that would land on the remote
 *  via `git log @{u}..HEAD --name-only`. */
function resolvePushOpFiles(_args: string[], cwd: string): ResolveResult {
	// `@{u}..HEAD` — files in commits we have locally but the upstream
	// doesn't. When no upstream is configured, this fails; we treat that
	// as "allow with note" since the user is setting up a new branch and
	// the gate has no useful baseline to compare against.
	try {
		const out = execFileSync(
			"git",
			["log", "@{u}..HEAD", "--name-only", "--pretty=format:"],
			{
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			},
		);
		const files = new Set<string>();
		for (const line of out.split("\n")) {
			const t = line.trim();
			if (t.length === 0) continue;
			files.add(t);
		}
		return { files: [...files] };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// "no upstream", "unknown revision", "ambiguous argument" — all
		// suggest the branch has no tracked upstream yet.
		if (/upstream|unknown revision|ambiguous argument|no such/i.test(msg)) {
			return {
				files: [],
				allowNote: "no upstream — push will set it; gate skipped.",
			};
		}
		// Other failures: bail to allow rather than blocking on git plumbing.
		return {
			files: [],
			allowNote: "git log failed; gate degraded to allow.",
		};
	}
}

// ============================================================
// Formatting
// ============================================================

function displayVerb(verb: GitVerb): string {
	if (verb === "add") return "add";
	if (verb === "commit") return "commit";
	return "push";
}

function formatReason(
	verbDisplay: string,
	unauthorized: string[],
	baselineHits: string[],
): string {
	const truncatedUnauth = unauthorized.slice(0, REASON_FILE_LIMIT).join(", ");
	const moreUnauth = unauthorized.length > REASON_FILE_LIMIT ? ", …" : "";

	if (baselineHits.length > 0) {
		const truncBaseline = baselineHits.slice(0, REASON_FILE_LIMIT).join(", ");
		const moreBaseline = baselineHits.length > REASON_FILE_LIMIT ? ", …" : "";
		return (
			`This git ${verbDisplay} would include ${baselineHits.length} file(s) that existed in the working tree before this session started (${truncBaseline}${moreBaseline}). ` +
			"These weren't written by this session's agent or its subagents — confirm before proceeding."
		);
	}
	return (
		`This git ${verbDisplay} would include ${unauthorized.length} file(s) this session hasn't written (${truncatedUnauth}${moreUnauth}). ` +
		"Confirm intent."
	);
}

function dedup(list: string[]): string[] {
	return [...new Set(list)];
}
