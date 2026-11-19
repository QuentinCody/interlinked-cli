import { describe, expect, it } from "vitest";
import { oblNetOpenAtStop } from "./rules-obligations.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent } from "./types.js";

function ev(hook: string, tool: string, input: ToolEvent["input"], n: number): ToolEvent {
	return { ts: `2026-07-01T00:00:0${n}.000Z`, session: "s1", agent: "claude", tool, toolUseId: `u${n}`, hook, input, toolOutcome: "success" };
}

describe("oblNetOpenAtStop severity", () => {
	// test-contract: public-api — the Stop inventory of open obligations is a medium-severity nudge
	it("reports the Stop inventory as a nudge with medium severity", () => {
		const state = createState("s1");
		const open = ev("PostToolUse", "Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "// TODO wire this" }, 1);
		const stop = ev("Stop", "", {}, 2);
		applyEvent(state, open);
		applyEvent(state, stop);
		const verdict = oblNetOpenAtStop(state, stop);
		expect(verdict?.action).toBe("nudge");
		expect(verdict?.severity).toBe("medium");
	});
});
