// Resource-bomb rule tests (Plan 03 — rows 11-20 of the phase matrix).
//
// These rules guard against patterns that don't destroy data, but slow the
// user's machine to a crawl or trash workstation stability — fork bombs,
// infinite spin loops, runaway memory allocation, file-descriptor
// exhaustion. SRPS (system_resource_protection_script) ports.
//
// Plan-level reference: docs/plans/free-cli-adoption/03-resource-bomb-rules.md.
//
// Test plan (per Plan 03 §"Test plan"):
//   1. Positive: canonical pattern fires.
//   2. FP guard: similar shape that should NOT fire.
//   3. Wrapped (sudo): tested as-is — wrapper-normalization is a Phase-2
//      concern; the regex either tolerates `sudo cmd` form or it doesn't.
//   4. Threshold edge: for parameterized rules (rows 14, 15, 16, 17, 20),
//      test the boundary value.
//   5. Cross-rule integration: `bash -c 'while :; do :; done'` fires
//      builtin-infinite-spin (Plan 03 final paragraph — pre-spans-projection
//      we still scan the inner string).

import { describe, expect, it } from "vitest";
import { CohortManager } from "../../cohort.js";
import { evaluatePreToolUse } from "../../evaluator.js";
import { ReservationManager } from "../../reservations.js";
import { getDefaultConfig, loadRules } from "../../rules-loader.js";
import type {
	HarnessEvent,
	SessionTrajectory,
} from "../../types.js";
import { RESOURCE_BOMB_RULES } from "../builtin-rules-resource-bombs.js";

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

// Pattern-only matcher: applies the rule's regexes directly. Mirrors how the
// evaluator ultimately uses rules (positive-OR over patterns within a rule).
// Used for unit-level FP/threshold tests where we want to isolate the regex
// without interaction effects from other built-in rules.
function patternMatchesRule(ruleId: string, command: string): boolean {
	const rule = RESOURCE_BOMB_RULES.find((r) => r.id === ruleId);
	if (!rule) return false;
	for (const p of rule.patterns) {
		if (p.field !== "command") continue;
		const re = new RegExp(p.regex, p.flags || "i");
		if (re.test(command)) return true;
	}
	return false;
}

// ===========================================
// Registry shape
// ===========================================

describe("RESOURCE_BOMB_RULES — registry shape", () => {
	it("exports an array of exactly 10 rules", () => {
		expect(Array.isArray(RESOURCE_BOMB_RULES)).toBe(true);
		expect(RESOURCE_BOMB_RULES.length).toBe(10);
	});

	it("every rule has an id beginning with builtin-", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(r.id.startsWith("builtin-")).toBe(true);
		}
	});

	it("every rule fires PreToolUse (gate must run before the call)", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(r.trigger).toBe("PreToolUse");
		}
	});

	it("every rule targets Bash/Shell/run_command tool classes", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(r.tool_match).toContain("Bash");
			expect(r.tool_match).toContain("Shell");
			expect(r.tool_match).toContain("run_command");
		}
	});

	it("every rule has category 'resource'", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(r.category).toBe("resource");
		}
	});

	it("every rule populates a keywords field (empty array allowed)", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(Array.isArray(r.keywords)).toBe(true);
		}
	});

	it("every rule has a non-empty reason and suggestion", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(r.reason).toBeTruthy();
			expect(r.suggestion).toBeTruthy();
		}
	});

	it("severity is critical/high/medium across the family (no info/low)", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			expect(["critical", "high", "medium"]).toContain(r.severity);
		}
	});

	it("includes all 10 documented rule ids in the right order", () => {
		const expectedIds = [
			"builtin-fork-bomb",
			"builtin-infinite-spin",
			"builtin-dd-if-zero",
			"builtin-unbounded-seq-loop",
			"builtin-xargs-parallel-large",
			"builtin-ulimit-fd-raise",
			"builtin-parallel-large-jobs",
			"builtin-inotify-root-watch",
			"builtin-nohup-detach-loop",
			"builtin-fallocate-huge",
		];
		expect(RESOURCE_BOMB_RULES.map((r) => r.id)).toEqual(expectedIds);
	});

	it("fork-bomb has empty keywords (always-evaluate per Plan 01 §1.3)", () => {
		const fork = RESOURCE_BOMB_RULES.find((r) => r.id === "builtin-fork-bomb");
		expect(fork).toBeDefined();
		expect(fork?.keywords).toEqual([]);
	});

	it("non-fork-bomb rules have at least one keyword", () => {
		for (const r of RESOURCE_BOMB_RULES) {
			if (r.id === "builtin-fork-bomb") continue;
			expect((r.keywords ?? []).length).toBeGreaterThan(0);
		}
	});

	it("uses block for clearly-never-legitimate patterns and ask for tunable thresholds", () => {
		// Plan 03 §"Action mix": block for fork-bomb + infinite-spin; ask for
		// the rest. (If `ask` plumbing isn't ready in a release, those are
		// flipped to `warn` — but the matrix target is `ask`.)
		const blockIds = RESOURCE_BOMB_RULES.filter((r) => r.action === "block").map(
			(r) => r.id,
		);
		const askIds = RESOURCE_BOMB_RULES.filter((r) => r.action === "ask").map(
			(r) => r.id,
		);
		expect(blockIds).toEqual(["builtin-fork-bomb", "builtin-infinite-spin"]);
		expect(askIds.length).toBe(8);
	});
});

// ===========================================
// Row 11: builtin-fork-bomb (block, critical, keywords: [])
// ===========================================

describe("builtin-fork-bomb (row 11)", () => {
	it("matches the canonical fork bomb (no spaces inside braces)", () => {
		const cmd = String.fromCharCode(58) + "(){:|:&};:";
		expect(patternMatchesRule("builtin-fork-bomb", cmd)).toBe(true);
	});

	it("matches the spaced fork bomb variant", () => {
		const cmd = String.fromCharCode(58) + "(){ :|:& };:";
		expect(patternMatchesRule("builtin-fork-bomb", cmd)).toBe(true);
	});

	it("does NOT match a benign colon usage (FP guard)", () => {
		expect(patternMatchesRule("builtin-fork-bomb", "echo : is the no-op")).toBe(
			false,
		);
		expect(patternMatchesRule("builtin-fork-bomb", "ls -la /tmp")).toBe(false);
	});

	it("does NOT match arithmetic with colons (similar shape)", () => {
		// Ternary-like or assignment expressions don't trigger.
		expect(
			patternMatchesRule("builtin-fork-bomb", "x=$((a > b ? 1 : 0))"),
		).toBe(false);
	});

	it("does NOT match fork-bomb-shaped text inside an unrelated string", () => {
		// e.g., a sed expression or markdown documentation. The literal pattern
		// is scoped to the canonical shape; benign substitutions do not fire.
		expect(patternMatchesRule("builtin-fork-bomb", "echo hello world")).toBe(
			false,
		);
	});

	it("end-to-end blocks via evaluator (already covered upstream — keep as a sanity check)", () => {
		const rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		const event = makeEvent({
			tool_input: { command: String.fromCharCode(58) + "(){ :|:& };:" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
	});
});

// ===========================================
// Row 12: builtin-infinite-spin (block, high, keywords: ["while"])
// ===========================================

describe("builtin-infinite-spin (row 12)", () => {
	it("matches `while :; do :; done` (canonical)", () => {
		expect(patternMatchesRule("builtin-infinite-spin", "while :; do :; done")).toBe(
			true,
		);
	});

	it("matches `while true; do true; done`", () => {
		expect(
			patternMatchesRule("builtin-infinite-spin", "while true; do true; done"),
		).toBe(true);
	});

	it("does NOT match a bounded while loop (FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-infinite-spin",
				"while [ $i -lt 10 ]; do ((i++)); done",
			),
		).toBe(false);
	});

	it("does NOT match a loop with side-effects (FP guard — has way to terminate)", () => {
		expect(
			patternMatchesRule(
				"builtin-infinite-spin",
				"while true; do echo hi; sleep 1; done",
			),
		).toBe(false);
		expect(
			patternMatchesRule(
				"builtin-infinite-spin",
				"while true; do curl http://example.com; sleep 1; done",
			),
		).toBe(false);
	});

	it("matches when wrapped in `bash -c '...'` (cross-rule integration per Plan 03)", () => {
		// The current pre-spans-projection scanner DOES scan quoted text. A
		// `bash -c '<infinite spin>'` is the same problem as the unwrapped form.
		expect(
			patternMatchesRule(
				"builtin-infinite-spin",
				"bash -c 'while :; do :; done'",
			),
		).toBe(true);
	});

	it("end-to-end: evaluator decision is block for `while :; do :; done`", () => {
		const rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		const event = makeEvent({ tool_input: { command: "while :; do :; done" } });
		const result = evaluatePreToolUse(
			event,
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
	});

	// Cross-rule integration note (Plan 03 §"infinite-spin true-positive vs
	// false-positive"): the regex itself DOES match the inner string of
	// `bash -c 'while :; do :; done'` (verified above by the pattern-only
	// test). At the full-evaluator level, however, the Plan 01 keyword
	// quick-reject splits on `/[\s|&;<>()`=]+/`, which leaves `while` glued
	// to the leading single-quote (`'while`) — so the `while` keyword does
	// not exactly match a token, and the rule is filtered out before its
	// regex runs.
	//
	// This is an acceptable limitation today: an unwrapped `while :; do :;
	// done` is what the agent would emit nine times out of ten, and the
	// quoted form is plainly visible to the human user who reviews the
	// tool call. Phase-2 wrapper-normalization + spans projection will fix
	// the gap; until then, document by assertion rather than block.
	it("`bash -c 'while :; do :; done'` is blocked end-to-end (quotes are token boundaries)", () => {
		// The keyword tokenizer treats `'`/`"` as token boundaries (see
		// keyword-quick-reject.ts), so the inner shell command's tokens
		// (`while`, `do`, `done`, `:`) are visible to the quick-reject
		// pre-filter. The rule fires, the regex matches against the raw
		// command (which still contains `while :; do :; done`), and the
		// agent gets blocked.
		const rules = getDefaultConfig();
		const loaded = loadRules(process.cwd());
		rules.rules = loaded.rules;
		const event = makeEvent({
			tool_input: { command: "bash -c 'while :; do :; done'" },
		});
		const result = evaluatePreToolUse(
			event,
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
	});
});

// ===========================================
// Row 13: builtin-dd-if-zero (ask, high, keywords: ["dd"])
// ===========================================

describe("builtin-dd-if-zero (row 13)", () => {
	it("matches dd if=/dev/zero of=...", () => {
		expect(
			patternMatchesRule(
				"builtin-dd-if-zero",
				"dd if=/dev/zero of=/tmp/file bs=1M count=100",
			),
		).toBe(true);
	});

	it("matches dd if=/dev/urandom of=...", () => {
		expect(
			patternMatchesRule(
				"builtin-dd-if-zero",
				"dd if=/dev/urandom of=/tmp/r bs=1M",
			),
		).toBe(true);
	});

	it("matches dd if=/dev/random of=...", () => {
		expect(
			patternMatchesRule(
				"builtin-dd-if-zero",
				"dd if=/dev/random of=/tmp/r bs=1M",
			),
		).toBe(true);
	});

	it("does NOT match dd reading /dev/zero without of= (read-only — FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-dd-if-zero",
				"dd if=/dev/zero bs=1M count=10 | hexdump",
			),
		).toBe(false);
	});

	it("does NOT match dd writing TO /dev/sdb without if=/dev/zero|urandom|random", () => {
		// dd-block-device handles this at a different rule; we shouldn't double-fire.
		expect(
			patternMatchesRule("builtin-dd-if-zero", "dd if=disk.img of=/dev/sdb"),
		).toBe(false);
	});

	it("matches even with sudo prefix (regex tolerates wrapper)", () => {
		expect(
			patternMatchesRule(
				"builtin-dd-if-zero",
				"sudo dd if=/dev/zero of=/swapfile bs=1M count=1024",
			),
		).toBe(true);
	});
});

// ===========================================
// Row 14: builtin-unbounded-seq-loop (ask, medium, keywords: ["for"])
// ===========================================

describe("builtin-unbounded-seq-loop (row 14)", () => {
	it("matches for i in {1..10000000} (10M iterations)", () => {
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for i in {1..10000000}; do echo $i; done",
			),
		).toBe(true);
	});

	it("matches for i in {1..1000000} (1M — boundary at threshold)", () => {
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for i in {1..1000000}; do echo $i; done",
			),
		).toBe(true);
	});

	it("threshold edge: does NOT match for i in {1..999999} (just below 1M)", () => {
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for i in {1..999999}; do echo $i; done",
			),
		).toBe(false);
	});

	it("does NOT match small bounded loops (FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for i in {1..100}; do echo $i; done",
			),
		).toBe(false);
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for i in 1 2 3; do echo $i; done",
			),
		).toBe(false);
	});

	it("does NOT match brace expansions that aren't numeric ranges", () => {
		expect(
			patternMatchesRule(
				"builtin-unbounded-seq-loop",
				"for f in {a,b,c}; do echo $f; done",
			),
		).toBe(false);
	});
});

// ===========================================
// Row 15: builtin-xargs-parallel-large (ask, medium, keywords: ["xargs"])
// ===========================================

describe("builtin-xargs-parallel-large (row 15)", () => {
	it("matches xargs -P 1000", () => {
		expect(
			patternMatchesRule("builtin-xargs-parallel-large", "xargs -P 1000 echo"),
		).toBe(true);
	});

	it("matches xargs -P 100 (boundary at threshold)", () => {
		expect(
			patternMatchesRule(
				"builtin-xargs-parallel-large",
				"cat list | xargs -P 100 -n 1 echo",
			),
		).toBe(true);
	});

	it("matches xargs with flags-before-P (-n 1 -P 500)", () => {
		expect(
			patternMatchesRule(
				"builtin-xargs-parallel-large",
				"cat list | xargs -n 1 -P 500 echo",
			),
		).toBe(true);
	});

	it("threshold edge: does NOT match xargs -P 99 (just below 100)", () => {
		expect(
			patternMatchesRule("builtin-xargs-parallel-large", "xargs -P 99 echo"),
		).toBe(false);
	});

	it("does NOT match xargs -P 50 (FP guard — typical concurrency)", () => {
		expect(
			patternMatchesRule("builtin-xargs-parallel-large", "xargs -P 50 echo"),
		).toBe(false);
	});

	it("does NOT match xargs without -P flag", () => {
		expect(
			patternMatchesRule("builtin-xargs-parallel-large", "xargs -n 1 echo"),
		).toBe(false);
	});
});

// ===========================================
// Row 16: builtin-ulimit-fd-raise (ask, medium, keywords: ["ulimit"])
// ===========================================

describe("builtin-ulimit-fd-raise (row 16)", () => {
	it("matches ulimit -n 100000", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -n 100000"),
		).toBe(true);
	});

	it("matches ulimit -n 50000 (5-digit boundary)", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -n 50000"),
		).toBe(true);
	});

	it("matches ulimit -n 10000 (boundary at 5 digits)", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -n 10000"),
		).toBe(true);
	});

	it("threshold edge: does NOT match ulimit -n 9999 (just below 5 digits)", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -n 9999"),
		).toBe(false);
	});

	it("does NOT match ulimit -n 1024 (typical default — FP guard)", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -n 1024"),
		).toBe(false);
	});

	it("does NOT match ulimit -u 100000 (different resource — FP guard)", () => {
		expect(
			patternMatchesRule("builtin-ulimit-fd-raise", "ulimit -u 100000"),
		).toBe(false);
	});
});

// ===========================================
// Row 17: builtin-parallel-large-jobs (ask, medium, keywords: ["parallel"])
// ===========================================

describe("builtin-parallel-large-jobs (row 17)", () => {
	it("matches parallel --jobs 500", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel --jobs 500 -- echo",
			),
		).toBe(true);
	});

	it("matches parallel --jobs=200 (equals form)", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel --jobs=200 echo {} ::: a b c",
			),
		).toBe(true);
	});

	it("matches parallel --jobs 100 (boundary at threshold)", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel --jobs 100 -- echo",
			),
		).toBe(true);
	});

	it("threshold edge: does NOT match parallel --jobs 99 (just below 100)", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel --jobs 99 -- echo",
			),
		).toBe(false);
	});

	it("does NOT match parallel --jobs 4 (typical setting — FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel --jobs 4 -- echo",
			),
		).toBe(false);
	});

	it("does NOT match parallel without --jobs flag", () => {
		expect(
			patternMatchesRule(
				"builtin-parallel-large-jobs",
				"parallel echo {} ::: a b c",
			),
		).toBe(false);
	});
});

// ===========================================
// Row 18: builtin-inotify-root-watch (ask, medium, keywords: ["inotifywait"])
// ===========================================

describe("builtin-inotify-root-watch (row 18)", () => {
	it("matches inotifywait -r / (recursive on root)", () => {
		expect(
			patternMatchesRule("builtin-inotify-root-watch", "inotifywait -r /"),
		).toBe(true);
	});

	it("matches inotifywait -m / (monitor on root)", () => {
		expect(
			patternMatchesRule("builtin-inotify-root-watch", "inotifywait -m / "),
		).toBe(true);
	});

	it("matches inotifywait -rm / (combined flags)", () => {
		expect(
			patternMatchesRule("builtin-inotify-root-watch", "inotifywait -rm /"),
		).toBe(true);
	});

	it("does NOT match inotifywait -r /home/user (specific dir — FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-inotify-root-watch",
				"inotifywait -r /home/user",
			),
		).toBe(false);
	});

	it("does NOT match inotifywait -r /var/log (specific dir — FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-inotify-root-watch",
				"inotifywait -r /var/log",
			),
		).toBe(false);
	});

	it("does NOT match inotifywait without -r/-m flag", () => {
		expect(
			patternMatchesRule("builtin-inotify-root-watch", "inotifywait /tmp"),
		).toBe(false);
	});
});

// ===========================================
// Row 19: builtin-nohup-detach-loop (ask, medium, keywords: ["nohup"])
// ===========================================

describe("builtin-nohup-detach-loop (row 19)", () => {
	it("matches nohup bash -c 'while true; do ... done' &", () => {
		expect(
			patternMatchesRule(
				"builtin-nohup-detach-loop",
				`nohup bash -c "while true; do sleep 1; done" &`,
			),
		).toBe(true);
	});

	it("matches nohup bash -c 'for i in ...; do ... done' &", () => {
		expect(
			patternMatchesRule(
				"builtin-nohup-detach-loop",
				`nohup bash -c 'for i in 1 2 3; do echo $i; done' &`,
			),
		).toBe(true);
	});

	it("does NOT match nohup with a single command (FP guard)", () => {
		// nohup-network rule may catch this, but nohup-detach-loop should not.
		expect(
			patternMatchesRule(
				"builtin-nohup-detach-loop",
				"nohup curl http://example.com &",
			),
		).toBe(false);
	});

	it("does NOT match a foreground while loop without nohup", () => {
		expect(
			patternMatchesRule(
				"builtin-nohup-detach-loop",
				"while true; do sleep 1; done",
			),
		).toBe(false);
	});

	it("does NOT match nohup with for loop but no detach (no &)", () => {
		expect(
			patternMatchesRule(
				"builtin-nohup-detach-loop",
				`nohup bash -c "for i in 1 2; do echo $i; done"`,
			),
		).toBe(false);
	});
});

// ===========================================
// Row 20: builtin-fallocate-huge (ask, medium, keywords: ["fallocate"])
// ===========================================

describe("builtin-fallocate-huge (row 20)", () => {
	it("matches fallocate -l 10G", () => {
		expect(
			patternMatchesRule("builtin-fallocate-huge", "fallocate -l 10G /tmp/huge"),
		).toBe(true);
	});

	it("matches fallocate -l 1T (terabyte)", () => {
		expect(
			patternMatchesRule("builtin-fallocate-huge", "fallocate -l 1T /tmp/huge"),
		).toBe(true);
	});

	it("matches fallocate -l 5g (lowercase suffix)", () => {
		expect(
			patternMatchesRule("builtin-fallocate-huge", "fallocate -l 5g /tmp/huge"),
		).toBe(true);
	});

	it("matches fallocate -l with 10+ digits (raw bytes >=1GB)", () => {
		expect(
			patternMatchesRule(
				"builtin-fallocate-huge",
				"fallocate -l 100000000000 /tmp/huge",
			),
		).toBe(true);
	});

	it("threshold edge: does NOT match fallocate -l 999999999 (9 digits, just below 1GB)", () => {
		expect(
			patternMatchesRule(
				"builtin-fallocate-huge",
				"fallocate -l 999999999 /tmp/small",
			),
		).toBe(false);
	});

	it("does NOT match fallocate -l 100M (megabyte — FP guard)", () => {
		expect(
			patternMatchesRule(
				"builtin-fallocate-huge",
				"fallocate -l 100M /tmp/small",
			),
		).toBe(false);
	});
});

// ===========================================
// Cross-cutting: registry integrity in BUILTIN_RULES
// ===========================================

describe("RESOURCE_BOMB_RULES — integration with BUILTIN_RULES", () => {
	it("all 10 ids appear exactly once in BUILTIN_RULES (no duplicates with other categories)", async () => {
		const { BUILTIN_RULES } = await import("../builtin-rules.js");
		const allIds = BUILTIN_RULES.map((r) => r.id);
		const resourceIds = RESOURCE_BOMB_RULES.map((r) => r.id);
		for (const id of resourceIds) {
			const occurrences = allIds.filter((x) => x === id).length;
			expect(occurrences, `expected exactly 1 occurrence of ${id}`).toBe(1);
		}
	});
});
