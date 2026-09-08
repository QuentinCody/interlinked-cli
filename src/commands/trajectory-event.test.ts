import { describe, expect, it } from "vitest";
import { isReplayEvent } from "./trajectory-event.js";

const event = {
	hook_event: "PostToolUse", session_id: "session", agent_source: "cli",
	timestamp: "2026-09-08T00:00:00.000Z", tool_name: "Write",
	tool_input: { file_path: "src/app.ts" }, future_evidence: { captured: true },
};

describe("recorded event validation", () => {
	it("retains unknown source names and additional evidence", () => {
		expect(isReplayEvent(event)).toBe(true);
		expect(event.agent_source).toBe("cli");
		expect(event.future_evidence).toEqual({ captured: true });
	});

	it.each([
		{ tool_input: [] }, { tool_name: 7 }, { files_modified: ["src/app.ts", false] },
		{ agent_role: "administrator" }, { dry_run: "false" }, { exit_code: "1" },
		{ tool_outcome: "done" }, { seq: Number.NaN }, { parent_tool_use_id: {} },
		{ sandbox_evidence: true },
	])("rejects malformed typed fields %j", (fields) => {
		expect(isReplayEvent({ ...event, ...fields })).toBe(false);
	});

	it("checks every nested file effect while accepting omitted historical mode metadata", () => {
		const effect = { path: "src/app.ts", kind: "modified", before_sha256: "old", after_sha256: "new" };
		const change_set = {
			source: "filesystem-observation", complete: true,
			before_captured_at: event.timestamp, after_captured_at: event.timestamp,
			files: [effect],
		};
		expect(isReplayEvent({ ...event, change_set })).toBe(true);
		expect(isReplayEvent({ ...event, change_set: { ...change_set, files: [{ ...effect, path: null }] } })).toBe(false);
		expect(isReplayEvent({ ...event, change_set: { ...change_set, files: [{ ...effect, before_mode: "0644" }] } })).toBe(false);
	});
});
