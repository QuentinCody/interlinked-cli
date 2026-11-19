import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { acknowledgedSequenceIds } from "./sequence-deferral.js";

const DETECTOR = "secret_read_then_network_call";

const edit = (new_string: string): HarnessEvent =>
	// SAFETY: the module reads only tool_input.
	({
		hook_event: "PreToolUse",
		session_id: "s-defer-kill",
		agent_source: "claude",
		tool_name: "Edit",
		tool_input: { file_path: "a.ts", old_string: "x", new_string },
		timestamp: "2026-08-16T00:00:00Z",
	});

describe("sequence-deferral mutation-kill", () => {
	// test-contract: public-api — a defer marker in an Edit's new_string replacement text is honoured
	it("reads the marker from new_string", () => {
		const ids = acknowledgedSequenceIds(
			edit(`// interlinked: defer ${DETECTOR} -- local probe\nconst a = 1;`),
		);
		expect(ids.get(DETECTOR)).toBe("local probe");
	});
});
