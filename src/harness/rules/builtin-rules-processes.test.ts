// ===========================================
// builtin-rules-processes — per-rule guard behavior corpus
// ===========================================
//
// Companion test for the `PROCESS_AND_FILESYSTEM_RULES` table. Every case runs
// through the REAL `evaluatePreToolUse` against a config whose rule set is
// exactly that table (sibling spreads included), because that is the shape the
// daemon evaluates.
//
// Why scope the config to this table instead of the full built-in set: with all
// ~119 rules loaded, a rule that stopped firing is usually masked by a
// neighbouring rule that blocks the same command anyway, so "did THIS entry do
// its job" becomes unobservable. Each block case therefore asserts the resolved
// decision AND its `rule_id` / `severity` / `category` / agent-facing prose —
// the five things a table entry exists to supply. The agent only ever sees the
// prose, so the prose is behavior and is asserted verbatim.
//
// SAFETY NOTE — read before touching a MUST-ALLOW case. An allow case is a
// pinned claim that a command is NOT dangerous; a wrong one would teach a
// future agent to widen the guard until the test passes. Every allow case here
// is one of:
//   (a) an exemption the rule's own regex spells out (`rm -rf /tmp/...`,
//       `git push --force-with-lease`, `pkill -f 'wrangler dev'`),
//   (b) the non-destructive sibling of the blocked verb (`git clean -n`,
//       `git branch -d`, `git reset --soft`, `rm -rf .wrangler/cache`), or
//   (c) a MENTION of a dangerous command inside quotes, which `executed_only`
//       masks by design (pinned so the masking cannot silently regress into
//       over-blocking).
// None of them is an executed destructive command.

import { beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig } from "../rules-loader.js";
import type {
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { PROCESS_AND_FILESYSTEM_RULES } from "./builtin-rules-processes.js";

const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

/** The three tool names every entry in this table declares in `tool_match`. */
const DECLARED_TOOLS = ["Bash", "Shell", "run_command"] as const;

function makeSession(): SessionTrajectory {
	return {
		session_id: "proc-rules",
		agent_name: "proc-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 5,
		error_count: 0,
		files_read: new Set(["/repo/file.ts"]),
		files_written: new Set(),
		commands_run: ["git log --oneline", "npm test"],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 5,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		// Every temporal precondition pre-satisfied so trajectory gating stays
		// dormant and these cases measure deterministic table behavior only.
		tool_sequence: ["Read:/repo/file.ts", "Bash:git log --oneline", "Bash:npm test"],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		verification_observed: new Set(["test"]),
	};
}

let rules: GuardRulesConfig;
let cohort: CohortManager;
let reservations: ReservationManager;
let session: SessionTrajectory;

beforeEach(() => {
	rules = getDefaultConfig();
	rules.rules = PROCESS_AND_FILESYSTEM_RULES;
	if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
	cohort = new CohortManager();
	reservations = new ReservationManager();
	session = makeSession();
});

interface EvalOpts {
	tool?: string;
	/** Extra tool_input keys — used to prove patterns read `command` and not
	 *  whatever else the payload happens to carry. */
	extraInput?: Record<string, string>;
}

function evaluate(command: string, opts: EvalOpts = {}): HarnessDecision {
	const event: HarnessEvent = {
		hook_event: "PreToolUse",
		session_id: "proc-rules",
		agent_source: "claude",
		agent_name: "proc-agent",
		tool_name: opts.tool ?? "Bash",
		tool_input: { ...(opts.extraInput ?? {}), command },
		timestamp: FIXED_TIMESTAMP,
	};
	return evaluatePreToolUse(event, rules, session, reservations, cohort);
}

// ---------------------------------------------------------------------------
// Per-rule contract: the command it must block, and the full decision payload
// the agent receives when it does.
// ---------------------------------------------------------------------------

interface RuleContract {
	rule_id: string;
	severity: "critical" | "high" | "medium" | "low";
	category: string;
	reason: string;
	suggestion: string;
	/** A representative command this entry must block. */
	command: string;
}

const RULE_CONTRACTS: RuleContract[] = [
	{
		rule_id: "builtin-pkill-f",
		severity: "high",
		category: "process-killing",
		reason: "pkill -f matches processes across ALL projects/sessions",
		suggestion:
			"Use specific PID: kill <pid>. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		command: "pkill -f node",
	},
	{
		rule_id: "builtin-killall",
		severity: "high",
		category: "process-killing",
		reason: "killall terminates ALL processes with matching name",
		suggestion: "Use specific PID: kill <pid>",
		command: "killall node",
	},
	{
		rule_id: "builtin-pkill-node",
		severity: "high",
		category: "process-killing",
		reason: "Would kill processes across all projects",
		suggestion:
			"Use specific PID or port-based killing: lsof -ti :<port> | xargs kill. To kill local dev processes, be specific: pkill -f 'wrangler dev'",
		command: "pkill node",
	},
	{
		rule_id: "builtin-pgrep-xargs-kill",
		severity: "high",
		category: "process-killing",
		reason: "Pattern kills processes system-wide (same blast radius whether piped, substituted, or looped)",
		suggestion:
			"Enumerate, confirm, then kill: run `pgrep -fl '<pattern>'` first to SEE the matches are yours, then kill those exact PIDs — `kill <pid> <pid> …` (or `pgrep -f '<pattern>' | xargs -n1 kill` once you have verified the list). Listing first is the safe step the raw pipe skips.",
		command: "pgrep node | xargs kill",
	},
	{
		rule_id: "builtin-rm-rf-root",
		severity: "critical",
		category: "file-deletion",
		reason: "Recursive deletion of root-level or wildcard paths is dangerous",
		suggestion: "Be more specific about what to delete",
		command: "rm -rf /etc",
	},
	{
		rule_id: "builtin-rm-wrangler",
		severity: "critical",
		category: "file-deletion",
		reason:
			"CRITICAL: .wrangler contains the local development database (SQLite). Deleting it DESTROYS ALL LOCAL DATA.",
		suggestion: "To fix deployment issues, try: rm -rf .wrangler/cache (keeps database)",
		command: "rm -rf .wrangler",
	},
	{
		rule_id: "builtin-rm-node-modules",
		severity: "medium",
		category: "file-deletion",
		reason: "Deleting node_modules requires a full reinstall",
		suggestion: "If you have dependency issues, try: npm cache clean --force && npm install",
		command: "rm -rf node_modules",
	},
	{
		rule_id: "builtin-git-worktree-add",
		severity: "high",
		category: "git-operations",
		reason: "Agent-created Git worktrees are disabled by default",
		suggestion:
			"Use the existing workspace; a human operator may provision an approved worktree outside the agent session",
		command: "git worktree add ../feature feature",
	},
	{
		rule_id: "builtin-git-force-push",
		severity: "critical",
		category: "git-operations",
		reason: "git push --force can destroy remote commits and collaborators' work",
		suggestion: "Use --force-with-lease for safer force pushing",
		command: "git push --force origin main",
	},
	{
		rule_id: "builtin-git-reset-hard",
		severity: "high",
		category: "git-operations",
		reason: "git reset --hard destroys all uncommitted changes",
		suggestion: "Use git stash first to preserve changes",
		command: "git reset --hard HEAD~1",
	},
	{
		rule_id: "builtin-git-clean-f",
		severity: "high",
		category: "git-operations",
		reason: "git clean -f permanently deletes untracked files",
		suggestion: "Use git clean -n first to preview what will be deleted",
		command: "git clean -fd",
	},
	{
		rule_id: "builtin-kill-signal",
		severity: "high",
		category: "process-killing",
		reason: "Sending termination signals is dangerous. Use plain 'kill <PID>' (SIGTERM) instead",
		suggestion: "Use plain: kill <PID>",
		command: "kill -9 12345",
	},
	{
		rule_id: "builtin-kill-multi-pid",
		severity: "high",
		category: "process-killing",
		reason: "Killing multiple PIDs at once is dangerous",
		suggestion: "Kill one PID at a time",
		command: "kill 12345 67890",
	},
	{
		rule_id: "builtin-kill-substitution",
		severity: "high",
		category: "process-killing",
		reason: "kill with command substitution or piped xargs is dangerous",
		suggestion: "Find the PID first, then kill it by number",
		command: "kill $(cat pidfile)",
	},
	{
		rule_id: "builtin-pkill-signal",
		severity: "high",
		category: "process-killing",
		reason: "pkill with signal kills matching processes system-wide",
		suggestion: "Use specific PID: kill -<signal> <pid>",
		command: "pkill -9 nginx",
	},
	{
		rule_id: "builtin-kill-port",
		severity: "medium",
		category: "process-killing",
		reason:
			"This will kill a process listening on a port (possibly a dev server). If you need to restart the server, re-run this command.",
		suggestion:
			"Confirm this is intentional — a running dev server may be in use by the user or another agent",
		command: "fuser -k 3000/tcp",
	},
	{
		rule_id: "builtin-git-checkout-dot",
		severity: "high",
		category: "git-operations",
		reason: "git checkout -- . discards all unstaged changes",
		suggestion: "Use git stash first to preserve changes",
		command: "git checkout -- .",
	},
	{
		rule_id: "builtin-git-restore-worktree",
		severity: "high",
		category: "git-operations",
		reason: "git restore --worktree discards working tree changes",
		suggestion: "Use git stash first to preserve changes",
		command: "git restore --worktree src/",
	},
	{
		rule_id: "builtin-git-branch-D",
		severity: "medium",
		category: "git-operations",
		reason:
			"git branch -D/-M/-f is a force operation: it deletes or moves a branch ref without the usual safety checks",
		suggestion:
			"For deletion use -d (merge-checked - it refuses unmerged branches). -f/-M force-move a branch ref and can orphan commits; re-run only if intended.",
		command: "git branch -D feature",
	},
	{
		rule_id: "builtin-git-stash-destroy",
		severity: "high",
		category: "git-operations",
		reason: "git stash drop/clear permanently removes stashed work",
		suggestion: "Verify stash contents first with git stash list",
		command: "git stash drop",
	},
];

describe("PROCESS_AND_FILESYSTEM_RULES — positive (must block, with the exact payload)", () => {
	for (const rc of RULE_CONTRACTS) {
		it(`P: ${rc.rule_id} blocks \`${rc.command}\` and reports id/severity/category`, () => {
			const result = evaluate(rc.command);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe(rc.rule_id);
			expect(result.severity).toBe(rc.severity);
			expect(result.category).toBe(rc.category);
		});

		it(`P: ${rc.rule_id} renders its reason + suggestion verbatim`, () => {
			const result = evaluate(rc.command);
			// The agent sees ONLY this string when the block fires; it is the
			// product's voice and is pinned character-for-character.
			expect(result.reason).toBe(`BLOCKED: ${rc.reason}\n\nSuggestion: ${rc.suggestion}`);
		});

		// `tool_match` is an explicit allowlist, one entry per runner-supplied
		// tool name. Each declared name gets its own case so dropping any single
		// entry is observable.
		for (const tool of DECLARED_TOOLS) {
			it(`P: ${rc.rule_id} applies to tool_match entry "${tool}"`, () => {
				const result = evaluate(rc.command, { tool });
				expect(result.decision).toBe("block");
				expect(result.rule_id).toBe(rc.rule_id);
			});
		}
	}
});

// ---------------------------------------------------------------------------
// Every pattern in the table, one triggering command each. Multi-pattern rules
// need one case per alternative or a pattern can be neutralised unnoticed.
// ---------------------------------------------------------------------------

interface PatternCase {
	label: string;
	command: string;
	rule_id: string;
}

const PATTERN_TRIGGERS: PatternCase[] = [
	{ label: "pkill-f: signal + -f form", command: "pkill -9 -f node", rule_id: "builtin-pkill-f" },
	{
		label: "pgrep-xargs: pgrep piped to xargs kill",
		command: "pgrep node | xargs kill",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "pgrep-xargs: kill of a $(pgrep) substitution",
		command: "kill $(pgrep node)",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "pgrep-xargs: ps pipeline ending in xargs kill",
		command: "ps aux | grep node | awk '{print $2}' | xargs kill",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "pgrep-xargs: loop over pgrep results",
		command: 'for p in $(pgrep -f "node worker"); do kill "$p"; done',
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{ label: "rm-rf-root: absolute path", command: "rm -rf /etc", rule_id: "builtin-rm-rf-root" },
	{ label: "rm-rf-root: bare wildcard", command: "rm -rf *", rule_id: "builtin-rm-rf-root" },
	{
		label: "rm-wrangler: whole directory",
		command: "rm -rf .wrangler",
		rule_id: "builtin-rm-wrangler",
	},
	{
		label: "rm-wrangler: state subdirectory",
		command: "rm -rf .wrangler/state",
		rule_id: "builtin-rm-wrangler",
	},
	{
		label: "force-push: long flag",
		command: "git push --force origin main",
		rule_id: "builtin-git-force-push",
	},
	{
		label: "force-push: bundled short flag",
		command: "git push -uf origin main",
		rule_id: "builtin-git-force-push",
	},
	{ label: "kill-signal: numeric signal", command: "kill -9 12345", rule_id: "builtin-kill-signal" },
	{
		label: "kill-signal: SIG-prefixed name",
		command: "kill -SIGKILL 12345",
		rule_id: "builtin-kill-signal",
	},
	{ label: "kill-signal: -s form", command: "kill -s TERM 12345", rule_id: "builtin-kill-signal" },
	{
		label: "kill-substitution: $() form",
		command: "kill $(cat pidfile)",
		rule_id: "builtin-kill-substitution",
	},
	{
		label: "kill-substitution: backtick form",
		command: "kill `cat pidfile`",
		rule_id: "builtin-kill-substitution",
	},
	{
		label: "kill-substitution: piped xargs kill",
		command: "cat pids.txt | xargs kill",
		rule_id: "builtin-kill-substitution",
	},
	{
		label: "pkill-signal: numeric signal",
		command: "pkill -9 nginx",
		rule_id: "builtin-pkill-signal",
	},
	{
		label: "pkill-signal: SIG-prefixed name",
		command: "pkill -SIGKILL nginx",
		rule_id: "builtin-pkill-signal",
	},
	{
		label: "kill-port: lsof port pipeline",
		command: "lsof -ti:3000 | kill",
		rule_id: "builtin-kill-port",
	},
	{ label: "kill-port: fuser -k", command: "fuser -k 3000/tcp", rule_id: "builtin-kill-port" },
	{ label: "kill-port: kill-port binary", command: "kill-port 3000", rule_id: "builtin-kill-port" },
	{
		label: "kill-port: npx kill-port",
		command: "npx kill-port 3000",
		rule_id: "builtin-kill-port",
	},
	{
		label: "stash-destroy: drop",
		command: "git stash drop",
		rule_id: "builtin-git-stash-destroy",
	},
	{
		label: "stash-destroy: clear",
		command: "git stash clear",
		rule_id: "builtin-git-stash-destroy",
	},
];

describe("PROCESS_AND_FILESYSTEM_RULES — positive (every pattern alternative fires)", () => {
	for (const pc of PATTERN_TRIGGERS) {
		it(`P: ${pc.label}`, () => {
			const result = evaluate(pc.command);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe(pc.rule_id);
		});
	}
});

// ---------------------------------------------------------------------------
// Case-insensitivity: patterns carrying `flags: "i"` must survive a case-variant
// spelling of the command. On a case-insensitive filesystem (macOS) `KILL 1 2`
// really does run /bin/kill, so this is a bypass class, not a curiosity.
// ---------------------------------------------------------------------------

const CASE_VARIANTS: PatternCase[] = [
	{ label: "pkill-node: uppercase process name", command: "pkill NODE", rule_id: "builtin-pkill-node" },
	{
		label: "pgrep-xargs: capitalised kill after xargs",
		command: "pgrep node | xargs Kill",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "pgrep-xargs: uppercase pgrep inside substitution",
		command: "kill $(PGREP node)",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "pgrep-xargs: capitalised kill after a ps pipeline",
		command: "ps aux | grep node | awk '{print $2}' | xargs Kill",
		rule_id: "builtin-pgrep-xargs-kill",
	},
	{
		label: "kill-signal: uppercase binary + SIG name",
		command: "KILL -SIGKILL 12345",
		rule_id: "builtin-kill-signal",
	},
	{
		label: "kill-signal: uppercase binary + -s form",
		command: "KILL -s TERM 12345",
		rule_id: "builtin-kill-signal",
	},
	{
		label: "kill-multi-pid: uppercase binary",
		command: "KILL 12345 67890",
		rule_id: "builtin-kill-multi-pid",
	},
	{
		label: "kill-substitution: capitalised kill after xargs",
		command: "cat pids.txt | xargs Kill",
		rule_id: "builtin-kill-substitution",
	},
	{
		label: "pkill-signal: uppercase binary + SIG name",
		command: "PKILL -SIGKILL nginx",
		rule_id: "builtin-pkill-signal",
	},
	{
		label: "kill-port: capitalised kill in an lsof pipeline",
		command: "lsof -ti:3000 | Kill",
		rule_id: "builtin-kill-port",
	},
	{
		label: "kill-port: uppercase fuser flag",
		command: "fuser -K 3000/tcp",
		rule_id: "builtin-kill-port",
	},
	{
		label: "kill-port: capitalised kill-port binary",
		command: "Kill-Port 3000",
		rule_id: "builtin-kill-port",
	},
	{
		label: "stash-destroy: uppercase subcommand",
		command: "git stash DROP",
		rule_id: "builtin-git-stash-destroy",
	},
];

describe("PROCESS_AND_FILESYSTEM_RULES — positive (case-variant spellings still block)", () => {
	for (const pc of CASE_VARIANTS) {
		it(`P: ${pc.label}`, () => {
			const result = evaluate(pc.command);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe(pc.rule_id);
		});
	}
});

// ---------------------------------------------------------------------------
// `executed_only` masking: a MENTION of the dangerous command inside quotes is
// data, not an invocation. One case per executed_only pattern — dropping the
// flag on any one of them turns that pattern into an over-blocker.
// ---------------------------------------------------------------------------

const MASKED_MENTIONS: Array<{ label: string; command: string }> = [
	{ label: "killall", command: `echo 'killall node'` },
	{ label: "pgrep-xargs: pipeline", command: `echo 'pgrep node | xargs kill'` },
	{ label: "pgrep-xargs: substitution", command: `echo 'kill $(pgrep node)'` },
	{ label: "pgrep-xargs: ps pipeline", command: `echo 'ps aux | grep x | xargs kill'` },
	{ label: "rm -rf absolute", command: `echo 'rm -rf /etc'` },
	{ label: "rm -rf wildcard", command: `echo 'rm -rf *'` },
	{ label: "git push --force", command: `echo 'git push --force'` },
	{ label: "git worktree add", command: `echo 'git worktree add ../feature'` },
	{ label: "git push -f", command: `echo 'git push -f'` },
	{ label: "git reset --hard", command: `echo 'git reset --hard'` },
	{ label: "git clean -fd", command: `echo 'git clean -fd'` },
	{ label: "kill -9", command: `echo 'kill -9 123'` },
	{ label: "kill -SIGKILL", command: `echo 'kill -SIGKILL 123'` },
	{ label: "kill -s TERM", command: `echo 'kill -s TERM 123'` },
	// The trailing word matters: builtin-kill-multi-pid's regex ends in a
	// `(?=\s|$|[;|&])` lookahead, so a mention that stops at the closing quote
	// would not match the raw text either and would prove nothing about masking.
	{ label: "kill two PIDs", command: `echo 'never run kill 111 222 on a shared box'` },
	{ label: "kill $()", command: `echo 'kill $(cat pidfile)'` },
	{ label: "kill backticks", command: "echo 'kill `cat pidfile`'" },
	{ label: "xargs kill pipeline", command: `echo 'cat pids.txt | xargs kill'` },
	{ label: "pkill -9", command: `echo 'pkill -9 nginx'` },
	{ label: "pkill -SIGKILL", command: `echo 'pkill -SIGKILL nginx'` },
];

describe("PROCESS_AND_FILESYSTEM_RULES — negative (quoted mentions are data, not commands)", () => {
	for (const mm of MASKED_MENTIONS) {
		it(`N: quoted mention of ${mm.label} does not block`, () => {
			const result = evaluate(mm.command);
			expect(result.decision).toBe("allow");
		});
	}
});

// ---------------------------------------------------------------------------
// Heredoc bodies: a QUOTED-delimiter body fed to a non-shell runtime (python3,
// node) or a data sink (cat) is neither expanded nor run by the shell, so a
// kill mention there is data. A body fed to a shell is code and still blocks.
// An UNQUOTED body to python3 also still blocks, by decision: the shell runs
// every $() and backtick in that body before python3 reads it, so the
// substitution is a real execution even though `kill` is only Python text.
// Origin: a python3 <<'PYEOF' analysis script with the prose
// "mark the kill `stale` and re-measure" was blocked by
// builtin-kill-substitution (2026-10-02).
// ---------------------------------------------------------------------------

const HEREDOC_DATA_BODIES: Array<{ label: string; command: string }> = [
	{
		label: "quoted heredoc to python3 with kill + backtick prose",
		command:
			"python3 - <<'PYEOF'\nnotes = []\nnotes.append(\"mark the kill `stale` and re-measure\")\nprint(notes)\nPYEOF\n",
	},
	{
		label: "quoted heredoc to cat with kill + backtick prose",
		command: "cat <<'EOF' > notes.md\nmark the kill `stale` and re-measure\nEOF\n",
	},
	{
		label: "quoted heredoc to node with kill + backtick prose",
		command: "node - <<'EOF'\nconsole.log('mark the kill `stale` and re-measure');\nEOF\n",
	},
	{
		label: "quoted heredoc to python3 with 2>&1 before the operator",
		command: "python3 - 2>&1 <<'EOF'\nprint(\"mark the kill `stale` and re-measure\")\nEOF\n",
	},
	{
		label: "quoted heredoc to npx tsx",
		command: "npx tsx - <<'EOF'\nconsole.log('mark the kill `stale` and re-measure');\nEOF\n",
	},
	{
		label: 'quoted heredoc to python3 after a balanced cd "$( )"',
		command:
			"cd \"$(git rev-parse --show-toplevel)\" && python3 - <<'PYEOF'\nprint(\"mark the kill `stale` and re-measure\")\nPYEOF\n",
	},
];

describe("PROCESS_AND_FILESYSTEM_RULES — negative (quoted heredoc bodies to data readers)", () => {
	for (const hd of HEREDOC_DATA_BODIES) {
		it(`N: ${hd.label} does not block`, () => {
			expect(evaluate(hd.command).decision).toBe("allow");
		});
	}
});

const HEREDOC_EXECUTED_KILLS: Array<{ label: string; command: string }> = [
	{ label: "plain kill $(pgrep node)", command: "kill $(pgrep node)" },
	{ label: "plain kill `pgrep node`", command: "kill `pgrep node`" },
	{ label: "plain pgrep node | xargs kill", command: "pgrep node | xargs kill" },
	{ label: "quoted heredoc to bash", command: "bash <<'EOF'\nkill $(pgrep x)\nEOF\n" },
	{ label: "quoted heredoc to sh -s", command: "sh -s <<'EOF'\nkill $(pgrep x)\nEOF\n" },
	{ label: "unquoted heredoc to bash", command: "bash <<EOF\nkill $(pgrep x)\nEOF\n" },
	{
		label: "unquoted heredoc to python3 (shell expands the body)",
		command: "python3 - <<PYEOF\nprint('kill $(pgrep x)')\nPYEOF\n",
	},
	{
		label: "kill on the header line of a quoted python3 heredoc",
		command: "python3 - <<'EOF' && kill $(pgrep x)\nprint('hi')\nEOF\n",
	},
	// Repair round: the four bypass shapes a verifier found (bash runs each).
	{ label: "here-string, then a kill line", command: "python3 <<<'x'\nkill $(pgrep node)" },
	{
		label: "`EOF)` closer inside $( ), then a kill line",
		command: "x=$(python3 - <<'EOF'\nprint(1)\nEOF)\nkill $(pgrep node)",
	},
	{
		label: "python3 output piped to sh",
		command: "python3 - <<'EOF' | sh\nprint(\"kill $(pgrep node)\")\nEOF",
	},
	{
		label: "sudo -u node bash heredoc",
		command: "sudo -u node bash <<'EOF'\nkill $(pgrep node)\nEOF",
	},
	// Repair round 2: the runtime's output reaches a shell (each shape ran an
	// echo payload under zsh 5).
	{
		label: 'eval "$( )" hidden by a quote the span scanner pairs wrongly',
		command: "eval \"$(: '\"'\\'; python3 - <<'EOF'\nprint(\"kill $(pgrep node)\")\nEOF\n)\"",
	},
	{
		label: "case pattern `)` inside eval $( )",
		command: "eval $(case x in x) ;; esac; python3 - <<'EOF'\nprint(\"kill $(pgrep node)\")\nEOF\n)",
	},
	{
		label: "zsh coproc fed by >&p",
		command: "coproc sh\npython3 - <<'EOF' >&p\nprint(\"kill $(pgrep node)\")\nEOF",
	},
	{
		label: "zsh foreach … end piped to sh",
		command: "foreach i (1)\npython3 - <<'EOF'\nprint(\"kill $(pgrep node)\")\nEOF\nend | sh",
	},
];

describe("PROCESS_AND_FILESYSTEM_RULES — positive (executed kill substitutions still block)", () => {
	for (const hk of HEREDOC_EXECUTED_KILLS) {
		it(`P: ${hk.label} blocks`, () => {
			const result = evaluate(hk.command);
			expect(result.decision).toBe("block");
			expect(["builtin-kill-substitution", "builtin-pgrep-xargs-kill"]).toContain(result.rule_id);
		});
	}
});

// ---------------------------------------------------------------------------
// Near misses: the non-destructive sibling of each blocked verb, and the
// exemptions the regexes spell out. These are the precision payload.
// ---------------------------------------------------------------------------

const NEAR_MISSES: Array<{ label: string; command: string }> = [
	{ label: "pkill -f scoped to a dev process", command: `pkill -f 'wrangler dev'` },
	{ label: "pkill -f scoped to a pages process", command: `pkill -f 'wrangler pages'` },
	{ label: "pkill -f scoped to a tail process", command: `pkill -f 'wrangler tail'` },
	{ label: "pkill -f scoped to a logs process", command: `pkill -f 'vercel logs'` },
	{ label: "killall -l (lists signal names)", command: "killall -l" },
	{ label: "pkill --pidfile (targets one recorded pid)", command: "pkill --pidfile /run/node.pid" },
	{ label: "ps inspection pipeline with no kill", command: "ps aux | grep claude | awk '{print $11}'" },
	{ label: "rm -rf under /tmp", command: "rm -rf /tmp/build" },
	{ label: "rm -rf under /var/tmp", command: "rm -rf /var/tmp/x" },
	{ label: "rm -rf of a relative build dir", command: "rm -rf dist/" },
	{ label: "rm -rf .wrangler/cache (keeps the database)", command: "rm -rf .wrangler/cache" },
	{ label: "rm -rf inside node_modules", command: "rm -rf node_modules/.cache" },
	{ label: "git push --force-with-lease", command: "git push --force-with-lease origin main" },
	{ label: "git push --force-if-includes", command: "git push --force-if-includes origin main" },
	{ label: "plain git push", command: "git push origin main" },
	{ label: "git worktree list", command: "git worktree list" },
	{ label: "git worktree remove", command: "git worktree remove ../feature" },
	{ label: "git worktree prune", command: "git worktree prune" },
	{ label: "git reset --soft", command: "git reset --soft HEAD~1" },
	{ label: "git clean -n (dry run)", command: "git clean -n" },
	{ label: "plain single-PID kill", command: "kill 12345" },
	{ label: "single-PID kill with a redirect", command: "kill 12345 2>/dev/null" },
	{ label: "git branch -d (merge-checked delete)", command: "git branch -d feature" },
	{ label: "git branch listing", command: "git branch --list" },
	{ label: "git stash list", command: "git stash list" },
	{ label: "git restore --staged", command: "git restore --staged file.txt" },
	{ label: "git checkout of a new branch", command: "git checkout -b feature/x" },
	{ label: "npm build", command: "npm run build" },
	{ label: "git status", command: "git status" },
	{ label: "directory listing", command: "ls -la" },
];

describe("PROCESS_AND_FILESYSTEM_RULES — negative (safe siblings and spelled-out exemptions)", () => {
	for (const nm of NEAR_MISSES) {
		it(`N: ${nm.label} is allowed`, () => {
			const result = evaluate(nm.command);
			expect(result.decision).toBe("allow");
		});
	}
});

// ---------------------------------------------------------------------------
// Field scoping: every pattern reads the `command` key. Dangerous text parked
// under a different payload key is not a command and must not be scanned —
// otherwise a rule would fire on data the tool never executes.
// ---------------------------------------------------------------------------

const SAFE_COMMAND = "npm run build";

const OFF_COMMAND_PAYLOADS: string[] = [
	"pkill -f node",
	"killall node",
	"pkill node",
	"pgrep node | xargs kill",
	"kill $(pgrep node)",
	"ps aux | grep node | xargs kill",
	"rm -rf /etc",
	"rm -rf *",
	"rm -rf .wrangler",
	"rm -rf .wrangler/state",
	"rm -rf node_modules",
	"git push --force origin main",
	"git worktree add ../feature feature",
	"git push -uf origin main",
	"git reset --hard HEAD~1",
	"git clean -fd",
	"kill -9 12345",
	"kill -SIGKILL 12345",
	"kill -s TERM 12345",
	"kill 12345 67890",
	"kill $(cat pidfile)",
	"kill `cat pidfile`",
	"cat pids.txt | xargs kill",
	"pkill -9 nginx",
	"pkill -SIGKILL nginx",
	"lsof -ti:3000 | kill",
	"fuser -k 3000/tcp",
	"kill-port 3000",
	"npx kill-port 3000",
	"git checkout -- .",
	"git restore --worktree src/",
	"git branch -D feature",
	"git stash drop",
];

describe("PROCESS_AND_FILESYSTEM_RULES — negative (patterns scan `command`, not other keys)", () => {
	for (const payload of OFF_COMMAND_PAYLOADS) {
		it(`N: \`${payload}\` under a non-command key does not block`, () => {
			// The empty key is the one a dropped `field` selector would fall back
			// to reading, so it is the probe that proves the selector is honoured.
			const result = evaluate(SAFE_COMMAND, { extraInput: { "": payload } });
			expect(result.decision).toBe("allow");
		});
	}
});

// ---------------------------------------------------------------------------
// Whole-table properties.
// ---------------------------------------------------------------------------

describe("PROCESS_AND_FILESYSTEM_RULES — table-level behavior", () => {
	it("N: an unnamed tool matches no entry (tool_match is an allowlist, not a wildcard)", () => {
		// Guards the redundant lowercase "bash" entry on builtin-kill-port: an
		// entry that matched the empty tool name would silently widen every
		// rule's tool scope.
		const result = evaluate("fuser -k 3000/tcp", { tool: "" });
		expect(result.decision).not.toBe("block");
	});

	it("P: kill-port is a soft block — the same command is allowed on retry", () => {
		const first = evaluate("fuser -k 3000/tcp");
		expect(first.decision).toBe("block");
		const second = evaluate("fuser -k 3000/tcp");
		expect(second.decision).toBe("allow");
		expect(second.warnings?.some((w) => w.includes("retry allowed"))).toBe(true);
	});

	it("P: a hard-block entry stays blocked on retry (kill-port's softness is not shared)", () => {
		expect(evaluate("rm -rf /etc").decision).toBe("block");
		expect(evaluate("rm -rf /etc").decision).toBe("block");
	});

	it("P: the table still contributes its two sibling clusters", () => {
		// The spreads carry the system/filesystem and inline-git rules; if either
		// stopped being spread in, these commands would no longer be seen at all.
		expect(evaluate("sudo rm old.log").rule_id).toBe("builtin-sudo-rm");
		expect(evaluate("shred -u secrets.txt").rule_id).toBe("builtin-shred");
	});
});
