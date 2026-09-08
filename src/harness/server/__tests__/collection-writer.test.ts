import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCollectionLiveness } from "../../../lib/collection/liveness.js";
import { getCollectionPath } from "../../../lib/collection/writer.js";
import { nonNull } from "../../../lib/non-null.js";
import type { HarnessEvent } from "../../types.js";
import { mapEventToCollectionInput, writeCollectionRecord } from "../collection-writer.js";

function harnessEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess",
		agent_source: "claude",
		timestamp: "2026-06-01T12:00:00.000Z",
		...partial,
	};
}

describe("mapEventToCollectionInput — event_type derivation", () => {
	it("maps PreToolUse to tool_use_start", () => {
		const m = mapEventToCollectionInput(harnessEvent({ hook_event: "PreToolUse" }), "/repo");
		expect(m.event_type).toBe("tool_use_start");
	});

	it("maps Gemini BeforeTool to tool_use_start", () => {
		const m = mapEventToCollectionInput(harnessEvent({ hook_event: "BeforeTool" }), "/repo");
		expect(m.event_type).toBe("tool_use_start");
	});

	it("maps PostToolUseFailure to tool_use_error", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({ hook_event: "PostToolUseFailure" }),
			"/repo",
		);
		expect(m.event_type).toBe("tool_use_error");
	});

	it("maps PostToolUse / AfterTool to tool_use", () => {
		expect(
			mapEventToCollectionInput(harnessEvent({ hook_event: "PostToolUse" }), "/repo").event_type,
		).toBe("tool_use");
		expect(
			mapEventToCollectionInput(harnessEvent({ hook_event: "AfterTool" }), "/repo").event_type,
		).toBe("tool_use");
	});
});

describe("mapEventToCollectionInput — client runner detection", () => {
	it("detects codex from agent_source", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "codex" }), "/repo");
		expect(m.client_runner).toBe("codex");
		expect(m.cursor_version).toBeUndefined();
	});

	it("detects copilot from agent_source", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({ agent_source: "copilot" }),
			"/repo",
		);
		expect(m.client_runner).toBe("copilot");
	});

	it.each([
		["gemini", "gemini-cli"],
		["opencode", "opencode"],
		["pi", "pi"],
	] as const)("detects %s from agent_source", (agentSource, clientRunner) => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: agentSource }), "/repo");
		expect(m.client_runner).toBe(clientRunner);
	});

	it("detects cursor and sets cursor_version instead of client_runner", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "cursor" }), "/repo");
		expect(m.cursor_version).toBe("1");
		expect(m.client_runner).toBeUndefined();
	});

	it("omits both runner keys for plain claude", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "claude" }), "/repo");
		expect("client_runner" in m).toBe(false);
		expect("cursor_version" in m).toBe(false);
	});
});

describe("mapEventToCollectionInput — field carryover and cwd fallback", () => {
	it("prefers event.cwd over the fallback", () => {
		const m = mapEventToCollectionInput(harnessEvent({ cwd: "/explicit" }), "/fallback");
		expect(m.cwd).toBe("/explicit");
	});

	it("uses the fallback cwd when the event omits cwd", () => {
		const m = mapEventToCollectionInput(harnessEvent({}), "/fallback");
		expect(m.cwd).toBe("/fallback");
	});

	it("carries tool_name, tool_input, tool_use_id, and sha256 through", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({
				tool_name: "Read",
				tool_input: { file_path: "/a.ts" },
				tool_use_id: "tu_1",
				tool_response_sha256: "sha-1",
			}),
			"/repo",
		);
		expect(m.tool_name).toBe("Read");
		expect(m.tool_input).toEqual({ file_path: "/a.ts" });
		expect(m.tool_use_id).toBe("tu_1");
		expect(m.tool_response_sha256).toBe("sha-1");
		expect(m.session).toBe("sess");
		expect(m.ts).toBe("2026-06-01T12:00:00.000Z");
	});

	it("defaults tool_name to empty string and tool_input to {} when absent", () => {
		const m = mapEventToCollectionInput(harnessEvent({}), "/repo");
		expect(m.tool_name).toBe("");
		expect(m.tool_input).toEqual({});
	});

	it("carries agent_name through for multi-agent attribution, omitting it when absent", () => {
		expect(
			mapEventToCollectionInput(harnessEvent({ agent_name: "alice" }), "/repo").agent_name,
		).toBe("alice");
		expect("agent_name" in mapEventToCollectionInput(harnessEvent({}), "/repo")).toBe(false);
	});

	it("carries the acting subagent and model alongside the parent session", () => {
		expect(
			mapEventToCollectionInput(
				harnessEvent({
					session_id: "parent-session",
					subagent_id: "sub-thread",
					parent_agent: "parent-thread",
					model: "vendor-model-luna",
				}),
				"/repo",
			),
		).toMatchObject({
			session: "parent-session",
			subagent_id: "sub-thread",
			parent_agent: "parent-thread",
			model: "vendor-model-luna",
		});
	});
});

describe("writeCollectionRecord — end-to-end append", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "collection-writer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends a record for a tool event under the event's cwd", () => {
		const event = harnessEvent({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			tool_response: { stdout: "x", stderr: "", exitCode: 0 },
			cwd: dir,
			agent_name: "agent-7",
		});
		writeCollectionRecord(event, "/unused-fallback");
		const path = getCollectionPath(dir);
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines.length).toBe(1);
		const rec = JSON.parse(nonNull(lines[0]));
		expect(rec.schema).toBe("collection.v1");
		expect(rec.provider_tool).toBe("Bash");
		expect(rec.agent_name).toBe("agent-7");
	});

	it("does not throw and writes nothing for a lifecycle event", () => {
		const event = harnessEvent({ hook_event: "SessionStart", cwd: dir });
		expect(() => writeCollectionRecord(event, dir)).not.toThrow();
		// SessionStart maps to no tool event_type → builder returns null → no file.
		expect(existsSync(getCollectionPath(dir))).toBe(false);
	});

	it("is best-effort: never throws even on a malformed-ish event", () => {
		// Missing tool fields must not crash the writer.
		expect(() =>
			writeCollectionRecord(harnessEvent({ hook_event: "PreToolUse", cwd: dir }), dir),
		).not.toThrow();
	});
});

// The end-to-end "data collection is never silently broken" guard: a record
// written by the real daemon path must read back through the liveness check as
// a LIVE stream. If a future change breaks the write path (builder returns
// null, writer throws, wrong path), this fails — instead of the stream going
// stale unnoticed for days the way the legacy activity.jsonl did.
describe("writeCollectionRecord → getCollectionLiveness — never-broken guard", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "collection-live-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("a daemon-written record makes the stream read as LIVE, and ages into idle/stale", () => {
		// Pre-write: the exact state that went unnoticed for days.
		expect(getCollectionLiveness(dir).status).toBe("missing");

		const ts = "2026-06-01T12:00:00.000Z";
		const recMs = Date.parse(ts);
		writeCollectionRecord(
			harnessEvent({
				hook_event: "PostToolUse",
				session_id: "live-sess",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_response: { stdout: "x", stderr: "", exitCode: 0 },
				cwd: dir,
				timestamp: ts,
			}),
			dir,
		);

		// now = record ts + 5s → live (clock injected so the test is deterministic).
		const live = getCollectionLiveness(dir, { now: recMs + 5_000 });
		expect(live.status).toBe("live");
		expect(live.lastRecordTs).not.toBeNull();
		expect(live.sizeBytes).toBeGreaterThan(0);

		// Age the same record forward relative to its own ts → idle, then stale.
		expect(getCollectionLiveness(dir, { now: recMs + 10 * 60_000 }).status).toBe("idle");
		expect(getCollectionLiveness(dir, { now: recMs + 48 * 3_600_000 }).status).toBe("stale");
	});
});
