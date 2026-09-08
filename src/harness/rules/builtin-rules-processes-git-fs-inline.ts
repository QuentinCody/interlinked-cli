// interlinked-tdd: exempt
// ===========================================
// Built-in Rules — System / Filesystem / Git / Inline destructive (clusters)
// ===========================================
// Extracted from builtin-rules-processes.ts to hold that file under the
// line cap. Pure GuardRule data — no functions, no module-private state.
// Each array is spread back into PROCESS_AND_FILESYSTEM_RULES at its original
// position so rule order is byte-identical to before the split.

import type { GuardRule } from "../types.js";

export const PROCESS_RULES_SYSTEM_FS: GuardRule[] = [
	// --- System operations ---
	{
		id: "builtin-sudo-rm",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bsudo\\s+rm\\b" }],
		reason: "sudo rm is extremely dangerous",
		suggestion: "Avoid sudo for file operations when possible",
		severity: "critical",
		category: "system-operations",
	},
	{
		id: "builtin-chmod-777",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bchmod\\s+(-R\\s+)?777\\b" }],
		reason: "chmod 777 creates security vulnerabilities (world-writable)",
		suggestion: "Use more restrictive permissions",
		severity: "high",
		category: "system-operations",
	},
	{
		id: "builtin-shutdown-reboot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				// Three structural pieces:
				//
					// 1. **Command-start anchor**: `^`, `;`, `&&`, `||`, single
					//    `|` (pipeline), `\n` (multi-line script). The earlier
					//    `\s` prefix false-positived inside echo/grep strings
					//    and file paths (`echo "Graceful shutdown stalled"`,
					//    `cat ./shutdown.log`). `executed_only` masks quoted
					//    arguments before regex matching, so `rg "x|reboot"`
					//    stays allowed while real pipelines/newlines still match.
					//    `\|\|` listed before `[;|\n]` so the engine consumes
					//    both chars of `||` as one token instead of half-matching.
				//
				// 2. **Optional wrapper chain**: `sudo`, `env [VAR=val ...]`,
				//    `command`, `exec`, `nohup`, and `bash -c "...` /
				//    `sh -c "...`. Zero-or-more so plain `reboot`,
				//    `sudo reboot`, `env A=1 sudo reboot`, and
				//    `sudo bash -c "reboot"` all match. Without this,
				//    wrappers like `env FOO=1 reboot` or `bash -c reboot`
				//    would bypass the rule.
				//
					// 3. **Verb**: `\b` anchored so `rebootloader` doesn't
					//    accidentally match.
					regex: "(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+|(?:bash|sh)\\s+-c\\s*[\"']?\\s*)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b",
					flags: "i",
					executed_only: true,
				},
				{
					field: "command",
					// Dedicated raw-text companion for quoted shell scripts. The
					// main pattern uses `executed_only`, which intentionally masks
					// `"reboot"` inside `bash -c "reboot"`; this pattern inspects
					// only the `bash|sh -c` script entrypoint and still requires
					// the destructive verb to be the first executed token inside
					// the quoted script, so `bash -c "echo shutdown stalled"` is
					// not a false positive.
					regex: "(^|\\|\\||&&|[;|\\n])\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(?:bash|sh)\\s+-c\\s*[\"']\\s*(?:(?:env(?:\\s+[A-Za-z_]\\w*=\\S+)*|command|exec|nohup|sudo)\\s+)*(shutdown|reboot|halt|poweroff|init\\s+[06]|systemctl\\s+(poweroff|reboot|halt))\\b",
					flags: "i",
				},
			],
		reason: "System shutdown/reboot commands are not allowed",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "system-operations",
	},
	{
		id: "builtin-lvm-removal",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\b(lvremove|vgremove|pvremove)\\s", flags: "i" }],
		reason: "LVM removal commands are destructive",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "system-operations",
	},

	// --- Filesystem destruction ---
	{
		id: "builtin-dd-block-device",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bdd\\s.*of=/dev/", flags: "i" }],
		reason: "Writing directly to block devices with dd can destroy data",
		suggestion: "Verify the target device carefully",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-disk-format",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "(^|\\s|;|&&)(mkfs|fdisk|parted|gdisk)\\s",
				flags: "i",
			},
		],
		reason: "Disk formatting/partitioning commands are not allowed",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "filesystem",
	},
];

export const PROCESS_RULES_GIT_FS_INLINE: GuardRule[] = [
	// --- Embedded destructive commands ---
	{
		id: "builtin-inline-script-destruct",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				regex: "(python3?|node|ruby|perl)\\s+-(c|e)\\s+.*\\b(os\\.remove|shutil\\.rmtree|unlink|rimraf)\\b",
				flags: "i",
			},
		],
		reason: "Inline script containing destructive file operations",
		suggestion: "Write to a file instead of using inline script execution",
		severity: "high",
		category: "inline-scripts",
	},
	{
		id: "builtin-bash-c-destruct",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				field: "command",
				// `bash -c` is matched raw (no executed_only) so a destructive
				// verb inside the quoted script stays visible. The kill-* rules
				// use executed_only and would otherwise miss
				// `bash -c "kill -9 ..."`, so the bare-kill danger forms
				// (signal, command substitution, multi-PID) are covered here.
				regex: "\\bbash\\s+-c\\s+.*\\b(rm\\s+-rf|killall|pkill|kill\\s+(?:-|\\$\\(|`|[0-9]+\\s+[0-9]))",
				flags: "i",
			},
		],
		reason: "Destructive command embedded in bash -c",
		suggestion: "Run directly so it can be properly reviewed",
		severity: "high",
		category: "inline-scripts",
	},

	// ===========================================
	// Additional destructive patterns (Feature 2)
	// ===========================================
	{
		id: "builtin-shred",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bshred\\s" }],
		reason: "shred securely overwrites files making recovery impossible",
		suggestion: "Use rm for normal deletion",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-wipefs",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bwipefs\\s" }],
		reason: "wipefs erases filesystem signatures from block devices",
		suggestion: "Ask the user to run this manually",
		severity: "critical",
		category: "filesystem",
	},
	{
		id: "builtin-git-filter-branch",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{ field: "command", regex: "\\bgit\\s+filter-branch\\b", flags: "i" },
			{ field: "command", regex: "\\bgit\\s+filter-repo\\b", flags: "i" },
		],
		reason: "git filter-branch/filter-repo rewrites entire repository history",
		suggestion: "This is a destructive rewrite of all commits. Ask the user to run manually",
		severity: "critical",
		category: "git-operations",
	},
	{
		id: "builtin-git-restore-dot",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [{ field: "command", regex: "\\bgit\\s+restore\\s+\\." }],
		reason: "git restore . discards all unstaged changes",
		suggestion: "Use git stash first to preserve changes, or restore specific files",
		severity: "high",
		category: "git-operations",
	},

	// --- Git: amend, single-file discard, clone-into-tree, interactive add ---
	// Closes gaps surfaced by the agentic-engineering-patterns review: the
	// OpenAI Codex system prompt forbids amending commits and destructive
	// checkout/restore, and Simon Willison's guide recommends cloning
	// reference repos to /tmp so they can't contaminate the working tree.
	{
		id: "builtin-git-commit-amend",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `[^|&;]*` keeps the match inside one `git commit` invocation so a
			// `&&`-chained later command can't pull `--amend` in. executed_only
			// masks quoted strings so `git commit -m "fix --amend bug"` is safe.
			{
				field: "command",
				regex: "\\bgit\\s+commit\\b[^|&;]*\\s--amend\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git commit --amend rewrites the most recent commit. If that commit was already pushed, the local and remote histories diverge and reconciling them needs a force-push.",
		suggestion:
			"Confirm the commit being amended has not been pushed to a shared branch. To extend history without rewriting it, make a new commit instead.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-discard-file",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "ask",
		patterns: [
			// `git checkout [<ref>...] -- <file>` discards uncommitted changes to
			// a specific file. The `.` wildcard form is excluded — it is already
			// hard-blocked by builtin-git-checkout-dot.
			{
				// Bounded walker (excludes shell metacharacters) keeps the match
				// inside checkout's own segment; executed_only masks quotes.
				field: "command",
				regex: "\\bgit\\s+checkout\\s+(?:[^\\s;&|<>()`]+\\s+)*--\\s+(?!\\.(?:\\s|$))\\S",
				flags: "i",
				executed_only: true,
			},
			// `git restore <file>` defaults to --worktree and discards changes.
			// --staged/-S (index only, non-destructive) and --worktree/-W
			// (blocked by builtin-git-restore-worktree) are excluded; the bare
			// `.` form is builtin-git-restore-dot's job.
			{
				field: "command",
				regex: "\\bgit\\s+restore\\s+(?!(?:--staged|-S|--worktree|-W)\\b)(?!\\.(?:\\s|$))\\S",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git checkout -- <file> / git restore <file> discards uncommitted changes to that file with no undo.",
		suggestion:
			"Confirm you want to lose those changes — git stash first if you might need them back.",
		severity: "medium",
		category: "git-operations",
	},
	{
		id: "builtin-git-clone-into-tree",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "soft_block",
		patterns: [
			// Fires when a `git clone` SEGMENT ends with a relative destination
			// (not `/...`, `~`, or a flag). The `[^;&|<>\n]*` walker is bounded
			// to the clone's own segment so a compound's final token isn't read
			// as the destination (`git clone <url> /tmp/x && git -C /tmp/x
			// rev-list --count HEAD` used to fire on `HEAD`). Lookarounds drop
			// fd-redirect / trailing numeric / flag-value tails (`2>&1`,
			// `--depth 1`). Pre-existing gaps: bare `git clone <url>` and a
			// quoted relative destination are not caught.
			{
				field: "command",
				regex:
					"\\bgit\\s+clone\\b[^;&|<>\\n]*\\s(?<!\\s-[\\w-]+\\s)(?![-/~])(?!\\d+\\s*(?:$|[;&|<>\\n]))[\\w.][\\w./-]*\\s*(?=$|[;&|<>\\n])",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git clone with a relative destination drops the cloned repo inside the working tree, where its files can be accidentally staged and committed.",
		suggestion:
			"Clone reference repositories to /tmp instead — git clone <url> /tmp/<name> — so they can't contaminate this project. Re-run if the in-tree location is intentional.",
		severity: "low",
		category: "git-operations",
	},
	{
		id: "builtin-git-add-interactive",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash", "Shell", "run_command"],
		action: "block",
		patterns: [
			{
				// Bounded walker (excludes shell metacharacters) keeps the match
				// inside `git add`'s own segment; executed_only masks quotes.
				// Plain newlines end commands; escaped newlines continue them.
				field: "command",
				regex: "\\bgit(?:[ \\t]|\\\\\\r?\\n)+add(?:[ \\t]|\\\\\\r?\\n)+(?:[^\\s;&|<>()`]+(?:[ \\t]|\\\\\\r?\\n)+)*(?:-i|-p|-e|--interactive|--patch|--edit)\\b",
				flags: "i",
				executed_only: true,
			},
		],
		reason:
			"git add -i / -p / -e opens an interactive prompt or editor that hangs a non-interactive agent tool call indefinitely.",
		suggestion:
			"Stage whole files with git add <pathspec>. For selected hunks, prepare a reviewed patch and use git apply --cached <patch>; this updates only the index and preserves working-tree edits.",
		severity: "medium",
		category: "git-operations",
	},
];
