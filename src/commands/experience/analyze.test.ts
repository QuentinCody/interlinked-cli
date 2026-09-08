// Experience analyzer — deterministic session metrics over trajectory records.

import { describe, expect, it } from "vitest";
import { analyzeExperience } from "./analyze.js";
import type { IxExperienceRecord } from "./types.js";

const T0 = "2026-07-27T10:00:00.000Z";
const T9 = "2026-07-27T10:00:09.000Z";

function ixCall(over: {
	ts: string;
	tool_class?: string;
	file?: string;
	guard?: { decision: "block" | "warn"; rule_id: string | null; reason: string | null };
	is_verification?: boolean;
}): IxExperienceRecord {
	const ix: Record<string, unknown> = { episode: 0 };
	if (over.tool_class) ix.tool_class = over.tool_class;
	if (over.file) ix.file = over.file;
	if (over.guard) ix.guard = over.guard;
	if (over.is_verification) ix.is_verification = true;
	// SAFETY: the literal matches the assistant tool-call spine shape.
	return {
		role: "assistant",
		content: null,
		tool_calls: [{ id: "t", name: "X", args: "{}" }],
		timestamp: over.ts,
		ix,
	};
}

function fixture(): IxExperienceRecord[] {
	return [
		// SAFETY: the literal matches the annotated ix meta shape.
		{
			role: "meta",
			source: "claude-code",
			cwd: "/repo",
			git_branch: "main",
			model: "model-x",
			schema: "trajectory-ix.v1",
			ix_meta: {
				session_id: "s",
				agent_name: null,
				records: 8,
				episodes: 1,
				tool_calls: 4,
				guard_blocks: 1,
				truncate_chars: 4000,
			},
		},
		{ role: "user", content: "Fix it.", timestamp: T0 },
		{ role: "reasoning", content: "abcdefghij", timestamp: T0 },
		ixCall({ ts: T0, tool_class: "file_edit", file: "src/a.ts" }),
		ixCall({ ts: T0, tool_class: "file_edit", file: "src/a.ts" }),
		ixCall({ ts: T0, tool_class: "shell_exec", is_verification: true }),
		ixCall({
			ts: T0,
			guard: { decision: "block", rule_id: "builtin-rm-rf", reason: "no" },
		}),
		// SAFETY: the literal matches the tool-result spine shape.
		{
			role: "tool",
			tool_call_id: "t",
			content: "out",
			timestamp: T0,
			ix: { outcome: "error", episode: 0 },
		},
		{ role: "assistant", content: "done!", timestamp: T9 },
	];
}

describe("analyzeExperience", () => {
	it("counts roles, tools, and span", () => {
		const a = analyzeExperience(fixture());
		expect(a.records).toBe(8);
		expect(a.by_role).toEqual({ user: 1, reasoning: 1, assistant: 5, tool: 1 });
		expect(a.span_ms).toBe(9000);
		expect(a.tools.calls).toBe(4);
		expect(a.tools.by_class).toEqual({ file_edit: 2, shell_exec: 1, unknown: 1 });
		expect(a.tools.errors).toBe(1);
	});

	it("derives guard, file, and ratio metrics from ix annotations", () => {
		const a = analyzeExperience(fixture());
		expect(a.guard).toEqual({ blocks: 1, warns: 0, top_rules: [["builtin-rm-rf", 1]] });
		expect(a.files).toEqual({ edit_events: 2, edited: 1, reworked: 1 });
		expect(a.tools.verification_runs).toBe(1);
		expect(a.ratios.verify_to_edit).toBe(0.5);
		// thinking 10 chars vs message 5 chars
		expect(a.ratios.think_to_message_chars).toBe(2);
	});

	it("returns null ratios and zero counts on an empty trajectory", () => {
		const a = analyzeExperience([]);
		expect(a.records).toBe(0);
		expect(a.span_ms).toBeNull();
		expect(a.ratios.verify_to_edit).toBeNull();
		expect(a.ratios.think_to_message_chars).toBeNull();
	});
});
