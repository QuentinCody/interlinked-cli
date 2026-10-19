// ===========================================
// Plan 02 — Destructive Command Guard Rules (v1) tests
// ===========================================
//
// Verifies the 10 DCG-port rules in `rules/builtin-rules-extras.ts` —
// each exercised through `evaluatePreToolUse()` rather than against the
// raw rule object so we cover keyword-quick-reject, rule-iteration order,
// and the action→decision mapping (block / ask) end-to-end.
//
// Test plan per Plan 02 §"Test plan":
//   1. Positive — canonical command shape fires the rule
//   2. FP guard — similar shape that should NOT fire
//   3. Wrapped — `sudo` prefix; positive when the regex tolerates
//      anchor-free wrapper text (current evaluator does NOT apply
//      wrapper-normalization globally)
//   4. Quoted — pattern inside `echo '…'` (allowed with a warning since
//      the 2026-10-08 literal-context gate, `evaluator/literal-context.ts`)
//   5. Commented — pattern after `#` (matches today; will require
//      span-gate to suppress in Phase 2)
//
// 5 cases × 10 rules = 50 assertions.
//
// The U4 section at the end (2026-10-09) adds labeled positive / negative
// cases for builtin-file-truncate, builtin-chmod-000 and
// builtin-chown-recursive (rules in builtin-rules-processes-git-fs-inline.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CohortManager } from "../cohort.js";
import { evaluatePreToolUse } from "../evaluator.js";
import { ReservationManager } from "../reservations.js";
import { getDefaultConfig, loadRules } from "../rules-loader.js";
import type { GuardRulesConfig, HarnessEvent, SessionTrajectory } from "../types.js";

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

describe("Plan 02 — destructive command rules (v1)", () => {
	let rules: GuardRulesConfig;
	let cohort: CohortManager;
	let reservations: ReservationManager;
	let session: SessionTrajectory;
	const fixtures: string[] = [];
	afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

	beforeEach(() => {
		rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		if (rules.structural_checks) rules.structural_checks.test_first_mode = "warn";
		cohort = new CohortManager();
		reservations = new ReservationManager();
		session = makeSession();
	});

	function decide(command: string): { decision: string; rule_id?: string | undefined } {
		const event = makeEvent({ tool_input: { command } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		return { decision: String(result.decision), rule_id: result.rule_id };
	}

	// ===========================================
	// 1. builtin-kubectl-delete-namespace
	// ===========================================
	describe("builtin-kubectl-delete-namespace", () => {
		it("positive: fires on `kubectl delete namespace foo`", () => {
			const r = decide("kubectl delete namespace foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl get namespace`", () => {
			const r = decide("kubectl get namespace foo");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete ns foo`", () => {
			// Word-boundary regex tolerates the `sudo ` prefix.
			const r = decide("sudo kubectl delete ns foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: an echo argument with no downstream is data — the literal-context gate degrades the legacy match to a warning", () => {
			const r = decide("echo 'kubectl delete namespace foo'");
			expect(r.decision).toBe("allow");
		});

		it("commented: fires after `#` because `kubectl` is a clean token (Phase 2 span gate would suppress)", () => {
			const r = decide("ls # kubectl delete namespace foo");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 2. builtin-kubectl-delete-all
	// ===========================================
	describe("builtin-kubectl-delete-all", () => {
		it("positive: fires on `kubectl delete deployments --all`", () => {
			const r = decide("kubectl delete deployments --all");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl delete pod --all` (negative-lookahead permits `pod\\b`)", () => {
			// Per Plan 02 §2.2: negative lookahead `(?!...|pod\b)` is meant
			// to permit `pods --all` for scratch-namespace dev workflows.
			// In practice the verbatim regex only permits the singular
			// form `pod` (because `pod\b` doesn't match `pods` — `s` is
			// a word char). Phase 2 should change to `pods?\b`. For now
			// we test the form the regex actually permits.
			const r = decide("kubectl delete pod --all -n my-scratch");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete deployments --all`", () => {
			const r = decide("sudo kubectl delete deployments --all");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted (Phase 2 wired): `executed_only` masks single-quoted content, so the rule does not fire on `echo 'kubectl delete deployments --all'`", () => {
			const r = decide("echo 'kubectl delete deployments --all'");
			expect(r.decision).toBe("allow");
		});

		it("commented (Phase 2 wired): `executed_only` masks `# ...` comments, so the rule does not fire on `ls # kubectl delete deployments --all`", () => {
			const r = decide("ls # kubectl delete deployments --all");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 3. builtin-kubectl-delete-pvc
	// ===========================================
	describe("builtin-kubectl-delete-pvc", () => {
		it("positive: fires on `kubectl delete pvc my-claim`", () => {
			const r = decide("kubectl delete pvc my-claim");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `kubectl get pvc`", () => {
			const r = decide("kubectl get pvc my-claim");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo kubectl delete pvc my-claim`", () => {
			const r = decide("sudo kubectl delete pvc my-claim");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted (Phase 2 wired): `executed_only` masks single-quoted content, so the rule does not fire on `echo 'kubectl delete pvc my-claim'`", () => {
			const r = decide("echo 'kubectl delete pvc my-claim'");
			expect(r.decision).toBe("allow");
		});

		it("commented (Phase 2 wired): `executed_only` masks `# ...` comments, so the rule does not fire on `ls # kubectl delete pvc my-claim`", () => {
			const r = decide("ls # kubectl delete pvc my-claim");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 4. builtin-docker-system-prune (action: ask)
	// ===========================================
	describe("builtin-docker-system-prune", () => {
		it("positive: fires on `docker system prune`", () => {
			// Note: existing `builtin-docker-prune` (block) fires first
			// because DATABASE_AND_CLOUD_RULES precedes our new file in
			// the BUILTIN_RULES order. Either rule means the agent is
			// stopped — both decisions count as "fired".
			const r = decide("docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP/edge: `docker system prune --dry-run` — our regex skips it via negative lookahead but legacy rule still blocks", () => {
			// Plan 02 §2.4 negative lookahead `(?!.*--dry-run)`. The
			// existing `builtin-docker-prune` rule does NOT have this
			// exception, so the legacy block rule wins today. Either
			// decision is acceptable; both are agent-safe outcomes.
			const r = decide("docker system prune --dry-run");
			expect(["block", "ask", "allow"]).toContain(r.decision);
		});

		it("wrapped: fires on `sudo docker system prune`", () => {
			const r = decide("sudo docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: an echo argument with no downstream is data — the literal-context gate degrades the match to a warning", () => {
			const r = decide("echo 'docker system prune'");
			expect(r.decision).toBe("allow");
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # docker system prune");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 5. builtin-docker-volume-prune
	// ===========================================
	describe("builtin-docker-volume-prune", () => {
		it("positive: fires on `docker volume prune`", () => {
			const r = decide("docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `docker volume ls`", () => {
			const r = decide("docker volume ls");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo docker volume prune`", () => {
			const r = decide("sudo docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: an echo argument with no downstream is data — the literal-context gate degrades the match to a warning", () => {
			const r = decide("echo 'docker volume prune'");
			expect(r.decision).toBe("allow");
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # docker volume prune");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 6. builtin-git-stash-drop-or-clear
	// ===========================================
	describe("builtin-git-stash-drop-or-clear", () => {
		it("positive: fires on `git stash drop`", () => {
			const r = decide("git stash drop");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `git stash list`", () => {
			const r = decide("git stash list");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo git stash clear`", () => {
			const r = decide("sudo git stash clear");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: an echo argument with no downstream is data — the literal-context gate degrades the match to a warning", () => {
			const r = decide("echo 'git stash drop'");
			expect(r.decision).toBe("allow");
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # git stash drop");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// 7. builtin-git-rebase-interactive (action: ask)
	// ===========================================
	// Known spec issue: Plan 02 §2.7 regex `\b(-i|--interactive)\b` does
	// NOT fire on `-i` / `--interactive` flags because `\b` between space
	// and `-` is not a word boundary in JavaScript regex semantics. The
	// regex is copied verbatim per Plan 02 instructions; the rule
	// therefore never fires today and these tests record that ground
	// truth. Phase 2 must drop the leading `\b` to fix.
	describe("builtin-git-rebase-interactive", () => {
		it("positive: rule does not fire today (Plan 02 §2.7 regex `\\b-i\\b` cannot match — `\\b` between space and `-` is not a word boundary)", () => {
			const r = decide("git rebase -i HEAD~3");
			expect(r.decision).toBe("allow");
		});

		it("FP guard: allows non-interactive `git rebase main`", () => {
			const r = decide("git rebase main");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: `sudo git rebase --interactive` likewise does not fire (same regex bug)", () => {
			const r = decide("sudo git rebase --interactive HEAD~3");
			expect(r.decision).toBe("allow");
		});

		it("quoted: regex bug + `'git` token mismatch from keyword-quick-reject — does not fire today", () => {
			const r = decide("echo 'git rebase -i HEAD~3'");
			expect(r.decision).toBe("allow");
		});

		it("commented: regex bug means rule does not fire even when `git` token is present", () => {
			const r = decide("ls # git rebase -i HEAD~3");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 8. builtin-terraform-state-rm
	// ===========================================
	describe("builtin-terraform-state-rm", () => {
		it("positive: fires on `terraform state rm aws_instance.foo`", () => {
			const r = decide("terraform state rm aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `terraform state list`", () => {
			const r = decide("terraform state list");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo terraform state rm aws_instance.foo`", () => {
			const r = decide("sudo terraform state rm aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted (Phase 2 wired): `executed_only` masks single-quoted content, so the rule does not fire on `echo 'terraform state rm ...'`", () => {
			const r = decide("echo 'terraform state rm aws_instance.foo'");
			expect(r.decision).toBe("allow");
		});

		it("commented (Phase 2 wired): `executed_only` masks `# ...` comments, so the rule does not fire on `ls # terraform state rm ...`", () => {
			const r = decide("ls # terraform state rm aws_instance.foo");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 9. builtin-terraform-taint (action: ask)
	// ===========================================
	describe("builtin-terraform-taint", () => {
		it("positive: fires on `terraform taint aws_instance.foo`", () => {
			const r = decide("terraform taint aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `terraform plan`", () => {
			const r = decide("terraform plan");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo terraform taint aws_instance.foo`", () => {
			const r = decide("sudo terraform taint aws_instance.foo");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted (Phase 2 wired): `executed_only` masks single-quoted content, so the rule does not fire on `echo 'terraform taint ...'`", () => {
			const r = decide("echo 'terraform taint aws_instance.foo'");
			expect(r.decision).toBe("allow");
		});

		it("commented (Phase 2 wired): `executed_only` masks `# ...` comments, so the rule does not fire on `ls # terraform taint ...`", () => {
			const r = decide("ls # terraform taint aws_instance.foo");
			expect(r.decision).toBe("allow");
		});
	});

	// ===========================================
	// 10. builtin-helm-uninstall-prod
	// ===========================================
	describe("builtin-helm-uninstall-prod", () => {
		it("positive: fires on `helm uninstall my-release --namespace prod`", () => {
			const r = decide("helm uninstall my-release --namespace prod");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("FP guard: allows `helm list -n prod`", () => {
			const r = decide("helm list -n prod");
			expect(r.decision).toBe("allow");
		});

		it("wrapped: fires on `sudo helm uninstall my-release -n production`", () => {
			const r = decide("sudo helm uninstall my-release -n production");
			expect(["block", "ask"]).toContain(r.decision);
		});

		it("quoted: an echo argument with no downstream is data — the literal-context gate degrades the match to a warning", () => {
			const r = decide("echo 'helm uninstall my-release --namespace prod'");
			expect(r.decision).toBe("allow");
		});

		it("commented: fires after `#` (matches today; will require span gate to suppress in Phase 2)", () => {
			const r = decide("ls # helm uninstall my-release --namespace prod");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// Phase 2 projection wiring — cross-cutting
	// ===========================================
	// Plan 01 §1.2 `executed_only` opt-in is enabled on every Plan 02 rule.
	// These cases exercise the projection directly: each rule's match
	// should still fire on a raw or wrapper-prefixed command, and should
	// suppress on quoted/commented forms regardless of whether some other
	// rule happens to catch the same input.
	describe("Plan 02 — Phase 2 projection (executed_only) cross-cutting", () => {
		const cases: Array<{ name: string; positive: string; quoted: string; commented: string; expectedRuleId: string }> = [
			{
				name: "kubectl-delete-namespace",
				positive: "kubectl delete namespace customer-data",
				quoted: "echo 'kubectl delete namespace customer-data'",
				commented: "ls # kubectl delete namespace customer-data",
				expectedRuleId: "builtin-kubectl-delete-namespace",
			},
			{
				name: "kubectl-delete-pvc",
				positive: "kubectl delete pvc data-claim",
				quoted: "echo 'kubectl delete pvc data-claim'",
				commented: "ls # kubectl delete pvc data-claim",
				expectedRuleId: "builtin-kubectl-delete-pvc",
			},
			{
				name: "git-stash-drop",
				positive: "git stash drop stash@{2}",
				quoted: "echo 'git stash drop stash@{2}'",
				commented: "ls # git stash drop stash@{2}",
				expectedRuleId: "builtin-git-stash-drop-or-clear",
			},
			{
				name: "terraform-state-rm",
				positive: "terraform state rm aws_instance.live_db",
				quoted: "echo 'terraform state rm aws_instance.live_db'",
				commented: "ls # terraform state rm aws_instance.live_db",
				expectedRuleId: "builtin-terraform-state-rm",
			},
		];

		for (const c of cases) {
			// Positive: pre-existing catch-all rules
			// (`builtin-kubectl-mass-delete`, `builtin-git-stash-destroy`)
			// often win rule iteration before the Plan-02 entry; either
			// way the agent is stopped, which is the real safety
			// guarantee. We assert decision-shape only, not rule-id.
			it(`${c.name}: positive command yields block/ask (some rule fires)`, () => {
				const r = decide(c.positive);
				expect(["block", "ask"]).toContain(r.decision);
			});

			it(`${c.name}: Plan-02 rule itself does NOT fire on single-quoted content`, () => {
				const r = decide(c.quoted);
				expect(r.rule_id).not.toBe(c.expectedRuleId);
			});

			it(`${c.name}: Plan-02 rule itself does NOT fire on commented content`, () => {
				const r = decide(c.commented);
				expect(r.rule_id).not.toBe(c.expectedRuleId);
			});
		}

		it("wrapper-normalize is a no-op for these rules: `sudo kubectl delete namespace x` still yields block/ask", () => {
			// Plan-02 regexes are anchor-free, so `\bkubectl\b` matches
			// regardless of a leading `sudo`. `strip_wrappers` is reserved
			// for future rules that anchor at start.
			const r = decide("sudo kubectl delete namespace customer-data");
			expect(["block", "ask"]).toContain(r.decision);
		});
	});

	// ===========================================
	// U4 (2026-10-09): file truncation, chmod 000, chown -R — the verb
	// families the E29c composed corpus showed no rule covered. Rules live in
	// rules/builtin-rules-processes-git-fs-inline.ts. A positive asserts THIS
	// rule's id (not just "something stopped it"); a negative asserts this rule
	// stayed silent AND the call was allowed.
	// ===========================================
	function expectFires(ruleId: string, command: string): void {
		const r = decide(command);
		expect(r.decision).toBe("block");
		expect(r.rule_id).toBe(ruleId);
	}

	function expectSilent(ruleId: string, command: string): void {
		const r = decide(command);
		expect(r.rule_id).not.toBe(ruleId);
		expect(r.decision).toBe("allow");
	}

	function literalWarnings(command: string): string[] {
		const event = makeEvent({ tool_input: { command } });
		const result = evaluatePreToolUse(event, rules, session, reservations, cohort);
		return (result.warnings ?? []).filter((w) => w.includes("matched inside a string literal"));
	}

	describe("builtin-file-truncate — positive (must fire)", () => {
		const id = "builtin-file-truncate";
		it("P1: truncate -s 0 on a lockfile", () => expectFires(id, "truncate -s 0 package-lock.json"));
		it("P2: --size=0 after the operand (GNU permutes options)", () => expectFires(id, "truncate src/app.ts --size=0"));
		it("P3: `: > file` as a whole command", () => expectFires(id, ": > .env"));
		it("P4: cp /dev/null after a benign chained command", () =>
			expectFires(id, "echo starting && cp /dev/null src/config.json"));
		it("P5: a bare `> file` with no producing command", () => expectFires(id, "> data/users.json"));
		it("P6: inside a heredoc fed to bash (executed, so scanned)", () =>
			expectFires(id, "bash <<'EOF'\n: > src/config.json\nEOF"));
		it("P7: a `..` segment voids the scratch carve-out", () => expectFires(id, "truncate -s 0 scratch/../src/app.ts"));
		it("P8: case-variant verb (macOS resolves TRUNCATE to truncate)", () => expectFires(id, "TRUNCATE -s 0 src/app.ts"));
		it("P9: cat /dev/null into a shell history file", () => expectFires(id, "cat /dev/null > ~/.bash_history"));
	});

	describe("builtin-file-truncate — negative (must not fire)", () => {
		const id = "builtin-file-truncate";
		it("N1: target under scratch/ (carve-out)", () => expectSilent(id, "truncate -s 0 scratch/run.log"));
		it("N2: target under /tmp (carve-out)", () => expectSilent(id, ": > /tmp/out.txt"));
		it("N3: truncate --help", () => expectSilent(id, "truncate --help"));
		it("N4: a non-zero size grows or creates a file", () => expectSilent(id, "truncate -s 10M disk.img"));
		it("N5: `>>` appends, it does not truncate", () => expectSilent(id, ": >> notes/log.txt"));
		it("N6: a redirect with a producing command", () => expectSilent(id, "echo hi > notes.txt"));
		it("N7: a variable-led target is unknown, never blocked", () => expectSilent(id, ": > $OUT/report.txt"));
		it("N8: a comment is masked by executed_only, not degraded by the literal gate", () => {
			expectSilent(id, "# truncate -s 0 src/app.ts");
			expect(literalWarnings("# truncate -s 0 src/app.ts")).toEqual([]);
		});
		it("N9: a quoted commit message is masked", () => expectSilent(id, 'git commit -m "stop using : > src/app.ts"'));
		it("N10: a heredoc body fed to cat is data", () =>
			expectSilent(id, "cat > notes.md <<'EOF'\ntruncate -s 0 src/app.ts\nEOF"));
		it("N11: an unquoted echo argument matches but the literal gate downgrades it to a warning", () => {
			expectSilent(id, "echo truncate -s 0 src/app.ts");
			expect(literalWarnings("echo truncate -s 0 src/app.ts")).toHaveLength(1);
		});
	});

	describe("builtin-chmod-000 — positive (must fire)", () => {
		const id = "builtin-chmod-000";
		it("P1: chmod -R 000 on a source tree", () => expectFires(id, "chmod -R 000 src"));
		it("P2: -R after the mode (any argument order)", () => expectFires(id, "chmod 000 -R src"));
		it("P3: symbolic a-rwx under sudo", () => expectFires(id, "sudo chmod -R a-rwx /usr/local"));
		it("P4: chmod 000 on the current directory (no -R)", () => expectFires(id, "chmod 000 ."));
		it("P5: 0000 on a path ending in /", () => expectFires(id, "chmod 0000 src/"));
		it("P6: case-variant verb", () => expectFires(id, "CHMOD -R 000 src"));
	});

	describe("builtin-chmod-000 — negative (must not fire)", () => {
		const id = "builtin-chmod-000";
		it("N1: target under /tmp (carve-out)", () => expectSilent(id, "chmod -R 000 /tmp/fixtures/locked"));
		it("N2: one file without -R (an unreadable test fixture)", () =>
			expectSilent(id, "chmod 000 test/fixtures/unreadable.txt"));
		it("N3: another numeric mode", () => expectSilent(id, "chmod -R 755 src"));
		it("N4: a restrictive mode that is not 000", () => expectSilent(id, "chmod -R go-rwx src"));
		it("N5: a comment is masked by executed_only, not degraded by the literal gate", () => {
			expectSilent(id, "# chmod -R 000 src");
			expect(literalWarnings("# chmod -R 000 src")).toEqual([]);
		});
		it("N6: a quoted commit message is masked", () => expectSilent(id, 'git commit -m "avoid chmod -R 000 src"'));
		it("N7: an unquoted echo argument is downgraded to a warning by the literal gate", () => {
			expectSilent(id, "echo chmod -R 000 src");
			expect(literalWarnings("echo chmod -R 000 src")).toHaveLength(1);
		});
		it("N8: a heredoc body fed to cat is data", () => expectSilent(id, "cat > notes.md <<'EOF'\nchmod -R 000 src\nEOF"));
	});

	describe("builtin-chown-recursive — positive (must fire)", () => {
		const id = "builtin-chown-recursive";
		it("P1: chown -R root:root on a source tree", () => expectFires(id, "chown -R root:root src"));
		it("P2: a $(whoami) owner under sudo", () =>
			expectFires(id, "sudo chown -R $(whoami) /usr/local/lib/node_modules"));
		it("P3: -R after the operands", () => expectFires(id, "chown root:staff src -R"));
		it("P4: bundled -hR on a home directory", () => expectFires(id, "chown -hR 501:20 ~/.npm"));
		it("P5: inside a bash -c payload (inline code is scanned)", () =>
			expectFires(id, "bash -c 'chown -R root:root /opt/app'"));
	});

	describe("builtin-chown-recursive — negative (must not fire)", () => {
		const id = "builtin-chown-recursive";
		it("N1: target under /tmp (carve-out)", () => expectSilent(id, "chown -R me:staff /tmp/build"));
		it("N2: target under scratch/ (carve-out)", () => expectSilent(id, "chown -R me scratch/cache"));
		it("N3: chown without -R", () => expectSilent(id, "chown me src/app.ts"));
		it("N4: a variable-led target is unknown, never blocked", () => expectSilent(id, "chown -R me $BUILD_DIR"));
		it("N5: a grep pattern", () => expectSilent(id, "rg -n 'chown -R' src"));
		it("N6: a comment", () => expectSilent(id, "# chown -R root:root src"));
		it("N7: an echo string", () => expectSilent(id, "echo 'chown -R root:root src'"));
	});

	describe("U4 rules — positive (must fire, with severity and category)", () => {
		const cases: Array<[string, string, string]> = [
			["builtin-file-truncate", "truncate -s 0 package-lock.json", "filesystem"],
			["builtin-chmod-000", "chmod -R 000 src", "system-operations"],
			["builtin-chown-recursive", "chown -R root:root src", "system-operations"],
		];
		for (const [id, command, category] of cases) {
			it(`P: ${id} blocks as high / ${category}`, () => {
				const result = evaluatePreToolUse(makeEvent({ tool_input: { command } }), rules, session, reservations, cohort);
				expect([result.decision, result.rule_id, result.severity, result.category]).toEqual(["block", id, "high", category]);
			});
		}
	});

	// 2026-10-15 review: every truncate shape also CREATES an empty file when
	// the target is absent. With a cwd the rule consults the filesystem
	// (`nonempty_file_group`); the tests above carry no cwd, so the regex
	// match stands there (fail closed).
	describe("builtin-file-truncate with a cwd — filesystem-gated", () => {
		function fixture(): string {
			const root = mkdtempSync(join(tmpdir(), "truncate-rule-"));
			fixtures.push(root);
			writeFileSync(join(root, "full.txt"), "contents\n");
			writeFileSync(join(root, "empty.txt"), "");
			mkdirSync(join(root, "sub"));
			writeFileSync(join(root, "sub", "full.txt"), "x");
			return root;
		}
		function decideIn(cwd: string, command: string): { decision: string; rule_id?: string | undefined } {
			const result = evaluatePreToolUse(makeEvent({ tool_input: { command }, cwd }), rules, session, reservations, cohort);
			return { decision: String(result.decision), rule_id: result.rule_id };
		}
		it("P: an existing non-empty file still blocks, through every shape and a cd hop", () => {
			const root = fixture();
			for (const command of [": > full.txt", "> full.txt", "true > full.txt", "cat /dev/null > full.txt", "truncate -s 0 full.txt", "cp /dev/null full.txt", "cd sub && : > full.txt"]) {
				expect(decideIn(root, command), command).toEqual({ decision: "block", rule_id: "builtin-file-truncate" });
			}
		});
		it("N: creating an empty file, or truncating one that is already empty, is not a truncation", () => {
			const root = fixture();
			for (const command of [": > .gitkeep", "> src/new/.gitkeep", "mkdir -p logs && : > logs/app.log", "true > out.txt", ": > empty.txt", "truncate -s 0 empty.txt"]) {
				const r = decideIn(root, command);
				expect(r.rule_id, command).not.toBe("builtin-file-truncate");
				expect(r.decision, command).toBe("allow");
			}
		});
	});

	describe("U4 rules — pinned limits (flip when a fix lands)", () => {
		it("an `eval` string payload is scannable since 2026-10-09 (spans.ts EVAL_PAYLOAD_RE)", () => {
			expectFires("builtin-file-truncate", 'eval "truncate -s 0 src/app.ts"');
			expectFires("builtin-file-truncate", 'eval ": > src/harness/foo.ts"');
			expectFires("builtin-chown-recursive", "eval 'chown -R root src'");
		});
		it("a quoted single-word operand is visible since 2026-10-09 (spans.ts quotedOperandText)", () => {
			expectFires("builtin-file-truncate", 'truncate -s 0 "src/app.ts"');
			expectFires("builtin-chmod-000", "chmod -R 000 'src'");
			expectFires("builtin-chown-recursive", 'chown -R root "src"');
		});
		it("a quoted operand that holds whitespace is still masked (residual gap)", () => {
			expectSilent("builtin-file-truncate", 'truncate -s 0 "src/my app.ts"');
		});
		it("a relative target after `cd` into a temp dir still blocks (the rule cannot see the cd)", () => {
			expectFires("builtin-file-truncate", "cd /tmp/clone && : > out/files.txt");
		});
	});
});
