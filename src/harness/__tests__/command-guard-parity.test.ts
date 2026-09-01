// ===========================================
// Parity Test: Old command-guard-hook.ts vs Harness Built-in Rules
// ===========================================
// Proves that every command the old .claude/hooks/command-guard-hook.ts
// would block is also blocked by the harness's evaluatePreToolUse().
// This test is the gate for removing the old hook.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager, setActiveCohort } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

function makeEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: new Date().toISOString(),
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: new Date().toISOString(),
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
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
		last_coordination_ts: Date.now(),
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
}

describe("command-guard-hook.ts parity with harness", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	function runGuard(command: string): string {
		const event = makeEvent(command);
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		return String(result.decision);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ===========================================
	// Process Killing — Direct commands
	// Old hook patterns 1-8
	// ===========================================
	describe("process killing (direct)", () => {
		it("blocks pkill -f", () => {
			expect(runGuard("pkill -f myprocess")).toBe("block");
		});

		it("blocks pkill -9", () => {
			expect(runGuard("pkill -9 myprocess")).toBe("block");
		});

		it("blocks killall (not -l)", () => {
			expect(runGuard("killall node")).toBe("block");
		});

		it("blocks pkill wrangler", () => {
			expect(runGuard("pkill wrangler")).toBe("block");
		});

		it("blocks pkill node", () => {
			expect(runGuard("pkill node")).toBe("block");
		});

		it("blocks pkill bun", () => {
			expect(runGuard("pkill bun")).toBe("block");
		});

		it("blocks pkill python", () => {
			expect(runGuard("pkill python")).toBe("block");
		});

		it("blocks pkill claude", () => {
			expect(runGuard("pkill claude")).toBe("block");
		});
	});

	// ===========================================
	// Process Killing — Indirect patterns
	// Old hook patterns 9-13
	// ===========================================
	describe("process killing (indirect)", () => {
		it("blocks pgrep | xargs kill", () => {
			expect(runGuard("pgrep node | xargs kill")).toBe("block");
		});

		it("blocks kill $(pgrep ...)", () => {
			expect(runGuard("kill $(pgrep node)")).toBe("block");
		});

		it("blocks kill `pgrep ...`", () => {
			expect(runGuard("kill `pgrep node`")).toBe("block");
		});

		it("blocks ps aux | grep | kill", () => {
			expect(runGuard("ps aux | grep node | xargs kill")).toBe("block");
		});
	});

	// ===========================================
	// Dangerous rm
	// Old hook patterns 14-15
	// ===========================================
	describe("dangerous rm", () => {
		it("blocks rm on root paths", () => {
			expect(runGuard("rm -rf /usr")).toBe("block");
		});

		it("blocks rm -rf *", () => {
			expect(runGuard("rm -rf *")).toBe("block");
		});
	});

	// ===========================================
	// Local Development State
	// Old hook patterns 16-18
	// ===========================================
	describe("local development state", () => {
		it("blocks rm .wrangler", () => {
			expect(runGuard("rm -rf .wrangler")).toBe("block");
		});

		it("blocks rm .wrangler/state", () => {
			expect(runGuard("rm -rf .wrangler/state")).toBe("block");
		});

		it("blocks rm node_modules", () => {
			expect(runGuard("rm -rf node_modules")).toBe("block");
		});
	});

	// ===========================================
	// Git Force Operations
	// Old hook patterns 19-21
	// ===========================================
	describe("git operations", () => {
		it("blocks git push --force", () => {
			expect(runGuard("git push --force origin main")).toBe("block");
		});

		it("blocks git reset --hard", () => {
			expect(runGuard("git reset --hard HEAD~1")).toBe("block");
		});

		it("blocks git clean -f", () => {
			expect(runGuard("git clean -f")).toBe("block");
		});
	});

	// ===========================================
	// System Operations
	// Old hook patterns 22-23
	// ===========================================
	describe("system operations", () => {
		it("blocks sudo rm", () => {
			expect(runGuard("sudo rm /etc/hosts")).toBe("block");
		});

		it("blocks chmod -R 777", () => {
			expect(runGuard("chmod -R 777 .")).toBe("block");
		});

		it("blocks chmod 777", () => {
			expect(runGuard("chmod 777 mydir")).toBe("block");
		});

		it("blocks shutdown after a pipeline separator", () => {
			expect(runGuard("printf x | sudo reboot")).toBe("block");
		});

		it("blocks wrapped shutdown commands", () => {
			expect(runGuard("env FOO=1 command reboot")).toBe("block");
		});

		it("blocks quoted shell-c shutdown commands", () => {
			expect(runGuard('bash -c "reboot"')).toBe("block");
		});

		it("allows rg patterns that mention wrapped reboot as data", () => {
			expect(runGuard("rg -n 'foo|command reboot' src")).toBe("allow");
		});

		it("allows quoted echo text with a pipe before reboot", () => {
			expect(runGuard('echo "foo | reboot"')).toBe("allow");
		});
	});

	// ===========================================
	// Database Destruction
	// Old hook patterns 24-25
	// ===========================================
	describe("database destruction", () => {
		it("blocks DROP DATABASE", () => {
			expect(runGuard("echo 'DROP DATABASE mydb;' | psql")).toBe("block");
		});

		it("blocks TRUNCATE TABLE", () => {
			expect(runGuard("echo 'TRUNCATE TABLE users;' | psql")).toBe("block");
		});
	});

	// ===========================================
	// Intentional differences (old hook blocked, harness does not)
	// ===========================================
	describe("intentional differences (harness is less aggressive)", () => {
		it("does NOT block pgrep -f alone (read-only, not destructive)", () => {
			const event = makeEvent("pgrep -f node");
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// pgrep -f is information gathering — not destructive
			// The harness correctly does NOT block it
			expect(result.decision).toBe("allow");
		});

		it("does NOT block killall -l (listing only)", () => {
			const event = makeEvent("killall -l");
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Harness extras not in old hook (regression guard)
	// ===========================================
	describe("harness extras beyond old hook", () => {
		it("blocks git checkout -- .", () => {
			expect(runGuard("git checkout -- .")).toBe("block");
		});

		it("blocks git branch -D", () => {
			expect(runGuard("git branch -D feature-branch")).toBe("block");
		});

		it("blocks git branch -f (force-move a ref)", () => {
			expect(runGuard("git branch -f main HEAD~3")).toBe("block");
		});

		it("blocks git branch -M (force-rename)", () => {
			expect(runGuard("git branch -M old-name new-name")).toBe("block");
		});

		it("allows git branch -d (safe, merge-checked delete)", () => {
			expect(runGuard("git branch -d merged-feature")).not.toBe("block");
		});

		it("blocks docker system prune", () => {
			expect(runGuard("docker system prune")).toBe("block");
		});

		it("blocks terraform destroy", () => {
			expect(runGuard("terraform destroy")).toBe("block");
		});

		it("blocks rm of lock files", () => {
			expect(runGuard("rm package-lock.json")).toBe("block");
		});

		it("blocks shred", () => {
			expect(runGuard("shred /tmp/file")).toBe("block");
		});
	});

	// ===========================================
	// Git rules added from the agentic-engineering-patterns review:
	// amend, single-file discard, clone-into-tree, interactive add.
	// ===========================================
	describe("agentic-engineering-patterns git rules", () => {
		it("hard-blocks git add -i (interactive staging hangs the agent)", () => {
			expect(runGuard("git add -i")).toBe("block");
		});

		it("hard-blocks git add -p", () => {
			expect(runGuard("git add -p")).toBe("block");
		});

		it("allows non-interactive git add", () => {
			expect(runGuard("git add src/foo.ts")).toBe("allow");
		});

		it("flags git commit --amend", () => {
			expect(runGuard("git commit --amend --no-edit")).not.toBe("allow");
		});

		it("allows a normal git commit -m", () => {
			expect(runGuard('git commit -m "fix the bug"')).toBe("allow");
		});

		it("does not flag --amend mentioned inside a quoted commit message", () => {
			expect(runGuard('git commit -m "document the --amend workflow"')).toBe("allow");
		});

		it("flags a single-file git checkout -- <file>", () => {
			expect(runGuard("git checkout -- src/foo.ts")).not.toBe("allow");
		});

		it("allows a plain git checkout <branch> (branch switch)", () => {
			expect(runGuard("git checkout main")).toBe("allow");
		});

		it("flags a single-file git restore <file>", () => {
			expect(runGuard("git restore src/foo.ts")).not.toBe("allow");
		});

		it("allows git restore --staged (index only, non-destructive)", () => {
			expect(runGuard("git restore --staged src/foo.ts")).toBe("allow");
		});

		it("flags git clone into a relative in-tree path", () => {
			expect(runGuard("git clone https://example.com/x/y.git ./reference")).not.toBe(
				"allow",
			);
		});

		it("allows git clone to /tmp", () => {
			expect(runGuard("git clone https://example.com/x/y.git /tmp/reference")).toBe(
				"allow",
			);
		});
	});

	// Cohort git discipline (builtin-rules-cohort.ts): the whole design rests
	// on the solo path paying nothing — every rule dormant at 1 agent, live at
	// 2+ via the active_agent_count_at_least predicate (provider-fed).
	describe("cohort git discipline — dormant solo, live at 2 agents", () => {
		// add -A / commit -a are deliberately NOT here: git-session-scope-gate
		// owns them with per-file ownership (ask), a strictly finer gate.
		const COHORT_GATED = ["git stash", "git stash pop", "git rebase main", "git checkout main"];

		function joinProviderAgents(names: string[]): void {
			const provider = new CohortManager();
			for (const name of names) {
				provider.agentJoined({
					hook_event: "SessionStart",
					session_id: `s-${name}`,
					agent_source: "claude",
					agent_name: name,
					timestamp: new Date().toISOString(),
				});
			}
			setActiveCohort(provider);
		}

		afterEach(() => setActiveCohort(null));

		it("solo agent: every cohort-gated command stays allowed", () => {
			joinProviderAgents(["only-agent"]);
			for (const cmd of COHORT_GATED) {
				expect(runGuard(cmd), `expected solo "${cmd}" to be allowed`).toBe("allow");
			}
		});

		it("two active agents: every cohort-gated command blocks", () => {
			joinProviderAgents(["alpha", "beta"]);
			for (const cmd of COHORT_GATED) {
				expect(runGuard(cmd), `expected cohort "${cmd}" to be blocked`).toBe("block");
			}
		});

		it("two active agents: named-path staging/committing and read-only stash stay allowed", () => {
			joinProviderAgents(["alpha", "beta"]);
			expect(runGuard("git stash list")).toBe("allow");
			expect(runGuard("git checkout -b feature/x")).toBe("allow");
		});
	});
});
