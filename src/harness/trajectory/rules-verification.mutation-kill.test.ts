import { describe, expect, it } from "vitest";
import { vdCodeEditStreakNoVerify } from "./rules-verification.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent } from "./types.js";

function edit(i: number): ToolEvent {
	return {
		ts: `2026-07-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
		session: "s1", agent: "claude", tool: "Edit", toolUseId: `k${i}`, hook: "PostToolUse",
		input: { file_path: `src/mod${i}.ts`, old_string: "x", new_string: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj" },
		toolOutcome: "success",
	};
}

describe("vdCodeEditStreakNoVerify — mutation-directed", () => {
	// test-contract: boundary — the third threshold crossing (24 unverified edits) nudges at high severity
	it("nudges on the 24th unverified source edit", () => {
		const state = createState("s1");
		const events: ToolEvent[] = [];
		for (let i = 0; i < 24; i++) { const e = edit(i); events.push(e); applyEvent(state, e); }
		const last = events[23]!;
		expect(vdCodeEditStreakNoVerify(state, last)).toMatchObject({ ruleId: "vd_code_edit_streak_no_verify", action: "nudge", severity: "high" });
	});
});
