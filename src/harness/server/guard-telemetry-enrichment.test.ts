import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	__resetActorModelsForTesting,
	actorKeyFor,
	ACTOR_MODEL_CAP,
	bridgeGuardBlockToRecurrence,
	recallActorModel,
	rememberActorModel,
} from "./guard-telemetry-enrichment.js";

const recorded: Array<Record<string, unknown>> = [];
vi.mock("../recurrence.js", () => ({
	recordHarnessCaught: (opts: Record<string, unknown>) => {
		recorded.push(opts);
	},
}));

function evt(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command: "rm -f scratch/probe.mts" },
		timestamp: "2026-09-03T00:00:00.000Z",
		...over,
	} as HarnessEvent;
}

function block(over: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "block", rule_id: "repo-scratch-is-write-only", reason: "no", ...over } as HarnessDecision;
}

afterEach(() => {
	recorded.length = 0;
	__resetActorModelsForTesting();
});

describe("actor model cache — positive (must remember)", () => {
	it("P1: recalls a model stored under the same actor key", () => {
		rememberActorModel("agent-a", "vendor-model-v6");
		expect(recallActorModel("agent-a")).toBe("vendor-model-v6");
	});

	it("P2: keys a subagent separately from its parent session, so per-model comparison works", () => {
		expect(actorKeyFor(evt({ session_id: "s", subagent_id: "sub-9" } as Partial<HarnessEvent>))).toBe("sub-9");
		expect(actorKeyFor(evt({ session_id: "s" }))).toBe("s");
	});

	it("P3: bounds the cache, dropping the oldest actor", () => {
		for (let i = 0; i < ACTOR_MODEL_CAP + 5; i++) rememberActorModel(`a${i}`, `m${i}`);
		expect(recallActorModel("a0")).toBeUndefined();
		expect(recallActorModel(`a${ACTOR_MODEL_CAP + 4}`)).toBe(`m${ACTOR_MODEL_CAP + 4}`);
	});
});

describe("actor model cache — negative (must not invent)", () => {
	it("N1: returns undefined for an unknown actor rather than a guess", () => {
		expect(recallActorModel("never-seen")).toBeUndefined();
	});

	it("N2: ignores an empty model string", () => {
		rememberActorModel("agent-b", "");
		expect(recallActorModel("agent-b")).toBeUndefined();
	});
});

describe("guard block → recurrence bridge — positive (must record)", () => {
	it("P4: records a blocked guard rule keyed by its rule id", () => {
		bridgeGuardBlockToRecurrence(evt(), block(), "/repo");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			check_id: "repo-scratch-is-write-only",
			session_id: "sess-1",
			agent_source: "claude",
			phase: "pre_block",
			severity: "error",
		});
	});

	it("P5: an `ask` decision records as a warning — it still stalls someone", () => {
		bridgeGuardBlockToRecurrence(evt(), block({ decision: "ask" }), "/repo");
		expect(recorded[0]).toMatchObject({ severity: "warning" });
	});

	it("P6: uses the edited file path when the tool input carries one", () => {
		const e = evt({ tool_name: "Edit", tool_input: { file_path: "/repo/src/a.ts" } });
		bridgeGuardBlockToRecurrence(e, block(), "/repo");
		expect(recorded[0]?.file).toBe("src/a.ts");
	});

	it("P7: falls back to the command verb for a Bash block, so aggregation stays readable", () => {
		bridgeGuardBlockToRecurrence(evt(), block(), "/repo");
		expect(recorded[0]?.file).toBe("bash:rm");
	});
});

describe("guard block → recurrence bridge — negative (must not record)", () => {
	it("N3: a dry run never persists — `harness test` must not move the ledger", () => {
		bridgeGuardBlockToRecurrence(evt({ dry_run: true }), block(), "/repo");
		expect(recorded).toHaveLength(0);
	});

	it("N4: an allow decision is not a catch", () => {
		bridgeGuardBlockToRecurrence(evt(), block({ decision: "allow" }), "/repo");
		expect(recorded).toHaveLength(0);
	});

	it("N5: a warn-only decision is not a catch (12k warns would drown the ledger)", () => {
		bridgeGuardBlockToRecurrence(evt(), block({ decision: "allow", warnings: ["w"] }), "/repo");
		expect(recorded).toHaveLength(0);
	});

	it("N6: a block with no rule id has no aggregation key, so it is skipped", () => {
		bridgeGuardBlockToRecurrence(evt(), block({ rule_id: undefined }), "/repo");
		expect(recorded).toHaveLength(0);
	});

	it("N7: never throws when recurrence storage fails", () => {
		expect(() => bridgeGuardBlockToRecurrence(evt({ tool_input: undefined }), block(), "/repo")).not.toThrow();
	});
});
