import { describe, expect, it } from "vitest";
import { buildCollectionRecord } from "../../../lib/collection/builder.js";
import type { CollectionRecord } from "../../../lib/collection/types.js";
import type { JsonObject } from "../../../lib/json-types.js";
import type { HarnessEvent } from "../../types.js";

// -------------------------------------------------------
// Helpers — mirror the HarnessEvent → JsonObject mapping
// from server.ts writeCollectionRecord()
// -------------------------------------------------------

/** Reproduce the exact mapping logic from server.ts writeCollectionRecord so
 *  tests validate the shape the builder receives. */
function mapHarnessEventToCollectionInput(event: HarnessEvent, cwd: string): JsonObject {
	let eventType: string;
	if (event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool") {
		eventType = "tool_use_start";
	} else if (event.hook_event === "PostToolUseFailure") {
		eventType = "tool_use_error";
	} else {
		eventType = "tool_use";
	}

	let clientRunner: string | undefined;
	let cursorVersion: string | undefined;
	const src = event.agent_source ?? "";
	if (src.includes("codex")) clientRunner = "codex";
	else if (src.includes("copilot")) clientRunner = "copilot";
	else if (src.includes("cursor")) cursorVersion = "1";

	return {
		event_type: eventType,
		ts: event.timestamp,
		hook_event: event.hook_event,
		session: event.session_id,
		tool_name: event.tool_name ?? "",
		tool_input: event.tool_input ?? {},
		tool_response: event.tool_response as JsonObject | undefined,
		tool_use_id: event.tool_use_id,
		cwd: event.cwd ?? cwd,
		tool_response_sha256: event.tool_response_sha256,
		...(clientRunner ? { client_runner: clientRunner } : {}),
		...(cursorVersion ? { cursor_version: cursorVersion } : {}),
	};
}

function harnessEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "test-session",
		agent_source: "claude",
		timestamp: "2026-05-19T12:00:00.000Z",
		...partial,
	};
}

// -------------------------------------------------------
// PostToolUse mapping
// -------------------------------------------------------
describe("HarnessEvent → collection record mapping (PostToolUse)", () => {
	function bashPostRecord(): CollectionRecord {
		const event = harnessEvent({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
			cwd: "/repo",
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/fallback");
		const record = buildCollectionRecord(mapped);
		expect(record).not.toBeNull();
		return record!;
	}

	it("sets schema and phase on a Bash PostToolUse", () => {
		const rec = bashPostRecord();
		expect(rec.schema).toBe("collection.v1");
		expect(rec.phase).toBe("post");
	});

	it("classifies Bash as shell_exec", () => {
		const rec = bashPostRecord();
		expect(rec.tool_class).toBe("shell_exec");
		expect(rec.provider_tool).toBe("Bash");
	});

	it("maps session_id and ts from HarnessEvent fields", () => {
		const rec = bashPostRecord();
		expect(rec.session_id).toBe("test-session");
		expect(rec.ts).toBe("2026-05-19T12:00:00.000Z");
	});

	it("uses event.cwd over fallback", () => {
		const rec = bashPostRecord();
		expect(rec.cwd).toBe("/repo");
	});

	it("extracts shell action and observation", () => {
		const rec = bashPostRecord();
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
		expect(rec.observation).toMatchObject({ stdout: "ok", exit_code: 0 });
	});

	it("maps Edit PostToolUse with diff hunks", () => {
		const event = harnessEvent({
			tool_name: "Edit",
			tool_input: { file_path: "/src/main.ts", old_string: "foo", new_string: "bar" },
			tool_response: "applied",
		});

		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		const record = buildCollectionRecord(mapped)!;

		expect(record.tool_class).toBe("file_edit");
		expect(record.action).toEqual({
			path: "/src/main.ts",
			diff: { hunks: [{ old: "foo", new: "bar" }], unified: null },
		});
	});

	it("maps PostToolUseFailure as tool_use_error phase", () => {
		const event = harnessEvent({
			hook_event: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "false" },
			tool_response: { stderr: "exit 1" },
		});

		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(mapped.event_type).toBe("tool_use_error");

		const record = buildCollectionRecord(mapped)!;
		expect(record).not.toBeNull();
		expect(record.phase).toBe("post");
	});

	it("uses fallback cwd when event.cwd is absent", () => {
		const event = harnessEvent({ tool_name: "Read", tool_input: { file_path: "/a.ts" } });
		const mapped = mapHarnessEventToCollectionInput(event, "/fallback-cwd");
		const record = buildCollectionRecord(mapped)!;
		expect(record.cwd).toBe("/fallback-cwd");
	});
});

// -------------------------------------------------------
// PreToolUse mapping
// -------------------------------------------------------
describe("HarnessEvent → collection record mapping (PreToolUse)", () => {
	it("produces a pre-phase record for PreToolUse", () => {
		const event = harnessEvent({
			hook_event: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /tmp/junk" },
			cwd: "/repo",
		});

		const mapped = mapHarnessEventToCollectionInput(event, "/fallback");
		expect(mapped.event_type).toBe("tool_use_start");

		const record = buildCollectionRecord(mapped)!;
		expect(record).not.toBeNull();
		expect(record.phase).toBe("pre");
		expect(record.observation).toBeNull();
		expect(record.action).toEqual({ command: "rm -rf /tmp/junk", cwd: "/repo" });
	});

	it("produces a pre-phase record for Gemini BeforeTool", () => {
		const event = harnessEvent({
			hook_event: "BeforeTool",
			agent_source: "gemini" as HarnessEvent["agent_source"],
			tool_name: "Read",
			tool_input: { file_path: "/src/index.ts" },
		});

		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(mapped.event_type).toBe("tool_use_start");

		const record = buildCollectionRecord(mapped)!;
		expect(record).not.toBeNull();
		expect(record.phase).toBe("pre");
		expect(record.provider).toBe("gemini-cli");
	});
});

// -------------------------------------------------------
// Lifecycle events must NOT produce records
// -------------------------------------------------------
describe("HarnessEvent → collection record mapping (lifecycle skips)", () => {
	it("returns null for SessionStart", () => {
		const event = harnessEvent({ hook_event: "SessionStart" });
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		// event_type won't match any tool event type
		expect(buildCollectionRecord(mapped)).toBeNull();
	});

	it("returns null for SessionEnd", () => {
		const event = harnessEvent({ hook_event: "SessionEnd" });
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(buildCollectionRecord(mapped)).toBeNull();
	});

	it("returns null for Stop", () => {
		const event = harnessEvent({ hook_event: "Stop" });
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(buildCollectionRecord(mapped)).toBeNull();
	});

	it("returns null for UserPromptSubmit", () => {
		const event = harnessEvent({ hook_event: "UserPromptSubmit" });
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(buildCollectionRecord(mapped)).toBeNull();
	});
});

// -------------------------------------------------------
// Provider detection from agent_source
// -------------------------------------------------------
describe("HarnessEvent → collection record provider detection", () => {
	it("defaults to claude-code for agent_source=claude", () => {
		const event = harnessEvent({ agent_source: "claude", tool_name: "Bash", tool_input: { command: "ls" } });
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider).toBe("claude-code");
	});

	it("detects codex from agent_source", () => {
		const event = harnessEvent({
			agent_source: "codex",
			tool_name: "apply_patch",
			tool_input: { command: "*** Update File: /a.ts\n@@ -1,1 +1,1 @@\n-old\n+new" },
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(mapped.client_runner).toBe("codex");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider).toBe("codex");
	});

	it("detects copilot from agent_source", () => {
		const event = harnessEvent({
			agent_source: "copilot" as HarnessEvent["agent_source"],
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(mapped.client_runner).toBe("copilot");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider).toBe("copilot");
	});

	it("detects cursor from agent_source", () => {
		const event = harnessEvent({
			agent_source: "cursor",
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		expect(mapped.cursor_version).toBe("1");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider).toBe("cursor");
	});

	it("detects gemini via hook_event BeforeTool", () => {
		const event = harnessEvent({
			hook_event: "BeforeTool",
			agent_source: "gemini" as HarnessEvent["agent_source"],
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider).toBe("gemini-cli");
	});
});

// -------------------------------------------------------
// Field carryover (tool_use_id, tool_response_sha256)
// -------------------------------------------------------
describe("HarnessEvent → collection record field carryover", () => {
	it("carries tool_use_id through to the record", () => {
		const event = harnessEvent({
			tool_name: "Read",
			tool_input: { file_path: "/a.ts" },
			tool_use_id: "tu_abc123",
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		const record = buildCollectionRecord(mapped)!;
		expect(record.tool_use_id).toBe("tu_abc123");
	});

	it("carries tool_response_sha256 through to provider_raw", () => {
		const event = harnessEvent({
			tool_name: "Read",
			tool_input: { file_path: "/a.ts" },
			tool_response: "content",
			tool_response_sha256: "sha256-abc",
		});
		const mapped = mapHarnessEventToCollectionInput(event, "/repo");
		const record = buildCollectionRecord(mapped)!;
		expect(record.provider_raw.tool_response_sha256).toBe("sha256-abc");
	});
});
