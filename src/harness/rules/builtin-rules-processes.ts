// ===========================================
// Built-in Rules — Process and Filesystem Destruction
// ===========================================
// Covers kill/pkill/killall (with signal/xargs variants), dangerous rm,
// git force/reset/branch destruction, filesystem wipes (dd/mkfs/shred/wipefs),
// system-level operations (sudo rm, chmod 777, shutdown, LVM), and inline
// shell-level destructive commands.

import { AGENT_WORKTREE_CREATE_COMMAND_PATTERN } from "../../lib/hook-template-chunks/destructive-command-guard.js";
import type { GuardRule } from "../types.js";
import {
	PROCESS_RULES_GIT_FS_INLINE,
	PROCESS_RULES_SYSTEM_FS,
} from "./builtin-rules-processes-git-fs-inline.js";

/**
 * Public API — consumed by `rules/builtin-rules.ts` to assemble the full
 * BUILTIN_RULES array exported by `rules-loader.ts`.
 */
export const PROCESS_AND_FILESYSTEM_RULES: GuardRule[] = [
	// --- Process Killing (name matching) ---
	{
		id: "builtin-pkill-f",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				// No `executed_only` here (nor on builtin-pkill-node): the
				// `(dev|tail|logs|pages)` exemption lookahead has to read the
				// quoted process-name argument, which executed_only masks.
				field: "command",
				regex: "\\bpkill\\s+(-\\d+\\s+)?-f\\s+(?![\"']?\\w+\\s+(dev|tail|logs|pages)\\b)",
			},
		],
		reason: "pkill -f matches processes across ALL projects/sessions",
		suggestion:
			"Use specific PID: kill <pid>. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-killall",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bkillall\\s+(?!-l\\b)", executed_only: true }],
		reason: "killall terminates ALL processes with matching name",
		suggestion: "Use specific PID: kill <pid>",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pkill-node",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bpkill\\s+(?!.*--pidfile)(?!-f\\s+[\"']?\\w+\\s+(dev|tail|logs|pages)\\b).*(?:node|bun|python|wrangler|claude)\\b",
				flags: "i",
			},
		],
		reason: "Would kill processes across all projects",
		suggestion:
			"Use specific PID or port-based killing: lsof -ti :<port> | xargs kill. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pgrep-xargs-kill",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "\\bpgrep\\b.*\\|\\s*xargs\\s+kill\\b",
				flags: "i",
				executed_only: true,
			},
			{
				field: "command",
				regex: "\\bkill\\s+.*\\$\\(pgrep\\b",
				flags: "i",
				executed_only: true,
			},
			{
				// A `ps` pipeline is dangerous only when it actually ends in a
				// kill — `ps aux | grep x | awk '{print $2}' | xargs kill`. The
				// old alternation `(awk|xargs|kill)` treated a bare `awk` as a
				// kill, so pure inspection pipelines such as
				// `ps aux | grep claude | awk '{print $11}'` false-positived.
				// Require a real `xargs kill` (the pipe is implied — `xargs`
				// can only consume `ps` output through one); `executed_only`
				// keeps the token from matching inside a quoted search argument.
				field: "command",
				regex: "\\bps\\s+(aux|ef)\\b.*\\bxargs\\s+kill\\b",
				flags: "i",
				executed_only: true,
			},
			{
				// `for p in $(pgrep -f X); do kill "$p"; done` has the SAME blast
				// radius as `pgrep -f X | xargs kill` — blocking one and not the
				// other only pushed the agent into a one-PID-at-a-time loop with
				// identical effect (measured 2026-08-11, 12 calls where 1 would
				// do). Block the loop form too; the suggestion names the safe
				// enumerate-confirm-kill path so the legitimate intent has a route.
				field: "command",
				regex: "\\bfor\\s+\\w+\\s+in\\s+\\$\\(\\s*pgrep\\b[^)]*\\)\\s*;?\\s*do\\b[^;]*\\bkill\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "Pattern kills processes system-wide (same blast radius whether piped, substituted, or looped)",
		suggestion:
			"Enumerate, confirm, then kill: run `pgrep -fl '<pattern>'` first to SEE the matches are yours, then kill those exact PIDs — `kill <pid> <pid> …` (or `pgrep -f '<pattern>' | xargs -n1 kill` once you have verified the list). Listing first is the safe step the raw pipe skips.",
		severity: "high",
		category: "process-killing",
	},

	// --- Dangerous rm ---
	{
		id: "builtin-rm-rf-root",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// executed_only masks quoted/comment/heredoc-data mentions
			// (`echo "rm -rf /"`); bare commands + `bash -c '…'` still scan.
			{
				field: "command",
				regex: "\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*\\s+\\/(?!tmp\\b|var\\/tmp\\b)",
				executed_only: true,
			},
			{ field: "command", regex: "\\brm\\s+-rf\\s+\\*", executed_only: true },
		],
		reason: "Recursive deletion of root-level or wildcard paths is dangerous",
		suggestion: "Be more specific about what to delete",
		severity: "critical",
		category: "file-deletion",
	},
	{
		id: "builtin-rm-wrangler",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\s*($|&&|\\||;)" },
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*\\.wrangler\\/state\\b" },
		],
		reason: "CRITICAL: .wrangler contains the local development database (SQLite). Deleting it DESTROYS ALL LOCAL DATA.",
		suggestion: "To fix deployment issues, try: rm -rf .wrangler/cache (keeps database)",
		severity: "critical",
		category: "file-deletion",
	},
	{
		id: "builtin-rm-node-modules",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\brm\\s+(-[rf]+\\s+)*node_modules\\s*($|&&|\\||;)" },
		],
		reason: "Deleting node_modules requires a full reinstall",
		suggestion: "If you have dependency issues, try: npm cache clean --force && npm install",
		severity: "medium",
		category: "file-deletion",
	},

	// --- Git force operations ---
	{
		id: "builtin-git-worktree-add",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: AGENT_WORKTREE_CREATE_COMMAND_PATTERN,
				flags: "i",
				executed_only: true,
			},
		],
		reason: "Agent-created Git worktrees are disabled by default",
		suggestion:
			"Use the existing workspace; a human operator may provision an approved worktree outside the agent session",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-force-push",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// Walker bounded to the push's own shell segment (`[^;&|<>()\n]`)
			// so `git push origin && echo --force` can't span the `&&`;
			// executed_only masks quoted/heredoc mentions. `(?![-\w])` excludes
			// every `--force-*` variant; the leading `\s` makes `--force` its own
			// argument, so a branch named `feature--force` (quoted or not) is not
			// a force push — single-word quoted operands are visible to
			// executed_only since 2026-10-09. Bounded-walker discipline adapted
			// from destructive_command_guard #124.
			{
				field: "command",
				regex: "\\bgit\\s+push\\b[^;&|<>()\\n]*?\\s--force(?![-\\w])",
				executed_only: true,
			},
			// Short flag incl. bundles — `-f`, `-uf`, `-fq`, `-vf`. Any `git
			// push` short-flag cluster containing `f` is a force push. (Old
			// pattern only caught a bare `-f` directly after `push`.)
			{
				field: "command",
				regex: "\\bgit\\s+push\\b[^;&|<>()\\n]*?\\s-[a-zA-Z]*f[a-zA-Z]*\\b",
				executed_only: true,
			},
		],
		reason: "git push --force can destroy remote commits and collaborators' work",
		suggestion: "Use --force-with-lease for safer force pushing",
		severity: "critical",
		category: "git-operations",
	},
	{
		id: "builtin-git-reset-hard",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// executed_only: don't fire on quoted/heredoc-data mentions.
			{ field: "command", regex: "\\bgit\\s+reset\\s+--hard\\b", executed_only: true },
		],
		reason: "git reset --hard destroys all uncommitted changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-clean-f",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			// executed_only: don't fire on quoted/heredoc-data mentions.
			{ field: "command", regex: "\\bgit\\s+clean\\s+-[dxf]*f", executed_only: true },
		],
		reason: "git clean -f permanently deletes untracked files",
		suggestion: "Use git clean -n first to preview what will be deleted",
		severity: "high",
		category: "git-operations",
	},

	// --- Process killing (signals, multi-PID, substitution) ---
	{
		id: "builtin-kill-signal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bkill\\s+-[1-9][0-9]*\\b", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+-SIG", flags: "i", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+-s\\s", flags: "i", executed_only: true },
		],
		reason: "Sending termination signals is dangerous. Use plain 'kill <PID>' (SIGTERM) instead",
		suggestion: "Use plain: kill <PID>",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-kill-multi-pid",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		// The negative lookahead `(?![0-9>])` excludes file-descriptor redirects:
		// `kill 12345 2>&1` would otherwise match because `2` from `2>&1` looks
		// like a second PID. We require the trailing token to be a real PID
		// (digits not followed by `>`/`<` or more digits in a redirect context),
		// followed by end-of-token (whitespace, end-of-string, or shell
		// separator). Real two-PID kills (`kill 12345 67890\b`) still match.
		patterns: [
			{
				field: "command",
				regex: "\\bkill\\s+[0-9]+\\s+[0-9]+(?=\\s|$|[;|&])",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "Killing multiple PIDs at once is dangerous",
		suggestion: "Kill one PID at a time",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-kill-substitution",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bkill\\s+\\$\\(", executed_only: true },
			{ field: "command", regex: "\\bkill\\s+`", executed_only: true },
			{
				field: "command",
				regex: "\\|\\s*xargs\\s+(.*\\s)?kill\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason: "kill with command substitution or piped xargs is dangerous",
		suggestion: "Find the PID first, then kill it by number",
		severity: "high",
		category: "process-killing",
	},
	{
		id: "builtin-pkill-signal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bpkill\\s+-[0-9]+\\b", executed_only: true },
			{ field: "command", regex: "\\bpkill\\s+-SIG", flags: "i", executed_only: true },
		],
		reason: "pkill with signal kills matching processes system-wide",
		suggestion: "Use specific PID: kill -<signal> <pid>",
		severity: "high",
		category: "process-killing",
	},

	// --- Dev server protection (soft block — allows retry) ---
	{
		id: "builtin-kill-port",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command", "bash"],
		action: "soft_block",
		patterns: [
			{ field: "command", regex: "\\blsof\\s+-ti?\\s*:\\d+.*\\|.*kill", flags: "i" },
			{ field: "command", regex: "\\bfuser\\s+-k\\s+\\d+/tcp", flags: "i" },
			{ field: "command", regex: "\\bkill-port\\b", flags: "i" },
			{ field: "command", regex: "\\bnpx\\s+kill-port\\b", flags: "i" },
		],
		reason: "This will kill a process listening on a port (possibly a dev server). If you need to restart the server, re-run this command.",
		suggestion:
			"Confirm this is intentional — a running dev server may be in use by the user or another agent",
		severity: "medium",
		category: "process-killing",
	},

	// --- System / Filesystem destructive rules (sibling cluster) ---
	// Spread in at the original position so BUILTIN_RULES order is unchanged.
	...PROCESS_RULES_SYSTEM_FS,

	// --- Git destruction (expanded) ---
	{
		id: "builtin-git-checkout-dot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+checkout\\s+--\\s+\\." }],
		reason: "git checkout -- . discards all unstaged changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-restore-worktree",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+restore\\s+--worktree\\s" }],
		reason: "git restore --worktree discards working tree changes",
		suggestion: "Use git stash first to preserve changes",
		severity: "high",
		category: "git-operations",
	},
	{
		id: "builtin-git-branch-D",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bgit\\s+branch\\s+-[DMf]\\s", flags: "" },
		],
		reason:
			"git branch -D/-M/-f is a force operation: it deletes or moves a branch ref without the usual safety checks",
		suggestion:
			"For deletion use -d (merge-checked - it refuses unmerged branches). -f/-M force-move a branch ref and can orphan commits; re-run only if intended.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-stash-destroy",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+stash\\s+(drop|clear)\\b", flags: "i" }],
		reason: "git stash drop/clear permanently removes stashed work",
		suggestion: "Verify stash contents first with git stash list",
		severity: "high",
		category: "git-operations",
	},

	// --- Embedded destructive / git / filesystem rules (sibling cluster) ---
	// Spread in at the original position so BUILTIN_RULES order is unchanged.
	...PROCESS_RULES_GIT_FS_INLINE,
];

// ===========================================
// Temporal-precondition rules (PB&J Free-CLI item #1)
// ===========================================
// Extracted to a sibling module 2026-06-12 to hold this file under the
// 800-line cap; re-exported here so `builtin-rules.ts` and existing tests
// keep importing `TEMPORAL_PRECONDITION_RULES` from this path unchanged.
export { TEMPORAL_PRECONDITION_RULES } from "./builtin-rules-temporal.js";
