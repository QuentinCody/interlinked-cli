import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePostToolUse, evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

// Deterministic fixtures. Tests don't rely on relative time calculations
// that need real `Date.now()` — they only need a valid timestamp shape.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
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
		last_coordination_ts: FIXED_NOW,
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

describe("evaluatePreToolUse", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	// This suite exercises content checks against real `/tmp/*.ts` file paths
	// with no per-test cwd isolation, so `findProjectRoot` falls back to this
	// repo's own cwd and every write lands in the REAL (gitignored)
	// `.interlinked/obligations.jsonl` ledger — shared across every local test
	// run. Accumulated debt/wander state from prior runs then leaks into
	// unrelated cases here as spurious `transient_debt` blocks. Transient-debt
	// behavior has its own dedicated coverage in
	// `evaluator/transient-debt-guard.test.ts` (nothing in this file exercises
	// it); bypass it here so this suite stays isolated from that shared local
	// state.
	const TRANSIENT_DEBT_BYPASS_ENV = "INTERLINKED_DISABLE_TRANSIENT_DEBT";
	let prevTransientDebtBypass: string | undefined;

	beforeAll(() => {
		prevTransientDebtBypass = process.env[TRANSIENT_DEBT_BYPASS_ENV];
		process.env[TRANSIENT_DEBT_BYPASS_ENV] = "1";
	});

	afterAll(() => {
		if (prevTransientDebtBypass === undefined) delete process.env[TRANSIENT_DEBT_BYPASS_ENV];
		else process.env[TRANSIENT_DEBT_BYPASS_ENV] = prevTransientDebtBypass;
	});

	beforeEach(() => {
		rules = getDefaultConfig();
		// Add built-in rules
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		// This suite exercises non-TDD guards (destructive commands, content
		// checks, reservations, ...). The default config ships
		// `test_first_mode: "enforce"` (which blocks new non-test .ts/.tsx
		// without a companion test); relax it here so these non-TDD tests
		// still assert their intended behaviors. TDD-specific cases live in
		// `evaluator/tdd-new-file-gate.test.ts`.
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	// ===========================================
	// Gate-level allow decisions must not swallow downstream gates
	// ===========================================
	// Found live 2026-07-15: the TDD gate's debt-mode ALLOW (new test-less
	// source file → open coverage debt + allow) was treated as a terminal
	// pipeline decision, so a brand-new file skipped every later gate —
	// line cap, cyclomatic, content checks, auto-reservation, taint.

	describe("gate-level allow does not short-circuit later gates", () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), "interlinked-tddallow-"));
			mkdirSync(join(dir, "src"), { recursive: true });
			mkdirSync(join(dir, ".interlinked"), { recursive: true });
			// Seed a colocated test so the repo profile is NOT layout-"none"
			// (a no-tests-anywhere repo demotes the TDD gate to advisory —
			// repo-profile.ts — which is a different sub-branch than the
			// debt-mode downgrade this regression pins).
			writeFileSync(join(dir, "src", "seed.ts"), "export const seed = 1;\n");
			writeFileSync(join(dir, "src", "seed.test.ts"), 'import "./seed.js";\n');
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		function tddDebtRules(): GuardRulesConfig {
			const r = getDefaultConfig();
			r.rules = loadRules(process.cwd()).rules;
			if (r.structural_checks) r.structural_checks.test_first_mode = "enforce";
			if (r.per_edit_coverage) r.per_edit_coverage.debt_mode = true;
			return r;
		}

		it("TDD debt-mode allow no longer bypasses the per-file line cap", () => {
			const content = Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`).join("\n");
			const event = makeEvent({
				cwd: dir,
				tool_name: "Write",
				tool_input: { file_path: join(dir, "src", "big-new.ts"), content },
			});
			const result = evaluatePreToolUse(event, tddDebtRules(), session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("-line cap");
		});

		it("merges the opened-debt warning instead of clobbering it (small new file)", () => {
			const event = makeEvent({
				cwd: dir,
				tool_name: "Write",
				tool_input: {
					file_path: join(dir, "src", "small-new.ts"),
					content: "export const ok = 1;\n",
				},
			});
			const result = evaluatePreToolUse(event, tddDebtRules(), session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("Opened coverage debt"))).toBe(true);
		});
	});

	// ===========================================
	// Destructive Commands
	// ===========================================

	describe("destructive command blocking", () => {
		it("blocks rm -rf /", () => {
			const event = makeEvent({ tool_input: { command: "rm -rf /" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks rm -rf /usr/local", () => {
			const event = makeEvent({
				tool_input: { command: "rm -rf /usr/local" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows rm -rf /tmp/stuff (exception)", () => {
			const event = makeEvent({
				tool_input: { command: "rm -rf /tmp/stuff" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows `interlinked harness test \"rm -rf /\"` (inspection-wrapper exemption)", () => {
			const event = makeEvent({
				tool_input: { command: 'interlinked harness test "rm -rf /"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("still blocks an inspection wrapper with a chained destructive tail", () => {
			const event = makeEvent({
				tool_input: { command: 'interlinked harness test "x" && rm -rf /' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("does not fire rm -rf rules on a cat-heredoc body (data sink)", () => {
			const event = makeEvent({
				tool_input: { command: "cat <<EOF > notes.md\nwhy rm -rf / is dangerous\nEOF\n" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("does not fire rm -rf rules on a quoted mention (echo)", () => {
			const event = makeEvent({
				tool_input: { command: 'echo "remember: rm -rf / wipes everything"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("still blocks a destructive payload in a bash-heredoc body (executing sink)", () => {
			const event = makeEvent({
				tool_input: { command: "bash <<EOF\nrm -rf /\nEOF\n" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("still blocks rm -rf / inside an inline-exec payload (bash -c)", () => {
			const event = makeEvent({
				tool_input: { command: "bash -c 'rm -rf /'" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("warns on the real publish in a dry-run-then-publish compound (segment-scoped negate)", () => {
			const event = makeEvent({
				tool_input: { command: "npm publish --dry-run\nnpm publish" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			// builtin-npm-publish is warn-only, so the decision stays allow — but
			// the bare `npm publish` segment must still surface its warning even
			// though the leading segment carries --dry-run (the cross-segment
			// negate must not suppress it).
			expect((result.warnings ?? []).some((w) => /publish/i.test(w))).toBe(true);
		});

		it("allows rm -rf dist/ (relative path)", () => {
			const event = makeEvent({
				tool_input: { command: "rm -rf dist/" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks git push --force", () => {
			const event = makeEvent({
				tool_input: { command: "git push --force origin main" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks git push -f", () => {
			const event = makeEvent({
				tool_input: { command: "git push -f origin main" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows git push --force-with-lease", () => {
			const event = makeEvent({
				tool_input: { command: "git push --force-with-lease origin main" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks git reset --hard", () => {
			const event = makeEvent({
				tool_input: { command: "git reset --hard HEAD~3" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks git clean -f", () => {
			const event = makeEvent({
				tool_input: { command: "git clean -fd" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks DROP DATABASE", () => {
			const event = makeEvent({
				tool_input: { command: 'psql -c "DROP DATABASE mydb"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks pkill node", () => {
			const event = makeEvent({
				tool_input: { command: "pkill node" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks pkill wrangler (bare)", () => {
			const event = makeEvent({
				tool_input: { command: "pkill wrangler" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows pkill -f 'wrangler dev' (targeted dev process)", () => {
			const event = makeEvent({
				tool_input: { command: "pkill -f 'wrangler dev'" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows pkill -f 'wrangler tail' (targeted tail process)", () => {
			const event = makeEvent({
				tool_input: { command: 'pkill -f "wrangler tail"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks killall", () => {
			const event = makeEvent({
				tool_input: { command: "killall wrangler" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		// Regression: multi-PID kill rule was matching `kill <pid> 2>&1` because
		// the `2` from the redirect operator looked like a second PID. The fix
		// requires the second token to actually be a PID (not followed by `>`).
		it("allows kill <pid> with stderr redirect (kill 12345 2>&1)", () => {
			const event = makeEvent({
				tool_input: { command: "kill 12345 2>&1" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows kill <pid> followed by an unrelated command", () => {
			const event = makeEvent({
				tool_input: { command: 'kill 69513; echo "kill issued"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("still blocks a real two-PID kill (kill 12345 67890)", () => {
			const event = makeEvent({
				tool_input: { command: "kill 12345 67890" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		// Regression: process-kill rules vs. search-tool arguments.
		// builtin-pgrep-xargs-kill pattern 3 used to treat a bare `awk` in a
		// `ps | grep | awk` pipeline as a kill, and the kill/killall signal
		// rules used to match their verb inside a quoted search argument.
		// A required `xargs kill` + `executed_only` fixed both (commit 055bdfa).
		it("allows a ps|grep|awk inspection pipeline (no xargs kill)", () => {
			const event = makeEvent({
				tool_input: { command: "ps aux | grep claude | awk '{print $11}'" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows grep for the literal 'kill -9' (search-tool argument)", () => {
			const event = makeEvent({
				tool_input: { command: 'grep -rn "kill -9" src/' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows grep for the literal 'killall node' (search-tool argument)", () => {
			const event = makeEvent({
				tool_input: { command: 'grep -rn "killall node" src/' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("still blocks a real ps|grep|xargs kill pipeline", () => {
			const event = makeEvent({
				tool_input: { command: "ps aux | grep node | awk '{print $2}' | xargs kill" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("still blocks kill -9 <pid>", () => {
			const event = makeEvent({ tool_input: { command: "kill -9 1234" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("still blocks a signal kill wrapped in bash -c", () => {
			const event = makeEvent({
				tool_input: { command: 'bash -c "kill -9 1234"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		// Regression: the shutdown/reboot rule used to allow `\s` as a prefix,
		// which matched the literal substring "shutdown" anywhere — including
		// inside echo strings, grep arguments, and source-file paths. Verify
		// it now requires a true command-start anchor.
		it("allows the word 'shutdown' inside an echo argument", () => {
			const event = makeEvent({
				tool_input: { command: 'echo "Graceful shutdown stalled"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows grep with 'shutdown' as a search pattern", () => {
			const event = makeEvent({
				tool_input: { command: "grep -n 'Shutting down' src/server.ts" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("still blocks a real shutdown command", () => {
			const event = makeEvent({
				tool_input: { command: "shutdown -h now" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("still blocks sudo reboot", () => {
			const event = makeEvent({
				tool_input: { command: "sudo reboot" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("still blocks shutdown after a separator (; shutdown -h now)", () => {
			const event = makeEvent({
				tool_input: { command: "echo done; shutdown -h now" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		// Pipelines and newlines are command-start positions in shell. An
		// earlier revision restricted the prefix to ;/&&/|| only, which let
		// `printf x | sudo reboot` and `echo ok\nreboot` pass. Restored.
		it("blocks reboot at the right side of a pipeline (printf x | sudo reboot)", () => {
			const event = makeEvent({
				tool_input: { command: "printf x | sudo reboot" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks reboot after a newline (echo ok\\nreboot)", () => {
			const event = makeEvent({
				tool_input: { command: "echo ok\nreboot" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks shutdown after || (false || shutdown -h now)", () => {
			const event = makeEvent({
				tool_input: { command: "false || shutdown -h now" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		// Wrapped invocations — the second-pass review caught that an
		// anchor-only regex was missing common wrapper forms. Each of these
		// actually executes the destructive verb at runtime.
		it("blocks `env FOO=1 reboot`", () => {
			const event = makeEvent({ tool_input: { command: "env FOO=1 reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks `command reboot` (POSIX command builtin)", () => {
			const event = makeEvent({ tool_input: { command: "command reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks `bash -c reboot`", () => {
			const event = makeEvent({ tool_input: { command: "bash -c reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it('blocks `bash -c "reboot"` (quoted)', () => {
			const event = makeEvent({ tool_input: { command: 'bash -c "reboot"' } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks `nohup reboot`", () => {
			const event = makeEvent({ tool_input: { command: "nohup reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks `exec reboot`", () => {
			const event = makeEvent({ tool_input: { command: "exec reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks combined wrappers (`sudo bash -c reboot`)", () => {
			const event = makeEvent({ tool_input: { command: "sudo bash -c reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks `env A=1 B=2 sudo reboot`", () => {
			const event = makeEvent({ tool_input: { command: "env A=1 B=2 sudo reboot" } });
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks sudo rm", () => {
			const event = makeEvent({
				tool_input: { command: "sudo rm /etc/important" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks chmod -R 777", () => {
			const event = makeEvent({
				tool_input: { command: "chmod -R 777 /var/www" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks rm .wrangler", () => {
			const event = makeEvent({
				tool_input: { command: "rm -rf .wrangler" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler delete (Worker)", () => {
			const event = makeEvent({
				tool_input: { command: "npx wrangler delete my-worker" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler kv namespace delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler kv namespace delete --namespace-id abc123" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler d1 execute with DROP", () => {
			const event = makeEvent({
				tool_input: {
					command: 'wrangler d1 execute my-db --command="DROP TABLE users"',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks vercel rm", () => {
			const event = makeEvent({
				tool_input: { command: "vercel rm my-deployment" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks vercel project rm", () => {
			const event = makeEvent({
				tool_input: { command: "vercel project rm my-project" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows wrangler deploy (non-destructive)", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler deploy" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows vercel deploy (non-destructive)", () => {
			const event = makeEvent({
				tool_input: { command: "vercel deploy" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks wrangler workflows delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler workflows delete my-workflow" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler hyperdrive delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler hyperdrive delete my-config" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler dispatch-namespace delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler dispatch-namespace delete my-ns" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler mtls-certificate delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler mtls-certificate delete --id abc" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks wrangler pages deployment delete", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler pages deployment delete my-id" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("warns on wrangler deploy --env production", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler deploy --env production" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("production"))).toBe(true);
		});

		it("does NOT warn on wrangler deploy --env staging", () => {
			const event = makeEvent({
				tool_input: { command: "wrangler deploy --env staging" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("production"))).toBeFalsy();
		});

		it("blocks cf zones delete", () => {
			const event = makeEvent({
				tool_input: { command: "cf zones delete --zone-id abc123" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks cf registrar domain delete", () => {
			const event = makeEvent({
				tool_input: { command: "cf registrar domain delete example.com" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks cf accounts members delete", () => {
			const event = makeEvent({
				tool_input: { command: "cf accounts members delete --id abc" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows cf zones list (non-destructive)", () => {
			const event = makeEvent({
				tool_input: { command: "cf zones list" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("warns on cf dns records delete", () => {
			const event = makeEvent({
				tool_input: { command: "cf dns records delete --id rec123" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("DNS"))).toBe(true);
		});

		it("allows cf dns records list (non-destructive)", () => {
			const event = makeEvent({
				tool_input: { command: "cf dns records list" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("does not double-fire on `interlinked harness test \"<destructive>\"` wrapper (#16)", () => {
			const event = makeEvent({
				tool_input: { command: 'interlinked harness test "cf dns records delete --id abc"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			// The wrapper's outer evaluation must NOT fire the inner cf-dns rule.
			expect(result.warnings?.some((w) => w.includes("DNS"))).toBeFalsy();
		});

		it("skip applies to harness-test wrapper even with block-tier inner commands", () => {
			const event = makeEvent({
				tool_input: { command: 'interlinked harness test "wrangler delete my-worker"' },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("does NOT skip `interlinked harness restart` or other non-test subcommands", () => {
			// `restart` is not `test` — should NOT short-circuit, though no rule fires on
			// the bare restart command itself so that verdict alone is still allow.
			const bareEvent = makeEvent({
				tool_input: { command: "interlinked harness restart" },
			});
			const bareResult = evaluatePreToolUse(bareEvent, rules, session, reservations, cohort);
			expect(bareResult.decision).toBe("allow");

			// Prove the prefix match is exact on `test`, not any `harness`-prefixed
			// subcommand: wrapping a block-tier command in `harness restart "..."`
			// must still block — the inspection-wrapper exemption must NOT apply to
			// `restart`, unlike `test` (see the wrapper test above).
			const wrappedEvent = makeEvent({
				tool_input: { command: 'interlinked harness restart "wrangler delete my-worker"' },
			});
			const wrappedResult = evaluatePreToolUse(wrappedEvent, rules, session, reservations, cohort);
			expect(wrappedResult.decision).toBe("block");
			expect(wrappedResult.reason).toContain("irreversible");
		});
	});

	// ===========================================
	// Protected Files
	// ===========================================

	describe("lock file and binary guards", () => {
		it("blocks editing package-lock.json", () => {
			const event = makeEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "package-lock.json",
					old_string: '"version": "1.0.0"',
					new_string: '"version": "2.0.0"',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Lock files");
		});

		it("blocks writing to yarn.lock", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "yarn.lock", content: "# yarn lockfile" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks writing to binary files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "logo.png", content: "not a real png" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("binary");
		});

		it("allows writing to normal code files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	describe("sensitive file read blocking", () => {
		it("blocks reading .env", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("secrets");
		});

		it("blocks reading .env.local", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/project/.env.local" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("allows reading .env.example", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: ".env.example" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading credentials.json", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "credentials.json" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});

		it("blocks reading .pem files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
		});
	});

	describe("protected files", () => {
		it("blocks writing secrets to .env files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					// Reason: test fixture — a deliberately fake GH token
					// pattern used to exercise the secret-detection rule.
					// nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
					content: "API_KEY=ghp_1234567890abcdef1234567890abcdef1234",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Secrets");
		});

		it("allows writing to .env without secrets", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: ".env",
					content: "NODE_ENV=production\nPORT=3000",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("blocks reading private key files", () => {
			const event = makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "certs/server.pem" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Private key");
		});
	});

	// ===========================================
	// Curl-to-MCP Detection
	// ===========================================

	describe("curl-to-MCP detection", () => {
		it("warns on curl to an /mcp path on a configured port", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/mcp" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.some((w) => w.includes("localhost"))).toBe(true);
		});

		it("does NOT warn on curl to a non-MCP path (e.g. /health) — #21 FP", () => {
			// :8787 is the wrangler dev port for our own cloud governor; curling
			// /health or /governor/evaluate is normal dev work, not a dropped MCP.
			const healthEvent = makeEvent({
				tool_input: { command: "curl http://localhost:8787/health" },
			});
			const healthResult = evaluatePreToolUse(healthEvent, rules, session, reservations, cohort);
			expect(healthResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();
			expect(healthResult.warnings?.some((w) => w.includes("MCP server"))).toBeFalsy();

			const governorEvent = makeEvent({
				tool_input: { command: "curl -X POST http://localhost:8787/governor/evaluate" },
			});
			const govResult = evaluatePreToolUse(governorEvent, rules, session, reservations, cohort);
			expect(govResult.warnings?.some((w) => w.includes("disconnected"))).toBeFalsy();
		});

		it("warns (not blocks) after configured threshold on an /mcp path", () => {
			// Simulate 4 prior curl calls to same port
			for (let i = 0; i < 4; i++) {
				session.curl_localhost_count[8787] = i + 1;
			}

			const event = makeEvent({
				tool_input: { command: "curl http://localhost:8787/mcp/messages" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings).toBeDefined();
			expect(result.warnings?.some((w) => w.includes("disconnected"))).toBe(true);
		});

		it("warns on /sse path (MCP transport) too", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:3000/sse" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("localhost"))).toBe(true);
		});

		it("does not fire port-keyed curl-mcp detection for non-configured ports", () => {
			const event = makeEvent({
				tool_input: { command: "curl http://localhost:9999/mcp" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			// The generic /mcp-route guard ("use MCP tools, not curl") still fires
			// on any /mcp curl, but the port-keyed disconnection detector must NOT —
			// 9999 isn't a configured port.
			expect(
				result.warnings?.some((w) => w.includes("disconnected") || w.includes("9999")),
			).toBeFalsy();
		});
	});

	// ===========================================
	// Auto File Reservation
	// ===========================================

	describe("auto file reservation", () => {
		it("allows first write to unreserved file", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("allows same agent to write again to reserved file", () => {
			// First write creates reservation
			const event1 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "hello" },
			});
			evaluatePreToolUse(event1, rules, session, reservations, cohort);

			// Second write by same agent (use Write, not Edit, to avoid old_string check)
			const event2 = makeEvent({
				tool_name: "Write",
				tool_input: { file_path: "test-nonexistent/foo.ts", content: "world" },
			});
			const result = evaluatePreToolUse(event2, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});
	});

	// ===========================================
	// Safe Commands (Should ALL Allow)
	// ===========================================

	describe("safe commands", () => {
		// `cat package.json` IS on this list since the file-dump cap rose to
		// 200 lines (2026-07-24) — a typical ~100-line package.json now passes;
		// genuinely large files are still refused by the 100KB size gate and
		// the 200-line cap (`evaluator/file-dump-guard.ts`).
		//
		// `npm install` is also NOT here. The supply-chain guard
		// (`evaluator/package-install-guard.ts`) blocks bare `npm install`
		// until a lockfile snapshot is approved via `interlinked allowlist
		// snapshot`. Coverage for the supply-chain gate lives in
		// `evaluator/package-install-guard.test.ts`.
		const safeCommands = [
			"ls -la",
			"npm run test",
			"git status",
			"git add .",
			"git commit -m 'test'",
			"git push origin main",
			"head -n 5 package.json",
			"echo hello",
			"node --version",
			"npx vitest run",
			"curl https://api.example.com",
		];

		for (const cmd of safeCommands) {
			it(`allows: ${cmd}`, () => {
				const event = makeEvent({ tool_input: { command: cmd } });
				const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
				expect(result.decision).toBe("allow");
			});
		}
	});

	// ===========================================
	// A-series: PreToolUse Content Checks
	// ===========================================

	describe("A-series content checks", () => {
		it("A1: blocks merge conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content:
						"const x = 1;\n<<<<<<< HEAD\nconst y = 2;\n=======\nconst y = 3;\n>>>>>>> branch\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("Merge conflict");
		});

		it("A1: allows files without conflict markers", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const x = 1;\nconst y = 2;\n",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
		});

		it("A2: blocks on eval() (pre_block registry phase)", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: "const result = eval(userInput);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("block");
			expect(result.rule_id).toBe("eval_usage");
			expect(result.reason).toContain("eval_usage");
			// Introduced-only semantics (pre-block-gate.ts): a new file has no
			// baseline, so the finding is INTRODUCED; the message names the
			// auditable per-line escape instead of "fix ALL instances".
			expect(result.reason).toContain("INTRODUCES");
			expect(result.reason).toContain("interlinked-ignore: eval_usage");
		});

		it("A6: warns on mixed import/require", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.ts",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("Mixed import/require"))).toBe(true);
		});

		it("A6: skips mixed import/require for .cjs files", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/test.cjs",
					content: 'import { foo } from "./foo";\nconst bar = require("./bar");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			const hasWarning = result.warnings?.some((w) => w.includes("Mixed import/require"));
			expect(hasWarning).toBeFalsy();
		});

		it("A8: warns on SQL injection patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/query.ts",
					content: "db.exec(`SELECT * FROM users WHERE id = $" + "{userId}`);",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("SQL injection"))).toBe(true);
		});

		it("A9: warns on wildcard CORS", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/server.ts",
					content: 'res.setHeader("Access-Control-Allow-Origin", "*");',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("CORS"))).toBe(true);
		});

		it("A10: warns on regex DoS patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/validator.ts",
					content: "const re = /(a+)+$/;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("ReDoS"))).toBe(true);
		});

		it("A11: warns on JSDoc containing premature */ from glob patterns", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					// A premature `**/` JSDoc close always orphans the rest of the
					// line as invalid syntax (that's the defect A11 exists to
					// catch), so on a `.ts` path this also trips a REAL
					// tsc-diff-overlay syntax-error block (2e7ec85 made the tsc
					// overlay run for new files instead of short-circuiting to
					// empty). Use `.js`: content-quality's A11 regex still scans
					// it (JS_TS_EXTENSIONS includes `.js`), but tsc-diff-overlay's
					// narrower TS_OVERLAY_EXT (ts/tsx/mts/cts only) skips it, so
					// the case isolates the A11 warning path as originally
					// intended.
					file_path: "/tmp/types.js",
					content: '/** Glob pattern (uses "dir/**", "**/*.ext") */\nglob: 1;',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("closed early"))).toBe(true);
		});

		it("A11: does not warn on normal JSDoc comments", () => {
			const event = makeEvent({
				tool_name: "Write",
				tool_input: {
					file_path: "/tmp/types.ts",
					content: "/** This is a normal JSDoc comment */\nexport const x = 1;",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("closed early"))).toBeFalsy();
		});
	});

	// ===========================================
	// Markdown-first web fetching
	// ===========================================

	describe("markdown-first web fetching", () => {
		it("warns on Playwright browser_navigate", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: { url: "https://example.com/docs" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
			expect(result.warnings?.some((w) => w.includes("Accept: text/markdown"))).toBe(true);
		});

		it("warns on Chrome DevTools navigate_page", () => {
			const event = makeEvent({
				tool_name: "mcp__chrome-devtools__navigate_page",
				tool_input: { url: "https://blog.cloudflare.com/some-post/" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn on browser navigate without URL", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_navigate",
				tool_input: {},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on non-navigation browser tools", () => {
			const event = makeEvent({
				tool_name: "mcp__playwright__browser_click",
				tool_input: { selector: "#btn" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("warns on curl without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl -sS https://docs.example.com/api-reference" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.decision).toBe("allow");
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("warns on wget without Accept: text/markdown", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "wget https://example.com/page.html" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBe(true);
		});

		it("does not warn when Accept: text/markdown is present", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl -sS -H "Accept: text/markdown" https://example.com/page',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl to localhost", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: { command: "curl http://localhost:8787/api/status" },
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on POST requests", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -X POST https://api.example.com/data",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with --data (API call)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: 'curl --data \'{"key":"val"}\' https://api.example.com/endpoint',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with -o (binary download)", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command: "curl -o output.tar.gz https://releases.example.com/v1.0.tar.gz",
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});

		it("does not warn on curl with JSON content type", () => {
			const event = makeEvent({
				tool_name: "Bash",
				tool_input: {
					command:
						'curl -H "Content-Type: application/json" https://api.example.com/graphql',
				},
			});
			const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
			expect(result.warnings?.some((w) => w.includes("markdown-first"))).toBeFalsy();
		});
	});
});

describe("evaluatePostToolUse — file reminders", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;

	beforeEach(() => {
		rules = getDefaultConfig();
		rules.file_reminders = [
			{
				glob: "servers/loinc/**",
				message: "Set LOINC_USERNAME/PASSWORD via wrangler secret put",
			},
			{
				glob: "src/schema.ts",
				operations: ["Edit"],
				message: "Run npm run test:schema after schema changes",
				once_per_session: false,
			},
		];
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	it("fires reminder when file matches glob", () => {
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "servers/loinc/worker.ts" },
		});
		const result = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(
			result.warnings?.some(
				(w) => w.includes("[interlinked:reminder]") && w.includes("LOINC_USERNAME"),
			),
		).toBe(true);
	});

	it("deduplicates once_per_session reminders", () => {
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "servers/loinc/worker.ts" },
		});
		evaluatePostToolUse(event, rules, session, reservations, cohort);
		const result2 = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(result2.warnings?.some((w) => w.includes("LOINC_USERNAME"))).toBeFalsy();
	});

	it("fires every time when once_per_session is false", () => {
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "src/schema.ts", old_string: "a", new_string: "b" },
		});
		const r1 = evaluatePostToolUse(event, rules, session, reservations, cohort);
		const r2 = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(r1.warnings?.some((w) => w.includes("test:schema"))).toBe(true);
		expect(r2.warnings?.some((w) => w.includes("test:schema"))).toBe(true);
	});

	it("skips reminder when operation does not match", () => {
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "src/schema.ts" },
		});
		const result = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(result.warnings?.some((w) => w.includes("test:schema"))).toBeFalsy();
	});

	it("does not fire for non-matching files", () => {
		const event = makeEvent({
			hook_event: "PostToolUse",
			tool_name: "Read",
			tool_input: { file_path: "src/index.ts" },
		});
		const result = evaluatePostToolUse(event, rules, session, reservations, cohort);
		expect(result.warnings?.some((w) => w.includes("[interlinked:reminder]"))).toBeFalsy();
	});
});
