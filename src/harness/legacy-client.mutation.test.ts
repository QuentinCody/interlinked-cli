import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import type { UnifiedHookEvent } from "./unified-event.js";

// Mutation-hardening tests for legacy-client.ts. Same fake `node:net` approach
// as legacy-client.test.ts: no real sockets.

class FakeSocket extends EventEmitter {
	public destroyCalls = 0;
	write(_chunk: string): boolean {
		return true;
	}
	destroy(): this {
		this.destroyCalls += 1;
		return this;
	}
}

let lastSocket: FakeSocket | null = null;

vi.mock("node:net", () => ({
	createConnection: (_path: string, onConnect?: () => void) => {
		const sock = new FakeSocket();
		lastSocket = sock;
		if (onConnect) queueMicrotask(onConnect);
		return sock;
	},
}));

import { callLegacyHarness, toLegacyHarnessEvent } from "./legacy-client.js";

beforeEach(() => {
	vi.useFakeTimers();
	lastSocket = null;
});

afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

function makeEvent(overrides: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	const base: UnifiedHookEvent = {
		schema_version: "1",
		event_id: "evt-1",
		session_id: "s1",
		ts: "2026-05-05T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "src/a.ts" },
			tool_input_redacted: { file_path: "src/a.ts" },
		},
		context: { cwd: "/repo", agent: { id: "agent-a" } },
		raw: {},
	};
	return { ...base, ...overrides };
}

function makeOtherEvent(raw: Record<string, unknown>): UnifiedHookEvent {
	return makeEvent({
		runner_native_event: "TaskCompleted",
		phase: "other",
		action: { kind: "other", subkind: "TaskCompleted", data: {} },
		raw,
	});
}

describe("callLegacyHarness settle cleanup", () => {
	it("an explicit timeout_ms of 0 is honored and not replaced by the 5000 ms default", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makeEvent(), { timeout_ms: 0 });
		const rejection = expect(promise).rejects.toThrow("timeout");
		vi.advanceTimersByTime(1);
		await rejection;
	});

	it("clears the pending deadline timer once a decision resolves the call", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makeEvent(), { timeout_ms: 5000 });
		const socket = nonNull(lastSocket);
		expect(vi.getTimerCount()).toBe(1);
		socket.emit("data", Buffer.from(`${JSON.stringify({ decision: "allow" })}\n`));
		await expect(promise).resolves.toEqual({ decision: "allow" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("destroys the socket exactly once even when a late frame arrives after settling", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makeEvent(), { timeout_ms: 10 });
		const socket = nonNull(lastSocket);
		const rejection = expect(promise).rejects.toThrow("timeout");
		vi.advanceTimersByTime(10);
		await rejection;
		socket.emit("data", Buffer.from(`${JSON.stringify({ decision: "allow" })}\n`));
		socket.emit("close");
		expect(socket.destroyCalls).toBe(1);
	});
});

describe("toLegacyHarnessEvent delivery id (legacy-client.ts:112-114, framed per-delivery id)", () => {
	it("copies a non-empty event_id onto the legacy event", () => {
		expect(toLegacyHarnessEvent(makeEvent({ event_id: "evt-77" })).event_id).toBe("evt-77");
	});

	it("omits event_id when the unified event carries an empty one", () => {
		const legacy = toLegacyHarnessEvent(makeEvent({ event_id: "" }));
		expect("event_id" in legacy).toBe(false);
	});
});

describe("toLegacyHarnessEvent action fields", () => {
	it("omits the tool_response key when the tool_call action has none", () => {
		const legacy = toLegacyHarnessEvent(makeEvent());
		expect(Object.keys(legacy)).not.toContain("tool_response");
	});
});

describe("toLegacyHarnessEvent hook event name", () => {
	it("keeps a native PostToolUseFailure even though its phase is post-tool", () => {
		const legacy = toLegacyHarnessEvent(
			makeEvent({ runner_native_event: "PostToolUseFailure", phase: "post-tool" }),
		);
		expect(legacy.hook_event).toBe("PostToolUseFailure");
	});
});

describe("toLegacyHarnessEvent tool naming for Claude-style runners", () => {
	it("crush events use the Claude-style name of the normalized tool, ignoring raw.tool_name", () => {
		const legacy = toLegacyHarnessEvent(
			makeEvent({ runner: "crush", raw: { tool_name: "RawName" } }),
		);
		expect(legacy.tool_name).toBe("Edit");
	});
});

describe("toLegacyHarnessEvent lifecycle scalars", () => {
	it("skips empty-string lifecycle scalars", () => {
		expect(toLegacyHarnessEvent(makeOtherEvent({ task_id: "" })).tool_input).toBeUndefined();
	});

	it("keeps non-empty scalars while dropping empty ones in the same payload", () => {
		const legacy = toLegacyHarnessEvent(makeOtherEvent({ task_id: "", team_name: "red" }));
		expect(legacy.tool_input).toEqual({ team_name: "red" });
	});
});

describe("toLegacyHarnessEvent background_tasks", () => {
	it("carries background_tasks only when it is an array", () => {
		const tasks = [{ id: "b1", status: "running" }];
		const withArray = toLegacyHarnessEvent(makeEvent({ raw: { background_tasks: tasks } }));
		expect(withArray.background_tasks).toEqual(tasks);
		const withString = toLegacyHarnessEvent(makeEvent({ raw: { background_tasks: "nope" } }));
		expect(withString.background_tasks).toBeUndefined();
		const withObject = toLegacyHarnessEvent(makeEvent({ raw: { background_tasks: { a: 1 } } }));
		expect(withObject.background_tasks).toBeUndefined();
	});
});
