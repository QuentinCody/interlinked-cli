import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "./types.js";
import type { UnifiedAction, UnifiedHookEvent } from "./unified-event.js";

// ---------------------------------------------------------------------------
// Deterministic fake `node:net` socket. No real sockets, no real fs.
// `createConnection(path, onConnect)` returns a FakeSocket (an EventEmitter);
// the connect callback is invoked synchronously so each test drives the
// data/error/close lifecycle by hand via `emit(...)`.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
	public written: string[] = [];
	public destroyed = false;
	write(chunk: string): boolean {
		this.written.push(chunk);
		return true;
	}
	destroy(): this {
		this.destroyed = true;
		return this;
	}
}

let lastSocket: FakeSocket | null = null;
let lastConnectPath: string | null = null;
const createConnectionMock = vi.fn(
	(path: string, onConnect?: () => void): FakeSocket => {
		lastConnectPath = path;
		const sock = new FakeSocket();
		lastSocket = sock;
		// Real node:net invokes the connect listener asynchronously, *after*
		// `socket = createConnection(...)` has assigned the local. Mirroring
		// that with a microtask is load-bearing: the source's connect callback
		// reads the outer `socket` variable, which is still null synchronously.
		if (onConnect) queueMicrotask(onConnect);
		return sock;
	},
);

/** Flush pending microtasks (lets the deferred connect callback run). */
const flushMicrotasks = (): Promise<void> => Promise.resolve();

vi.mock("node:net", () => ({
	createConnection: (path: string, onConnect?: () => void) =>
		createConnectionMock(path, onConnect),
}));

// Import under test AFTER the mock is registered.
import {
	callLegacyHarness,
	DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS,
	isLegacyHarnessSocket,
	LEGACY_HARNESS_SOCKET_BASENAME,
	toLegacyHarnessEvent,
} from "./legacy-client.js";

beforeEach(() => {
	vi.useFakeTimers();
	lastSocket = null;
	lastConnectPath = null;
	createConnectionMock.mockClear();
});

afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

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
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_input_redacted: { file_path: "src/a.ts" },
		},
		context: { cwd: "/repo", agent: { id: "agent-a" } },
		raw: {},
	};
	return { ...base, ...overrides };
}

function makePreEditEvent(): UnifiedHookEvent {
	return makeEvent({
		raw: {
			session_id: "s1",
			cwd: "/repo",
			tool_name: "Edit",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			tool_use_id: "tool-1",
		},
	});
}

// ===========================================================================
// constants
// ===========================================================================

describe("legacy-client constants", () => {
	it("exposes the repo-scoped socket basename and the default timeout", () => {
		expect(LEGACY_HARNESS_SOCKET_BASENAME).toBe("harness.sock");
		expect(DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS).toBe(5000);
	});
});

// ===========================================================================
// isLegacyHarnessSocket
// ===========================================================================

describe("isLegacyHarnessSocket", () => {
	it("returns true only for the repo-scoped legacy socket basename", () => {
		expect(isLegacyHarnessSocket("/var/run/.interlinked/harness.sock")).toBe(true);
		expect(isLegacyHarnessSocket("harness.sock")).toBe(true);
	});
	it("returns false for per-session and unrelated socket names", () => {
		expect(isLegacyHarnessSocket("/x/harness-s1.sock")).toBe(false);
		expect(isLegacyHarnessSocket("/x/session-daemon.sock")).toBe(false);
		expect(isLegacyHarnessSocket("/x/harness.sock.bak")).toBe(false);
	});
});

// ===========================================================================
// callLegacyHarness — socket lifecycle
// ===========================================================================

describe("callLegacyHarness", () => {
	it("connects to the given path and writes the newline-framed payload on connect", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		expect(createConnectionMock).toHaveBeenCalledTimes(1);
		expect(lastConnectPath).toBe("/repo/harness.sock");
		const socket = lastSocket as FakeSocket;
		await flushMicrotasks();
		expect(socket.written).toHaveLength(1);
		const framed = socket.written[0] as string;
		expect(framed.endsWith("\n")).toBe(true);
		const sent = JSON.parse(framed.slice(0, -1)) as HarnessEvent;
		expect(sent.hook_event).toBe("PreToolUse");
		expect(sent.tool_name).toBe("Edit");
		expect("id" in sent).toBe(false);
		expect("method" in sent).toBe(false);

		const decision: HarnessDecision = { decision: "allow", warnings: ["w"] };
		socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n`));
		await expect(promise).resolves.toEqual(decision);
		// finish() must clean up the socket and clear the timer.
		expect(socket.destroyed).toBe(true);
	});

	it("uses DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS when no timeout is supplied", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent());
		const socket = lastSocket as FakeSocket;
		// Just before the default deadline: still pending.
		vi.advanceTimersByTime(DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS - 1);
		const decision: HarnessDecision = { decision: "block", reason: "no" };
		socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n`));
		await expect(promise).resolves.toEqual(decision);
	});

	it("buffers partial frames and resolves once the newline arrives", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const decision: HarnessDecision = { decision: "allow" };
		const full = `${JSON.stringify(decision)}\n`;
		const mid = Math.floor(full.length / 2);
		// First chunk has no newline -> handler returns early (newlineIdx === -1).
		socket.emit("data", Buffer.from(full.slice(0, mid), "utf-8"));
		expect(socket.destroyed).toBe(false);
		// Second chunk completes the line.
		socket.emit("data", Buffer.from(full.slice(mid), "utf-8"));
		await expect(promise).resolves.toEqual(decision);
		expect(socket.destroyed).toBe(true);
	});

	it("parses only the first line and ignores trailing bytes after the newline", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const decision: HarnessDecision = { decision: "ask", reason: "confirm?" };
		socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n{"decision":"block"}\n`));
		await expect(promise).resolves.toEqual(decision);
	});

	it("rejects with the JSON SyntaxError when the response line is not valid JSON", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit("data", Buffer.from("not json at all\n"));
		// JSON.parse throws a SyntaxError (an Error), so the ternary keeps `err`.
		await expect(promise).rejects.toThrowError(SyntaxError);
		expect(socket.destroyed).toBe(true);
	});

	it("wraps a non-Error parse throw into 'invalid legacy harness response: <value>'", async () => {
		// JSON.parse only ever throws a SyntaxError, so the defensive
		// `: new Error(...)` branch is unreachable via the real parser. Stub
		// JSON.parse to throw a bare string to drive that branch — a test-only
		// stub, restored immediately after, never touching source.
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
			throw "raw-string-failure";
		});
		try {
			const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
				timeout_ms: 250,
			});
			const socket = lastSocket as FakeSocket;
			socket.emit("data", Buffer.from('{"decision":"allow"}\n'));
			await expect(promise).rejects.toThrow(
				"invalid legacy harness response: raw-string-failure",
			);
			expect(socket.destroyed).toBe(true);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("rejects when the socket emits an error before a response", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const boom = new Error("ECONNREFUSED");
		socket.emit("error", boom);
		await expect(promise).rejects.toBe(boom);
		expect(socket.destroyed).toBe(true);
	});

	it("rejects with 'socket closed' when the socket closes before settling", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit("close");
		await expect(promise).rejects.toThrow("socket closed");
		expect(socket.destroyed).toBe(true);
	});

	it("does not reject on close once already settled (the !settled guard)", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const decision: HarnessDecision = { decision: "allow" };
		socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n`));
		await expect(promise).resolves.toEqual(decision);
		// A late close after resolution must be a no-op (no unhandled rejection).
		expect(() => socket.emit("close")).not.toThrow();
	});

	it("rejects with 'timeout' when no response arrives before the deadline", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 25,
		});
		const socket = lastSocket as FakeSocket;
		const rejection = expect(promise).rejects.toThrow("timeout");
		vi.advanceTimersByTime(25);
		await rejection;
		expect(socket.destroyed).toBe(true);
	});

	it("ignores a data frame that arrives after a timeout (settled short-circuit)", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 25,
		});
		const socket = lastSocket as FakeSocket;
		const rejection = expect(promise).rejects.toThrow("timeout");
		vi.advanceTimersByTime(25);
		await rejection;
		// Late data must not throw or flip the already-settled promise.
		expect(() =>
			socket.emit("data", Buffer.from(`${JSON.stringify({ decision: "allow" })}\n`)),
		).not.toThrow();
	});

	// parseHarnessDecision — direct boundary-parser coverage (replaces
	// `JSON.parse(line) as HarnessDecision`), exercised through the only
	// public entry point that calls it.
	it("P1: keeps every field this bridge's consumer reads (reason/warnings/rule_id/additional_context/resolved_targets)", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		const decision = {
			decision: "ask",
			reason: "confirm?",
			warnings: ["w1", "w2"],
			rule_id: "rule-9",
			additional_context: "extra context",
			resolved_targets: [{ kind: "file", value: "src/a.ts" }],
		};
		socket.emit("data", Buffer.from(`${JSON.stringify(decision)}\n`));
		await expect(promise).resolves.toEqual(decision);
	});

	it("N1: a response line that parses as JSON but has no valid decision field rejects instead of silently resolving", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		// Old cast behavior: this "resolved" with `decision: undefined`, which
		// every adapter's `=== "block"` / `=== "ask"` check then silently read
		// as an implicit allow. The new parser rejects the whole line instead.
		socket.emit("data", Buffer.from(`${JSON.stringify({ reason: "no decision field" })}\n`));
		await expect(promise).rejects.toThrow("malformed legacy harness decision");
	});

	it("N2: an unrecognized decision literal rejects (not just a missing field)", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit("data", Buffer.from(`${JSON.stringify({ decision: "maybe" })}\n`));
		await expect(promise).rejects.toThrow("malformed legacy harness decision");
	});

	it("N3: drops a resolved_targets entry with an unrecognized kind, keeping the valid ones", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					decision: "ask",
					resolved_targets: [
						{ kind: "file", value: "a.ts" },
						{ kind: "not-a-real-kind", value: "b.ts" },
					],
				})}\n`,
			),
		);
		const resolved = await promise;
		expect(resolved.resolved_targets).toEqual([{ kind: "file", value: "a.ts" }]);
	});

	it("N4: drops non-string entries from warnings, keeping the strings", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(`${JSON.stringify({ decision: "allow", warnings: ["ok", 42, "also-ok"] })}\n`),
		);
		const resolved = await promise;
		expect(resolved.warnings).toEqual(["ok", "also-ok"]);
	});

	it("N5: drops fields this bridge never reads (e.g. check_results) rather than forwarding them untyped", async () => {
		const promise = callLegacyHarness("/repo/harness.sock", makePreEditEvent(), {
			timeout_ms: 250,
		});
		const socket = lastSocket as FakeSocket;
		socket.emit(
			"data",
			Buffer.from(
				`${JSON.stringify({
					decision: "allow",
					check_results: [{ source: "quality", name: "x" }],
				})}\n`,
			),
		);
		const resolved = await promise;
		expect(resolved).toEqual({ decision: "allow" });
	});
});

// ===========================================================================
// toLegacyHarnessEvent — base envelope + field copying
// ===========================================================================

describe("toLegacyHarnessEvent base mapping", () => {
	it("maps a Claude PreToolUse edit into the raw HarnessEvent shape (no RPC envelope)", () => {
		const legacy = toLegacyHarnessEvent(makePreEditEvent());
		expect(legacy).toMatchObject<Partial<HarnessEvent>>({
			hook_event: "PreToolUse",
			session_id: "s1",
			agent_source: "claude",
			agent_name: "agent-a",
			tool_name: "Edit",
			tool_use_id: "tool-1",
			cwd: "/repo",
			timestamp: "2026-05-05T00:00:00.000Z",
			tool_input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
		});
		expect("id" in legacy).toBe(false);
		expect("method" in legacy).toBe(false);
	});

	it("carries the request-owned PostTool warning delivery token into the raw event", () => {
		const legacy = toLegacyHarnessEvent(
			makeEvent({
				post_delivery_token: "delivery-token-0001",
				post_delivery_pid: 4242,
				phase: "post-tool",
			}),
		);
		expect(legacy.post_delivery_token).toBe("delivery-token-0001");
		expect(legacy.post_delivery_pid).toBe(4242);
	});

	it("falls back to a {} raw object when event.raw is not a JSON object", () => {
		const ev = makeEvent({
			raw: "this is a string, not an object",
			context: { cwd: "/repo" },
			action: { kind: "session_lifecycle", event: "start" },
			phase: "session-start",
			runner_native_event: "SessionStart",
		});
		const legacy = toLegacyHarnessEvent(ev);
		// No agent id and no raw.agent_name -> agent_name omitted.
		expect("agent_name" in legacy).toBe(false);
		expect(legacy.hook_event).toBe("SessionStart");
		expect("tool_name" in legacy).toBe(false);
	});

	it("reads agent_name from raw when context.agent.id is absent", () => {
		const ev = makeEvent({
			context: { cwd: "/repo" },
			raw: { agent_name: "raw-agent" },
		});
		expect(toLegacyHarnessEvent(ev).agent_name).toBe("raw-agent");
	});

	it("prefers context.agent.id over raw.agent_name", () => {
		const ev = makeEvent({
			context: { cwd: "/repo", agent: { id: "ctx-agent" } },
			raw: { agent_name: "raw-agent" },
		});
		expect(toLegacyHarnessEvent(ev).agent_name).toBe("ctx-agent");
	});

	it("omits agent_name when neither context.agent.id nor raw.agent_name resolve", () => {
		const ev = makeEvent({
			context: { cwd: "/repo", agent: { handle: "h" } },
			raw: { agent_name: 123 },
		});
		expect("agent_name" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	it("copies all six optional string fields when present and string-typed", () => {
		const ev = makeEvent({
			raw: {
				model: "opus",
				transcript_path: "/t.jsonl",
				tool_use_id: "tu-9",
				parent_agent: "p",
				subagent_id: "sa",
				agent_type: "researcher",
			},
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect(legacy.model).toBe("opus");
		expect(legacy.transcript_path).toBe("/t.jsonl");
		expect(legacy.tool_use_id).toBe("tu-9");
		expect(legacy.parent_agent).toBe("p");
		expect(legacy.subagent_id).toBe("sa");
		expect(legacy.agent_type).toBe("researcher");
	});

	it("prefers normalized metadata over provider-specific raw fields", () => {
		const ev = makeEvent({
			turn_id: "turn-normalized",
			tool_use_id: "tool-normalized",
			context: {
				cwd: "/repo",
				model: "model-normalized",
				transcript_path: "/normalized.jsonl",
			},
			raw: {
				model: "model-raw",
				transcript_path: "/raw.jsonl",
				tool_use_id: "tool-raw",
			},
		});
		expect(toLegacyHarnessEvent(ev)).toMatchObject({
			model: "model-normalized",
			transcript_path: "/normalized.jsonl",
			tool_use_id: "tool-normalized",
			prompt_id: "turn-normalized",
		});
	});

	it("copies subagent result fields (last_assistant_message / agent_transcript_path)", () => {
		const ev = makeEvent({
			runner_native_event: "SubagentStop",
			phase: "subagent-stop",
			action: { kind: "other", subkind: "SubagentStop", data: {} },
			raw: {
				last_assistant_message: "There are 3 R's in Strawberry.",
				agent_transcript_path: "/proj/sess/subagents/agent-af.jsonl",
			},
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect(legacy.hook_event).toBe("SubagentStop");
		expect(legacy.last_assistant_message).toBe("There are 3 R's in Strawberry.");
		expect(legacy.agent_transcript_path).toBe("/proj/sess/subagents/agent-af.jsonl");
	});

	it("maps Claude-native agent_id / parent_agent_name onto subagent_id / parent_agent", () => {
		const ev = makeEvent({
			runner_native_event: "SubagentStop",
			phase: "subagent-stop",
			action: { kind: "other", subkind: "SubagentStop", data: {} },
			raw: { agent_id: "af2124f", parent_agent_name: "Lead-Alpha", agent_type: "Explore" },
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect(legacy.subagent_id).toBe("af2124f");
		expect(legacy.parent_agent).toBe("Lead-Alpha");
		expect(legacy.agent_type).toBe("Explore");
	});

	it("canonical subagent_id / parent_agent win over the native-name fallbacks", () => {
		const ev = makeEvent({
			raw: {
				subagent_id: "canonical-id",
				agent_id: "native-id",
				parent_agent: "canonical-parent",
				parent_agent_name: "native-parent",
			},
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect(legacy.subagent_id).toBe("canonical-id");
		expect(legacy.parent_agent).toBe("canonical-parent");
	});

	it("carries lifecycle scalars into tool_input for other-kind events (TaskCompleted)", () => {
		const ev = makeEvent({
			runner_native_event: "TaskCompleted",
			phase: "other",
			action: { kind: "other", subkind: "TaskCompleted", data: {} },
			raw: { task_id: "t1", task_subject: "ship it", teammate_name: "w2", ignored_key: "x" },
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect(legacy.hook_event).toBe("TaskCompleted");
		expect(legacy.tool_input).toEqual({ task_id: "t1", task_subject: "ship it", teammate_name: "w2" });
	});

	it("leaves tool_input absent for other-kind events with no lifecycle scalars", () => {
		const ev = makeEvent({
			runner_native_event: "Notification",
			phase: "notification",
			action: { kind: "other", subkind: "Notification", data: {} },
			raw: { message: "hello" },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toBeUndefined();
	});

	it("skips optional string fields when present but not string-typed", () => {
		const ev = makeEvent({
			raw: {
				model: 1,
				transcript_path: null,
				tool_use_id: {},
				parent_agent: [],
				subagent_id: false,
				agent_type: 0,
			},
		});
		const legacy = toLegacyHarnessEvent(ev);
		expect("model" in legacy).toBe(false);
		expect("transcript_path" in legacy).toBe(false);
		// tool_use_id may be re-derived later only from string values; non-string -> absent.
		expect("tool_use_id" in legacy).toBe(false);
		expect("parent_agent" in legacy).toBe(false);
		expect("subagent_id" in legacy).toBe(false);
		expect("agent_type" in legacy).toBe(false);
	});

	it("copies files_modified when it is a non-empty string array, dropping non-strings", () => {
		const ev = makeEvent({ raw: { files_modified: ["a.ts", 2, "b.ts", null] } });
		expect(toLegacyHarnessEvent(ev).files_modified).toEqual(["a.ts", "b.ts"]);
	});

	it("omits files_modified when not an array", () => {
		const ev = makeEvent({ raw: { files_modified: "a.ts" } });
		expect("files_modified" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	it("omits files_modified when the array has no string entries", () => {
		const ev = makeEvent({ raw: { files_modified: [1, 2, 3] } });
		expect("files_modified" in toLegacyHarnessEvent(ev)).toBe(false);
	});
});

// ===========================================================================
// toLegacyHarnessEvent — action variants
// ===========================================================================

describe("toLegacyHarnessEvent action variants", () => {
	it("tool_call: copies tool_response when defined", () => {
		const action: UnifiedAction = {
			kind: "tool_call",
			tool_name: "bash",
			tool_class: "side-effect",
			tool_input: { command: "ls" },
			tool_input_redacted: { command: "ls" },
			tool_response: { stdout: "ok" },
		};
		const legacy = toLegacyHarnessEvent(makeEvent({ action }));
		expect(legacy.tool_name).toBe("Bash");
		expect(legacy.tool_input).toEqual({ command: "ls" });
		expect(legacy.tool_response).toEqual({ stdout: "ok" });
	});

	it("tool_call: defaults tool_input to {} when action.tool_input is not an object", () => {
		const action: UnifiedAction = {
			kind: "tool_call",
			tool_name: "read",
			tool_class: "read",
			tool_input: "not-an-object",
			tool_input_redacted: null,
		};
		const legacy = toLegacyHarnessEvent(makeEvent({ action, raw: {} }));
		expect(legacy.tool_input).toEqual({});
	});

	it("shell_command: forces Bash and compacts undefined cwd out of tool_input", () => {
		const withCwd = toLegacyHarnessEvent(
			makeEvent({
				action: { kind: "shell_command", command: "echo hi", cwd: "/work", tool_class: "side-effect" },
			}),
		);
		expect(withCwd.tool_name).toBe("Bash");
		expect(withCwd.tool_input).toEqual({ command: "echo hi", cwd: "/work" });

		const noCwd = toLegacyHarnessEvent(
			makeEvent({
				action: { kind: "shell_command", command: "echo hi", tool_class: "side-effect" },
			}),
		);
		expect(noCwd.tool_input).toEqual({ command: "echo hi" });
		expect("cwd" in (noCwd.tool_input as object)).toBe(false);
	});

	it("file_operation read/write/edit map to Read/Write/Edit with compacted input", () => {
		const read = toLegacyHarnessEvent(
			makeEvent({
				action: { kind: "file_operation", operation: "read", path: "/f.ts", tool_class: "read" },
			}),
		);
		expect(read.tool_name).toBe("Read");
		expect(read.tool_input).toEqual({ file_path: "/f.ts" });

		const write = toLegacyHarnessEvent(
			makeEvent({
				action: {
					kind: "file_operation",
					operation: "write",
					path: "/f.ts",
					content: "hello",
					tool_class: "modify",
				},
			}),
		);
		expect(write.tool_name).toBe("Write");
		expect(write.tool_input).toEqual({ file_path: "/f.ts", content: "hello" });

		const edit = toLegacyHarnessEvent(
			makeEvent({
				action: {
					kind: "file_operation",
					operation: "edit",
					path: "/f.ts",
					old_string: "x",
					new_string: "y",
					tool_class: "modify",
				},
			}),
		);
		expect(edit.tool_name).toBe("Edit");
		expect(edit.tool_input).toEqual({ file_path: "/f.ts", old_string: "x", new_string: "y" });
	});

	it("file_operation delete maps to Bash with an rm command", () => {
		const del = toLegacyHarnessEvent(
			makeEvent({
				action: { kind: "file_operation", operation: "delete", path: "/f.ts", tool_class: "side-effect" },
			}),
		);
		expect(del.tool_name).toBe("Bash");
		expect(del.tool_input).toEqual({ command: "rm /f.ts" });
	});

	it("user_prompt: sets prompt from the action text", () => {
		const legacy = toLegacyHarnessEvent(
			makeEvent({
				phase: "user-prompt",
				runner_native_event: "UserPromptSubmit",
				action: { kind: "user_prompt", text: "do the thing" },
			}),
		);
		expect(legacy.prompt).toBe("do the thing");
		expect("tool_name" in legacy).toBe(false);
	});

	it("session_lifecycle and other actions set no tool fields", () => {
		const lifecycle = toLegacyHarnessEvent(
			makeEvent({
				phase: "session-end",
				runner_native_event: "SessionEnd",
				action: { kind: "session_lifecycle", event: "end" },
				raw: {},
			}),
		);
		expect("tool_name" in lifecycle).toBe(false);
		expect("tool_input" in lifecycle).toBe(false);

		const other = toLegacyHarnessEvent(
			makeEvent({
				phase: "other",
				runner_native_event: "Notification",
				action: { kind: "other", subkind: "ping", data: { x: 1 } },
				raw: {},
			}),
		);
		expect("tool_name" in other).toBe(false);
	});
});

// ===========================================================================
// toLegacyHarnessEvent — raw fallbacks (tool_input / tool_response / prompt)
// ===========================================================================

describe("toLegacyHarnessEvent raw fallbacks", () => {
	it("derives tool_input from raw.tool_input when the action set none", () => {
		const ev = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
			phase: "session-start",
			runner_native_event: "SessionStart",
			raw: { tool_input: { file_path: "/x" } },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toEqual({ file_path: "/x" });
	});

	it("derives tool_input from raw.toolInput (camelCase) when raw.tool_input is absent", () => {
		const ev = makeEvent({
			action: { kind: "other", subkind: "x", data: null },
			phase: "other",
			runner_native_event: "Notification",
			raw: { toolInput: { a: 1 } },
		});
		expect(toLegacyHarnessEvent(ev).tool_input).toEqual({ a: 1 });
	});

	it("leaves tool_input undefined when neither raw key is an object", () => {
		const ev = makeEvent({
			action: { kind: "other", subkind: "x", data: null },
			phase: "other",
			runner_native_event: "Notification",
			raw: { tool_input: "str", toolInput: 5 },
		});
		expect("tool_input" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	it("derives tool_response from raw.tool_response when the action carried none", () => {
		const ev = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "bash",
				tool_class: "side-effect",
				tool_input: { command: "ls" },
				tool_input_redacted: { command: "ls" },
			},
			raw: { tool_response: { stdout: "raw" } },
		});
		expect(toLegacyHarnessEvent(ev).tool_response).toEqual({ stdout: "raw" });
	});

	it("derives tool_response from raw.toolResponse (camelCase) when snake is absent", () => {
		const ev = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "bash",
				tool_class: "side-effect",
				tool_input: { command: "ls" },
				tool_input_redacted: { command: "ls" },
			},
			raw: { toolResponse: "camel" },
		});
		expect(toLegacyHarnessEvent(ev).tool_response).toBe("camel");
	});

	it("prefers action tool_response over both raw fallbacks", () => {
		const ev = makeEvent({
			action: {
				kind: "tool_call",
				tool_name: "bash",
				tool_class: "side-effect",
				tool_input: { command: "ls" },
				tool_input_redacted: { command: "ls" },
				tool_response: "from-action",
			},
			raw: { tool_response: "snake", toolResponse: "camel" },
		});
		expect(toLegacyHarnessEvent(ev).tool_response).toBe("from-action");
	});

	it("derives prompt from raw.prompt / raw.message / raw.userPrompt in priority order", () => {
		const lifecycleAction: UnifiedAction = { kind: "session_lifecycle", event: "start" };
		const fromPrompt = toLegacyHarnessEvent(
			makeEvent({
				action: lifecycleAction,
				phase: "session-start",
				runner_native_event: "SessionStart",
				raw: { prompt: "p", message: "m", userPrompt: "u" },
			}),
		);
		expect(fromPrompt.prompt).toBe("p");

		const fromMessage = toLegacyHarnessEvent(
			makeEvent({
				action: lifecycleAction,
				phase: "session-start",
				runner_native_event: "SessionStart",
				raw: { message: "m", userPrompt: "u" },
			}),
		);
		expect(fromMessage.prompt).toBe("m");

		const fromUserPrompt = toLegacyHarnessEvent(
			makeEvent({
				action: lifecycleAction,
				phase: "session-start",
				runner_native_event: "SessionStart",
				raw: { userPrompt: "u" },
			}),
		);
		expect(fromUserPrompt.prompt).toBe("u");
	});

	it("leaves prompt undefined when no raw prompt field is a string", () => {
		const ev = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
			phase: "session-start",
			runner_native_event: "SessionStart",
			raw: { prompt: 1, message: null, userPrompt: {} },
		});
		expect("prompt" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	it("does not overwrite a prompt already set by the user_prompt action", () => {
		const ev = makeEvent({
			phase: "user-prompt",
			runner_native_event: "UserPromptSubmit",
			action: { kind: "user_prompt", text: "action-text" },
			raw: { prompt: "raw-text" },
		});
		expect(toLegacyHarnessEvent(ev).prompt).toBe("action-text");
	});
});

// ===========================================================================
// legacyHookEventName (via toLegacyHarnessEvent.hook_event)
// ===========================================================================

describe("legacyHookEventName mapping", () => {
	it("returns the native event verbatim when it is a recognized legacy event", () => {
		const ev = makeEvent({ runner_native_event: "PreCompact", phase: "other" });
		expect(toLegacyHarnessEvent(ev).hook_event).toBe("PreCompact");
	});

	it.each([
		["pre-tool", "PreToolUse"],
		["post-tool", "PostToolUse"],
		["session-start", "SessionStart"],
		["session-end", "SessionEnd"],
		["user-prompt", "UserPromptSubmit"],
		["pre-compact", "PreCompact"],
		["post-compact", "PostCompact"],
		["stop", "Stop"],
		["subagent-start", "SubagentStart"],
		["subagent-stop", "SubagentStop"],
	] as const)("maps phase %s to %s when native event is non-legacy", (phase, expected) => {
		const ev = makeEvent({
			runner_native_event: "SomethingUnknown",
			phase,
			action: { kind: "other", subkind: "x", data: null },
			raw: {},
		});
		expect(toLegacyHarnessEvent(ev).hook_event).toBe(expected);
	});

	it("falls through to the native event for an unmapped phase (default branch)", () => {
		const ev = makeEvent({
			runner_native_event: "WeirdNativeEvent",
			phase: "notification",
			action: { kind: "other", subkind: "x", data: null },
			raw: {},
		});
		expect(toLegacyHarnessEvent(ev).hook_event).toBe("WeirdNativeEvent");
	});
});

// ===========================================================================
// mapAgentSource (via toLegacyHarnessEvent.agent_source)
// ===========================================================================

describe("mapAgentSource", () => {
	it.each([
		["claude-code", "claude"],
		["copilot-cli", "copilot"],
		["codex", "codex"],
		["gemini-cli", "gemini"],
		["cursor", "cursor"],
		["opencode", "opencode"],
		["opencode2", "opencode2"],
		["pi", "pi"],
	] as const)("maps runner %s to agent_source %s", (runner, expected) => {
		expect(toLegacyHarnessEvent(makeEvent({ runner })).agent_source).toBe(expected);
	});

	it("defaults unknown runners to claude", () => {
		expect(toLegacyHarnessEvent(makeEvent({ runner: "unknown" })).agent_source).toBe("claude");
	});
});

// ===========================================================================
// legacyToolName + claudeStyleToolName (via tool_call mapping)
// ===========================================================================

describe("legacyToolName", () => {
	it("uses raw.tool_name verbatim when present", () => {
		const ev = makeEvent({ raw: { tool_name: "CustomTool" } });
		expect(toLegacyHarnessEvent(ev).tool_name).toBe("CustomTool");
	});

	it("falls back to raw.toolName then raw.name", () => {
		const camel = makeEvent({ raw: { toolName: "CamelTool" } });
		expect(toLegacyHarnessEvent(camel).tool_name).toBe("CamelTool");
		const named = makeEvent({ raw: { name: "NameTool" } });
		expect(toLegacyHarnessEvent(named).tool_name).toBe("NameTool");
	});

	it("Claude-style-capitalizes the normalized tool name for claude-code when raw has no name", () => {
		const ev = makeEvent({ runner: "claude-code", raw: {} });
		expect(toLegacyHarnessEvent(ev).tool_name).toBe("Edit");
	});

	it("Claude-style-capitalizes for codex too", () => {
		const ev = makeEvent({
			runner: "codex",
			raw: {},
			action: {
				kind: "tool_call",
				tool_name: "write",
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toLegacyHarnessEvent(ev).tool_name).toBe("Write");
	});

	it("returns the normalized tool name unchanged for non-claude/codex runners", () => {
		const ev = makeEvent({
			runner: "gemini-cli",
			raw: {},
			action: {
				kind: "tool_call",
				tool_name: "edit",
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toLegacyHarnessEvent(ev).tool_name).toBe("edit");
	});

	it.each([
		["edit", "Edit"],
		["write", "Write"],
		["multi_edit", "MultiEdit"],
		["read", "Read"],
		["bash", "Bash"],
		["grep", "Grep"],
		["glob", "Glob"],
		["ls", "LS"],
		["notebook_edit", "NotebookEdit"],
		["web_fetch", "WebFetch"],
		["web_search", "WebSearch"],
		["todo_write", "TodoWrite"],
		["task", "Task"],
	])("claudeStyleToolName maps %s -> %s", (normalized, expected) => {
		const ev = makeEvent({
			runner: "claude-code",
			raw: {},
			action: {
				kind: "tool_call",
				tool_name: normalized,
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toLegacyHarnessEvent(ev).tool_name).toBe(expected);
	});

	it("claudeStyleToolName passes unknown normalized names through unchanged", () => {
		const ev = makeEvent({
			runner: "claude-code",
			raw: {},
			action: {
				kind: "tool_call",
				tool_name: "exotic_tool",
				tool_class: "modify",
				tool_input: {},
				tool_input_redacted: {},
			},
		});
		expect(toLegacyHarnessEvent(ev).tool_name).toBe("exotic_tool");
	});
});

// ===========================================================================
// copyTurnContext / copyString — effort object shape + parent_tool_use_id
// ===========================================================================

describe("copyTurnContext — effort field", () => {
	it("reads effort.level from an {level} object shape", () => {
		const ev = makeEvent({ raw: { effort: { level: "high" } } });
		expect(toLegacyHarnessEvent(ev).effort).toBe("high");
	});

	it("ignores an effort object whose level is missing or non-string", () => {
		const ev = makeEvent({ raw: { effort: { level: 5 } } });
		expect("effort" in toLegacyHarnessEvent(ev)).toBe(false);
	});

	it("reads effort directly when sent as a plain string", () => {
		const ev = makeEvent({ raw: { effort: "low" } });
		expect(toLegacyHarnessEvent(ev).effort).toBe("low");
	});
});

describe("copyString — parent_tool_use_id", () => {
	it("copies parent_tool_use_id onto the legacy event when string-typed", () => {
		const ev = makeEvent({ raw: { parent_tool_use_id: "tool-parent-9" } });
		expect(toLegacyHarnessEvent(ev).parent_tool_use_id).toBe("tool-parent-9");
	});

	it("omits parent_tool_use_id when not string-typed", () => {
		const ev = makeEvent({ raw: { parent_tool_use_id: 42 } });
		expect("parent_tool_use_id" in toLegacyHarnessEvent(ev)).toBe(false);
	});
});
