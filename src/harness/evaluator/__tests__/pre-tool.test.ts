import { makeSession as makeSessionFixture } from "../../__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import { CohortManager } from "../../cohort.js";
import { ReservationManager } from "../../reservations.js";
import { getDefaultConfig } from "../../rules-loader.js";
import type { HarnessEvent, SessionTrajectory } from "../../types.js";
import { evaluatePreToolUse } from "../pre-tool.js";

const FIXED_TIMESTAMP = "2026-04-01T00:00:00.000Z";

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "t",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

function makeSession(): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		session_id: "t",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 0,
		tool_sequence: [],
		sensitivity_level: "Public",
		soft_blocks: new Set(),
		fired_reminders: new Set(),
		suggested_permissions: new Set(),
		consecutive_pattern: null,
		curl_localhost_count: {},
		injection_detected_steps: [],
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
	} satisfies SessionTrajectory);
}

describe("evaluatePreToolUse smoke", () => {
	it("returns allow when rules.enabled = false", () => {
		const rules = getDefaultConfig();
		rules.enabled = false;
		const result = evaluatePreToolUse(
			makeEvent(),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("passes a trivial ls command through with allow", () => {
		const rules = getDefaultConfig();
		const result = evaluatePreToolUse(
			makeEvent({ tool_input: { command: "ls -la" } }),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
	});

	it("blocks reading a .env file", () => {
		const rules = getDefaultConfig();
		const result = evaluatePreToolUse(
			makeEvent({
				tool_name: "Read",
				tool_input: { file_path: "/tmp/project/.env" },
			}),
			rules,
			makeSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
	});

	// A phase that returns a bare allow carrying its OWN warnings array is not
	// terminal: the pipeline keeps running and the phase's warnings must be
	// folded into the shared list, or they never reach the agent. The taint
	// phase's step-limit degradation is the live producer of that shape
	// (read-only tools stay allowed once the budget is blown).
	it("folds a non-terminal phase's own allow-warnings into the final decision", () => {
		const rules = getDefaultConfig();
		const session = makeSession();
		session.step_limit = 5;
		session.tool_call_count = 10;
		const result = evaluatePreToolUse(
			makeEvent({ tool_name: "Read", tool_input: { file_path: "src/index.ts" } }),
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		expect(result.warnings).toContain(
			"[interlinked:budget] Step limit (5) exceeded — read-only mode. Mutations are blocked. Wrap up and commit.",
		);
	});

	// Same fold, deduped: a warning the shared list already carries must not be
	// appended twice when the phase's array replays it.
	it("does not duplicate a warning the shared list already carries", () => {
		const rules = getDefaultConfig();
		const session = makeSession();
		session.step_limit = 5;
		session.tool_call_count = 10;
		const result = evaluatePreToolUse(
			makeEvent({ tool_name: "Read", tool_input: { file_path: "src/index.ts" } }),
			rules,
			session,
			new ReservationManager(),
			new CohortManager(),
		);
		const budgetLines = (result.warnings ?? []).filter((w) =>
			w.startsWith("[interlinked:budget] Step limit (5) exceeded"),
		);
		expect(budgetLines).toHaveLength(1);
	});
});

// The step budget binds the CALLING actor. A subagent's tool calls arrive
// under the parent's session id (`subagent_id` + its own `agent_name`), so the
// session total sums every spawned agent; the orchestrator's own budget must
// not be spent by its workers, and a worker over its own budget is still
// stopped. Full pipeline, not the guard in isolation: this pins the wiring
// from the event through `newPreToolCtx` to the taint phase.
describe("evaluatePreToolUse — per-actor step budget", () => {
	function inflatedSession(): SessionTrajectory {
		const session = makeSession();
		session.step_limit = 5;
		session.tool_call_count = 10;
		session.actor_tool_calls = new Map([
			["test-agent", 2],
			["sub-1", 8],
		]);
		return session;
	}

	it("P1: allows the parent's Bash call when only subagent steps pushed the session over the limit", () => {
		const result = evaluatePreToolUse(
			makeEvent({ tool_name: "Bash", tool_input: { command: "ls -la" } }),
			getDefaultConfig(),
			inflatedSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("allow");
		expect((result.warnings ?? []).some((w) => w.startsWith("[interlinked:budget]"))).toBe(false);
	});

	it("P2: blocks the subagent whose own count is over the limit", () => {
		const result = evaluatePreToolUse(
			makeEvent({
				tool_name: "Bash",
				tool_input: { command: "ls -la" },
				agent_name: "sub-1",
				subagent_id: "sub-1",
			}),
			getDefaultConfig(),
			inflatedSession(),
			new ReservationManager(),
			new CohortManager(),
		);
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("Step limit (5) exceeded");
	});
});
