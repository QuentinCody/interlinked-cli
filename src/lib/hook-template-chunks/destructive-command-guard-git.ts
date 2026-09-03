// git-destruction rule family for the shared destructive-command guard, split
// out of destructive-command-guard.ts to stay under the per-file line cap.
// See that module's header for the full rationale — the short version: every
// function here is embedded verbatim (via `Function.prototype.toString()`)
// into the zero-import generated `.mjs` hook, so each MUST stay a
// free-standing, self-contained `function` declaration with no module-scope
// constants and no runtime reference to anything outside its own parameters
// and its sibling functions in this same list (all of which are also
// serialized, so calls between them resolve in the assembled `.mjs` scope).
// The `import type` below is erased at compile time — it contributes nothing
// to the function's serialized source text — so it does not violate that
// contract.

import type { DestructiveCommandVerdict } from "./destructive-command-guard.js";

/** Data-loss git operations: force-push, hard reset, and any command that
 *  discards local work without a recovery path. Split out of
 *  dcgCheckGitDestruction to stay under the per-function token cap. */
export function dcgCheckGitDataLoss(cmd: string): DestructiveCommandVerdict | null {
	if (/\bgit\s+push\s+.*--force(?!-with-lease)\b/i.test(cmd) || /\bgit\s+push\s+-f\b/i.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: git push --force. Use --force-with-lease instead." };
	}
	if (/\bgit\s+reset\s+--hard\b/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git reset --hard destroys all uncommitted changes. Use git stash first.",
		};
	}
	if (/\bgit\s+clean\s+-[a-zA-Z]*f/.test(cmd) && !/\bgit\s+clean\s+.*(-n|--dry-run)/.test(cmd)) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git clean -f permanently deletes untracked files. Use git clean -n (dry-run) first.",
		};
	}
	if (/\bgit\s+checkout\s+--\s+\./.test(cmd)) {
		return { decision: "block", reason: "BLOCKED: git checkout -- . discards all unstaged changes." };
	}
	if (/\bgit\s+restore\s+--worktree\s/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git restore --worktree discards working tree changes.",
		};
	}
	if (/\bgit\s+branch\s+-D\s/.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git branch -D force-deletes a branch without merge check. Use -d instead.",
		};
	}
	if (/\bgit\s+stash\s+(drop|clear)/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git stash drop/clear permanently removes stashed work.",
		};
	}
	if (/\bgit\s+restore\s+\./.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git restore . discards all unstaged changes. Use git stash first.",
		};
	}
	return null;
}

/** History-rewriting and interactive git operations: full-history rewrites
 *  and any subcommand flag that would open an editor/prompt and hang a
 *  non-interactive agent. Split out of dcgCheckGitDestruction to stay under
 *  the per-function token cap. */
export function dcgCheckGitInteractiveOrRewrite(cmd: string): DestructiveCommandVerdict | null {
	if (/\bgit\s+filter-branch\b/i.test(cmd) || /\bgit\s+filter-repo\b/i.test(cmd)) {
		return {
			decision: "block",
			reason: "BLOCKED: git filter-branch/filter-repo rewrites entire repository history.",
		};
	}
	// 'git rebase' / 'git add' with an interactive flag. Three constraints
	// shaped this pattern: a word-boundary before '-i' never matches a
	// space-preceded flag (word char required before the dash); the scan must
	// stop at the end of the command SEGMENT — the earlier '(?:\S+\s+)*' shape
	// crossed newlines/';'/'&&'/'|', so any later standalone '-p'-ish token
	// (classically 'mkdir -p') false-blocked the whole compound command
	// (measured FP, 2026-07-24); and the span is a SINGLE flat quantifier
	// (no '(?:A+B+)*' nesting) so the ReDoS guard stays quiet. The span
	// excludes separators/redirects/newlines; the flag must sit at a token
	// start (preceded by a space/tab) and end at whitespace/EOL/separator.
	if (
		/\bgit[^\S\r\n]+rebase(?![\w-])[^;&|<>\r\n]*?[^\S\r\n](?:-i|--interactive)(?=\s|$|[;&|<>])/i.test(
			cmd,
		)
	) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git rebase -i opens an interactive editor that hangs a non-interactive agent. Use a non-interactive rebase or run it yourself.",
		};
	}
	if (
		/\bgit[^\S\r\n]+add(?![\w-])[^;&|<>\r\n]*?[^\S\r\n](?:-i|-p|-e|--interactive|--patch|--edit)(?=\s|$|[;&|<>])/i.test(
			cmd,
		)
	) {
		return {
			decision: "block",
			reason:
				"BLOCKED: git add -i/-p/-e opens an interactive prompt that hangs a non-interactive agent. Use git add <pathspec>.",
		};
	}
	return null;
}

export function dcgCheckGitDestruction(cmd: string): DestructiveCommandVerdict | null {
	return dcgCheckGitDataLoss(cmd) || dcgCheckGitInteractiveOrRewrite(cmd);
}
