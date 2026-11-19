import { describe, expect, it } from "vitest";
import { createState, evaluateTrajectory } from "./index.js";
import type { ToolEvent } from "./types.js";

// Census fault: the `evaluateLtlShadow` verdicts were no longer appended (docs/reviews/kill-proof-census-e2e-structure.md #29).
describe("evaluateTrajectory — LTL shadow verdicts are part of the result", () => {
	// test-contract: invariant — a cold-start multi-line surgical edit yields the hand-coded verdict AND the ltl:-prefixed shadow verdict, appended after it
	it("appends ltl: silent metrics after the hand-coded verdicts", () => {
		const state = createState("s1");
		const event: ToolEvent = {
			ts: "2026-07-01T00:00:00.000Z",
			session: "s1",
			agent: "claude",
			tool: "Edit",
			toolUseId: "tu-1",
			hook: "PostToolUse",
			input: { file_path: "/r/src/a.ts", old_string: "a\nb\nc", new_string: "a\nb\nc\nd" },
		};
		const verdicts = evaluateTrajectory(state, event);
		const ltl = verdicts.filter(v => v.ruleId.startsWith("ltl:"));
		expect(ltl.map(v => v.ruleId)).toContain("ltl:reb_cold_start_first_edit_zero_reads");
		expect(ltl.every(v => v.action === "silent_metric")).toBe(true);
		const firstLtl = verdicts.findIndex(v => v.ruleId.startsWith("ltl:"));
		expect(verdicts.slice(firstLtl).every(v => v.ruleId.startsWith("ltl:"))).toBe(true);
	});
});
