import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { type DispatcherState, dispatchRpc } from "./daemon-dispatcher.js";
import type { RpcError, RpcWireRequest, RpcResponse } from "./daemon-protocol.js";
import type { TsgoRunner } from "./tsgo-runner.js";
import type { UnifiedHookEvent } from "./unified-event.js";

// Freeze time so `Date.now()` in makeState is deterministic — the check
// `non_deterministic_test` flags raw Date.now() in tests.
beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
});
afterEach(() => {
	vi.useRealTimers();
});

function makeTsgoStub(overrides: Partial<TsgoRunner> = {}): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
		...overrides,
	};
}

function makeState(overrides: Partial<DispatcherState> = {}): DispatcherState {
	return {
		started_at: Date.now() - 100,
		rpc_inflight: 0,
		tsgo: makeTsgoStub(),
		getEvaluatorContext: () => {
			throw new Error("evaluator context not needed for this test");
		},
		shutdown: vi.fn(),
		...overrides,
	};
}

function isError(m: RpcResponse | RpcError): m is RpcError {
	return "error" in m;
}

describe("dispatchRpc — schema check", () => {
	it("rejects requests with a wrong schema_version", async () => {
		const result = await dispatchRpc(
			{
				schema_version: "2",
				id: "r",
				method: "daemon.health",
				params: {},
			},
			makeState(),
		);
		expect(isError(result)).toBe(true);
		if (isError(result)) expect(result.error.code).toBe("schema_mismatch");
	});
});

describe("dispatchRpc — daemon.health", () => {
	it("reports ready when tsgo is available", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{ schema_version: "1", id: "r1", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.status).toBe("ready");
		expect(health.tsgo_status).toBe("ready");
		expect(health.protocol_version).toBe("1");
	});

	it("reports degraded when tsgo is unavailable", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({
				available: () => false,
				stats: () => ({ cache_size: 0, available: false }),
			}),
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "r2", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.status).toBe("degraded");
		expect(health.tsgo_status).toBe("unavailable");
	});
});

describe("dispatchRpc — daemon.shutdown + invalidate", () => {
	it("shutdown calls state.shutdown and acks", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r3",
				method: "daemon.shutdown",
				params: { reason: "test" },
			},
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect((vi.mocked(state.shutdown)).mock.calls.length).toBe(1);
		expect((result.result).ack).toBe(true);
	});

	it("invalidate forwards to tsgo.invalidate and acks", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r4",
				method: "daemon.invalidate",
				params: { path: "/a.ts" },
			},
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect(nonNull((vi.mocked(state.tsgo.invalidate)).mock.calls[0])[0]).toBe("/a.ts");
	});
});

describe("dispatchRpc — tsgo methods", () => {
	it("tsgo.check_file routes to the runner", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r5",
				method: "tsgo.check_file",
				params: { path: "/repo/a.ts" },
			},
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect(nonNull((vi.mocked(state.tsgo.checkFile)).mock.calls[0])[0]).toBe(
			"/repo/a.ts",
		);
	});

	it("tsgo.check_file rejects empty path", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r6",
				method: "tsgo.check_file",
				params: { path: "" },
			},
			state,
		);
		expect(isError(result)).toBe(true);
	});

	it("tsgo returns tsgo_unavailable when the runner is offline", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({
				available: () => false,
				stats: () => ({ cache_size: 0, available: false }),
			}),
		});
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r7",
				method: "tsgo.check_file",
				params: { path: "/a.ts" },
			},
			state,
		);
		expect(isError(result)).toBe(true);
		if (isError(result)) expect(result.error.code).toBe("tsgo_unavailable");
	});

	it("tsgo.simulate_edit requires all three fields", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "r8",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: "x", new_string: "y" },
			},
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect((vi.mocked(state.tsgo.simulateEdit)).mock.calls.length).toBe(1);
	});
});

describe("dispatchRpc — lifecycle acks", () => {
	const event: UnifiedHookEvent = {
		schema_version: "1",
		event_id: "evt-l",
		session_id: "s",
		ts: "2026-04-23T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "SessionStart",
		phase: "session-start",
		action: { kind: "session_lifecycle", event: "start" },
		context: { cwd: "/r" },
		raw: {},
	};

	it("session_start acks", async () => {
		const result = await dispatchRpc(
			{ schema_version: "1", id: "r9", method: "hook.session_start", params: event },
			makeState(),
		);
		if (isError(result)) throw new Error("unexpected error");
		expect((result.result).decision).toBe("allow");
	});

	it("pre_compact acks", async () => {
		const result = await dispatchRpc(
			{ schema_version: "1", id: "r10", method: "hook.pre_compact", params: event },
			makeState(),
		);
		if (isError(result)) throw new Error("unexpected error");
		expect((result.result).decision).toBe("allow");
	});

	it.each([
		"hook.permission_request",
		"hook.post_compact",
		"hook.lifecycle",
	] as const)("%s acks without applying a tool evaluator", async (method) => {
		const result = await dispatchRpc(
			{ schema_version: "1", id: `r-${method}`, method, params: event },
			makeState(),
		);
		if (isError(result)) throw new Error("unexpected error");
		expect((result.result).decision).toBe("allow");
	});
});

describe("dispatchRpc — hook runtime bridge", () => {
	const event: UnifiedHookEvent = {
		schema_version: "1",
		event_id: "evt-runtime",
		session_id: "s",
		ts: "2026-04-23T00:00:00.000Z",
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
		context: { cwd: "/r" },
		raw: {},
	};

	it("routes hook RPCs through evaluateHook when the shared runtime provides it", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({
			decision: "allow",
			warnings: ["runtime warning"],
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rh-1", method: "hook.pre_tool_use", params: event },
			makeState({ evaluateHook }),
		);

		if (isError(result)) throw new Error("unexpected error");
		expect(evaluateHook).toHaveBeenCalledWith(event);
		expect(result.id).toBe("rh-1");
		expect((result.result).warnings).toEqual(["runtime warning"]);
	});

	it("routes lifecycle RPCs through evaluateHook so session side effects are shared", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({ decision: "allow" });
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rh-2",
				method: "hook.session_start",
				params: { ...event, phase: "session-start", runner_native_event: "SessionStart" },
			},
			makeState({ evaluateHook }),
		);

		if (isError(result)) throw new Error("unexpected error");
		expect(evaluateHook).toHaveBeenCalledOnce();
		expect((result.result).decision).toBe("allow");
	});
});

describe("dispatchRpc — bad event payload", () => {
	it("hook.pre_tool_use rejects an invalid envelope", async () => {
		const req: RpcWireRequest = {
			schema_version: "1",
			id: "r11",
			method: "hook.pre_tool_use",
			params: {},
		};
		const result = await dispatchRpc(req, makeState());
		expect(isError(result)).toBe(true);
		if (isError(result)) expect(result.error.code).toBe("bad_request");
	});
});

describe("dispatchRpc — unknown method", () => {
	it("returns unknown_method", async () => {
		const req = {
			schema_version: "1",
			id: "r12",
			method: "not.a.method",
			params: {},
		};
		const result = await dispatchRpc(req, makeState());
		expect(isError(result)).toBe(true);
		if (isError(result)) expect(result.error.code).toBe("unknown_method");
	});
});

describe("dispatchRpc — administrative request boundaries", () => {
	it.each([undefined, null, [], { reason: 42 }])("rejects invalid shutdown params before invoking shutdown: %j", async (params) => {
		const state = makeState();
		const result = await dispatchRpc({ schema_version: "1", id: "shutdown", method: "daemon.shutdown", params }, state);
		expect(result).toMatchObject({ id: "shutdown", error: { code: "bad_request" } });
		expect(state.shutdown).not.toHaveBeenCalled();
	});

	it.each([undefined, null, [], {}, { path: "" }, { path: 42 }])("rejects invalid invalidation params before touching the cache: %j", async (params) => {
		const state = makeState();
		const result = await dispatchRpc({ schema_version: "1", id: "invalidate", method: "daemon.invalidate", params }, state);
		expect(result).toMatchObject({ id: "invalidate", error: { code: "bad_request" } });
		expect(state.tsgo.invalidate).not.toHaveBeenCalled();
	});

	it("rejects an incomplete action before invoking a hook evaluator", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({ decision: "allow" });
		const result = await dispatchRpc({
			schema_version: "1", id: "hook", method: "hook.pre_tool_use",
			params: {
				schema_version: "1", event_id: "evt", session_id: "s", ts: "2026-09-07T00:00:00Z",
				runner: "codex", runner_native_event: "PreToolUse", phase: "pre-tool",
				context: { cwd: "/repo" }, action: { kind: "tool_call" }, raw: {},
			},
		}, makeState({ evaluateHook }));
		expect(result).toMatchObject({ error: { code: "bad_request" } });
		expect(evaluateHook).not.toHaveBeenCalled();
	});
});
