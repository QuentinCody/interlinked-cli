import { describe, expect, it } from "vitest";
import { readBudgetFields, readCapturedPlan } from "../session-snapshot-codec.js";

// Mutation-hardening tests. Basis for the expected behavior: the doc comments
// on readActorToolCalls / readStepLimit in session-snapshot-codec.ts
// (lines 112-117 and 124-128) and readBudgetFields (lines 133-135).

describe("readBudgetFields", () => {
	it("hydrates an absent actor_tool_calls as ABSENT, not as an empty map", () => {
		const out = readBudgetFields({ step_limit: 5 });
		expect("actor_tool_calls" in out).toBe(false);
	});

	it("hydrates a present actor_tool_calls object into a map of finite counts", () => {
		const out = readBudgetFields({ step_limit: 5, actor_tool_calls: { a: 2, b: "x" } }) as {
			actor_tool_calls?: Map<string, number>;
		};
		expect(out.actor_tool_calls).toBeInstanceOf(Map);
		expect([...(out.actor_tool_calls ?? [])]).toEqual([["a", 2]]);
	});

	it("hydrates a present but empty actor_tool_calls as an empty map (distinct from absent)", () => {
		const out = readBudgetFields({ actor_tool_calls: {} }) as {
			actor_tool_calls?: Map<string, number>;
		};
		expect(out.actor_tool_calls).toBeInstanceOf(Map);
		expect(out.actor_tool_calls?.size).toBe(0);
	});

	it("keeps a finite step_limit as is", () => {
		expect(readBudgetFields({ step_limit: 7 }).step_limit).toBe(7);
		expect(readBudgetFields({ step_limit: 0 }).step_limit).toBe(0);
	});

	it("reads a null (serialized Infinity) or missing step_limit as unlimited", () => {
		expect(readBudgetFields({ step_limit: null }).step_limit).toBe(Number.POSITIVE_INFINITY);
		expect(readBudgetFields({}).step_limit).toBe(Number.POSITIVE_INFINITY);
	});

	it("reads a non-finite or non-number step_limit as unlimited", () => {
		expect(readBudgetFields({ step_limit: Number.NaN }).step_limit).toBe(Number.POSITIVE_INFINITY);
		expect(readBudgetFields({ step_limit: "9" }).step_limit).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("readCapturedPlan created_at_step", () => {
	it("defaults a missing created_at_step to 0", () => {
		const plan = readCapturedPlan({
			session_id: "s",
			agent_name: "a",
			created_at_iso: "2026-01-01T00:00:00Z",
			steps: [],
		});
		expect(plan?.created_at_step).toBe(0);
	});
});
