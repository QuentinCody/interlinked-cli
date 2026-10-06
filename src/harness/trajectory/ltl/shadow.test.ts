import { describe, expect, it } from "vitest";
import { applyEvent, createState } from "../state.js";
import type { ToolEvent } from "../types.js";
import { evaluateLtlShadow } from "./shadow.js";

const MULTI = "a\nb\nc";

function ev(partial: Partial<ToolEvent> & { tool: string; hook: string }, i: number): ToolEvent {
	return { ts: "2026-10-04T00:00:00.000Z", session: "s", agent: "claude", toolUseId: `tu-${i}`, input: {}, ...partial };
}
function edit(file: string, i: number): ToolEvent {
	return ev({ tool: "Edit", hook: "PostToolUse", input: { file_path: file, old_string: MULTI, new_string: `${MULTI}\nd` } }, i);
}
function stop(i: number): ToolEvent {
	return ev({ tool: "", hook: "Stop" }, i);
}

describe("evaluateLtlShadow — positive (reports as silent metrics)", () => {
	it("P1: a formula violation becomes an `ltl:`-prefixed silent_metric verdict naming its evidence", () => {
		const state = createState("s");
		const e = edit("/r/src/a.ts", 0);
		applyEvent(state, e);
		const verdicts = evaluateLtlShadow(state, e);
		const cold = verdicts.find((v) => v.ruleId === "ltl:reb_cold_start_first_edit_zero_reads");
		expect(cold?.action).toBe("silent_metric");
		expect(cold?.severity).toBe("low");
		expect(cold?.reason).toContain("onset #0");
		expect(cold?.reason).toContain("sessionOriented=false");
		expect(cold?.reason).toContain("state.readCount");
	});

	it("P2: at Stop an open strong obligation is reported as unknown, never as a pass", () => {
		const state = createState("s");
		const e = edit("/r/src/a.ts", 0);
		applyEvent(state, e);
		evaluateLtlShadow(state, e);
		const atStop = evaluateLtlShadow(state, stop(1));
		expect(atStop.map((v) => v.ruleId)).toEqual(["ltl:source_edit_verified_within_events"]);
		expect(atStop[0]?.reason).toContain("unknown");
		expect(atStop[0]?.action).toBe("silent_metric");
	});

	it("P3: monitor state is keyed by the trajectory state object — a second session starts fresh", () => {
		const a = createState("a");
		const b = createState("b");
		const e = edit("/r/src/a.ts", 0);
		applyEvent(a, e);
		applyEvent(b, e);
		expect(evaluateLtlShadow(a, e).length).toBeGreaterThan(0);
		expect(evaluateLtlShadow(b, e).length).toBeGreaterThan(0); // not de-duplicated against session a
	});
});

describe("evaluateLtlShadow — negative (never a block, never noise)", () => {
	it("N1: a clean read is silent and Stop with nothing open reports nothing", () => {
		const state = createState("s");
		const r = ev({ tool: "Read", hook: "PostToolUse", input: { file_path: "/r/src/a.ts" } }, 0);
		applyEvent(state, r);
		expect(evaluateLtlShadow(state, r)).toEqual([]);
		expect(evaluateLtlShadow(state, stop(1))).toEqual([]);
	});

	it("N2: every verdict is silent_metric — the shadow layer never asks for a block or a nudge", () => {
		const state = createState("s");
		const all: string[] = [];
		for (let i = 0; i < 12; i++) {
			const e = edit("/r/src/a.ts", i);
			applyEvent(state, e);
			all.push(...evaluateLtlShadow(state, e).map((v) => v.action));
		}
		expect(all.length).toBeGreaterThan(0);
		expect(new Set(all)).toEqual(new Set(["silent_metric"]));
	});

	it("N3: a lifecycle hook that is not a tool call or Stop is ignored", () => {
		const state = createState("s");
		expect(evaluateLtlShadow(state, ev({ tool: "", hook: "SessionStart" }, 0))).toEqual([]);
	});
});
