import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRpc, type DispatcherState } from "./daemon-dispatcher.js";
import type { RpcError, RpcResponse } from "./daemon-protocol.js";
import type { TsgoRunner } from "./tsgo-runner.js";
import { validateUnifiedEvent, type UnifiedHookEvent } from "./unified-event.js";

// Freeze time so `Date.now()` in makeState is deterministic.
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

const toolCallEvent: UnifiedHookEvent = {
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

describe("dispatchRpc — schema_mismatch exact wire shape", () => {
	// test-contract: invariant — StringLiteral (message template -> ``) + BooleanLiteral (recoverable false -> true)
	it("reports the exact message and recoverable=false", async () => {
		const result = await dispatchRpc(
			{ schema_version: "2", id: "r", method: "daemon.health", params: {} },
			makeState(),
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.message).toBe(`unsupported schema_version ${JSON.stringify("2")}`);
		expect(result.error.recoverable).toBe(false);
	});
});

describe("dispatchRpc — unknown_method exact wire shape", () => {
	// test-contract: invariant — StringLiteral (message template -> ``) + BooleanLiteral (recoverable true -> false)
	it("reports the exact message and recoverable=true", async () => {
		const req = {
			schema_version: "1",
			id: "r12b",
			method: "not.a.method",
			params: {},
		};
		const result = await dispatchRpc(req, makeState());
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.message).toBe("unknown method: not.a.method");
		expect(result.error.recoverable).toBe(true);
	});
});

describe("dispatchRpc — case-label routing for hook methods", () => {
	// test-contract: invariant — StringLiteral case label ("hook.post_tool_use" -> "")
	it("hook.post_tool_use routes to dispatchHookDecision, not unknown_method", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({ decision: "allow" });
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rp1", method: "hook.post_tool_use", params: toolCallEvent },
			makeState({ evaluateHook }),
		);
		expect(evaluateHook).toHaveBeenCalledWith(toolCallEvent);
		if (isError(result)) throw new Error(`unexpected error: ${result.error.code}`);
		expect(result.result).toEqual({ decision: "allow" });
	});

	// test-contract: invariant — StringLiteral case label ("hook.user_prompt" -> "")
	it("hook.user_prompt routes to dispatchHookDecision, not unknown_method", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({ decision: "allow" });
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rp2", method: "hook.user_prompt", params: toolCallEvent },
			makeState({ evaluateHook }),
		);
		expect(evaluateHook).toHaveBeenCalledWith(toolCallEvent);
		if (isError(result)) throw new Error(`unexpected error: ${result.error.code}`);
		expect(result.result).toEqual({ decision: "allow" });
	});

	// test-contract: invariant — StringLiteral case label ("hook.session_end" -> "")
	it("hook.session_end routes to dispatchHookDecision, not unknown_method", async () => {
		const evaluateHook = vi.fn().mockResolvedValue({ decision: "allow" });
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rp3", method: "hook.session_end", params: toolCallEvent },
			makeState({ evaluateHook }),
		);
		expect(evaluateHook).toHaveBeenCalledWith(toolCallEvent);
		if (isError(result)) throw new Error(`unexpected error: ${result.error.code}`);
		expect(result.result).toEqual({ decision: "allow" });
	});
});

describe("dispatchHookDecision — bad_request exact message", () => {
	// test-contract: invariant — StringLiteral (`invalid event: ${...}` -> ``) + StringLiteral ("; " -> "")
	it("joins multiple violations with the exact '; ' separator", async () => {
		const badEvent = {};
		const violations = validateUnifiedEvent(badEvent);
		expect(violations.length).toBeGreaterThan(1);
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rbad", method: "hook.pre_tool_use", params: badEvent },
			makeState(),
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.message).toBe(`invalid event: ${violations.join("; ")}`);
	});
});

describe("dispatchHookDecision — isLifecycleHookMethod branch", () => {
	// test-contract: invariant — ConditionalExpression (isLifecycleHookMethod(...) -> true)
	// and the OR-chain collapsing to `true` inside isLifecycleHookMethod itself: a
	// non-lifecycle method must NOT take the automatic-ack shortcut, it must reach
	// getEvaluatorContext() (which the default test state throws from).
	it("non-lifecycle methods fall through to the evaluator context, not an automatic ack", async () => {
		await expect(
			dispatchRpc(
				{ schema_version: "1", id: "rl1", method: "hook.pre_tool_use", params: toolCallEvent },
				makeState(),
			),
		).rejects.toThrow("evaluator context not needed for this test");
	});

	// test-contract: invariant — ConditionalExpression/EqualityOperator/StringLiteral on
	// `method === "hook.session_end"` inside isLifecycleHookMethod: session_end must ack
	// WITHOUT touching the (throwing) evaluator context.
	it("hook.session_end acks without touching the evaluator context", async () => {
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rl2", method: "hook.session_end", params: toolCallEvent },
			makeState(),
		);
		if (isError(result)) throw new Error(`unexpected error: ${result.error.code}`);
		expect((result.result).decision).toBe("allow");
	});
});

describe("dispatchTsgoCheck — guard clause + error shape", () => {
	// test-contract: invariant — LogicalOperator (|| -> &&) and ConditionalExpression
	// (whole guard -> false) on `!params || typeof params.path !== "string"`: with params
	// undefined, the mutants dereference `params.path` and throw; the real guard short-
	// circuits and returns bad_request cleanly.
	it("params undefined resolves to bad_request without throwing", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rc1",
				method: "tsgo.check_file",
				params: undefined,
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.checkFile).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ConditionalExpression on `typeof params.path !== "string"`
	// forced to false: a non-string path must still be rejected, not forwarded to checkFile.
	it("a non-string path is rejected, not forwarded to the runner", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rc2",
				method: "tsgo.check_file",
				params: { path: 123 },
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.checkFile).not.toHaveBeenCalled();
	});

	// test-contract: invariant — StringLiteral ("bad_request" -> "") + StringLiteral
	// ("tsgo.check_file requires a path" -> "")
	it("reports the exact bad_request code and message for a missing path", async () => {
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rc3", method: "tsgo.check_file", params: { path: "" } },
			makeState(),
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(result.error.message).toBe("tsgo.check_file requires a path");
	});

	// test-contract: invariant — StringLiteral ("tsgo is not installed" -> "") + BooleanLiteral
	// (recoverable true -> false)
	it("reports the exact tsgo_unavailable message and recoverable=true", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({ available: () => false, stats: () => ({ cache_size: 0, available: false }) }),
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rc4", method: "tsgo.check_file", params: { path: "/a.ts" } },
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.message).toBe("tsgo is not installed");
		expect(result.error.recoverable).toBe(true);
	});

	// test-contract: invariant — ObjectLiteral (`{ id: request.id, result }` -> `{}`)
	it("returns the exact { id, result } success shape", async () => {
		const diagnostics = { diagnostics: [], cached: true, elapsed_ms: 7 };
		const state = makeState({ tsgo: makeTsgoStub({ checkFile: vi.fn().mockResolvedValue(diagnostics) }) });
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rc5", method: "tsgo.check_file", params: { path: "/repo/a.ts" } },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect(result).toEqual({ id: "rc5", result: diagnostics });
	});
});

describe("dispatchTsgoSimulate — guard clause + error shape", () => {
	// test-contract: invariant — every LogicalOperator/ConditionalExpression collapse
	// across the 4-clause guard chain: with params undefined, all of them dereference a
	// field of `undefined` and throw where the real guard short-circuits cleanly.
	it("params undefined resolves to bad_request without throwing", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs1",
				method: "tsgo.simulate_edit",
				params: undefined,
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.simulateEdit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ConditionalExpression on `typeof params.path !== "string"` -> false
	it("a non-string path is rejected, not forwarded to the runner", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs2",
				method: "tsgo.simulate_edit",
				params: { path: 123, old_string: "x", new_string: "y" },
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.simulateEdit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ConditionalExpression on `typeof params.old_string !== "string"` -> false
	it("a non-string old_string is rejected, not forwarded to the runner", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs3",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: 1, new_string: "y" },
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.simulateEdit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ConditionalExpression on `typeof params.new_string !== "string"` -> false
	it("a non-string new_string is rejected, not forwarded to the runner", async () => {
		const state = makeState();
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs4",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: "x", new_string: 1 },
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("bad_request");
		expect(state.tsgo.simulateEdit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — StringLiteral bad_request message -> ``
	it("reports the exact bad_request message for a missing field", async () => {
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs5",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: "x" },
			},
			makeState(),
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.message).toBe("tsgo.simulate_edit requires path, old_string, new_string");
	});

	// test-contract: invariant — ConditionalExpression (`!state.tsgo.available()` -> false)
	it("reports tsgo_unavailable and never calls simulateEdit when tsgo is offline", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({ available: () => false, stats: () => ({ cache_size: 0, available: false }) }),
		});
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs6",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: "x", new_string: "y" },
			},
			state,
		);
		if (!isError(result)) throw new Error("expected error");
		expect(result.error.code).toBe("tsgo_unavailable");
		expect(state.tsgo.simulateEdit).not.toHaveBeenCalled();
	});

	// test-contract: invariant — ObjectLiteral (`{ id: request.id, result }` -> `{}`)
	it("returns the exact { id, result } success shape", async () => {
		const simResult = { new_diagnostics: [], elapsed_ms: 3 };
		const state = makeState({ tsgo: makeTsgoStub({ simulateEdit: vi.fn().mockResolvedValue(simResult) }) });
		const result = await dispatchRpc(
			{
				schema_version: "1",
				id: "rs7",
				method: "tsgo.simulate_edit",
				params: { path: "/a.ts", old_string: "x", new_string: "y" },
			},
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		expect(result).toEqual({ id: "rs7", result: simResult });
	});
});

describe("buildHealthResponse — warm_caches + uptime exact values", () => {
	// test-contract: invariant — ArrayDeclaration (`[]` -> `["Stryker was here"]`) and
	// ConditionalExpression (`state.tsgo.available()` -> true) on the "tsgo" push, plus
	// ConditionalExpression/EqualityOperator on `cache_size > 0` (-> true / <= / >=): with
	// tsgo unavailable and cache_size 0, warm_caches must be exactly [].
	it("warm_caches is exactly [] when tsgo is unavailable and cache is empty", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({ available: () => false, stats: () => ({ cache_size: 0, available: false }) }),
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rh1", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.warm_caches).toEqual([]);
	});

	// test-contract: invariant — ConditionalExpression (`state.tsgo.available()` -> false)
	// on the "tsgo" push: available tsgo must push exactly "tsgo".
	it("warm_caches includes exactly 'tsgo' when tsgo is available", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({ available: () => true, stats: () => ({ cache_size: 0, available: true }) }),
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rh2", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.warm_caches).toEqual(["tsgo"]);
	});

	// test-contract: invariant — ConditionalExpression (`cache_size > 0` -> false) on the
	// "mtime" push: a non-empty cache must push exactly "mtime" too.
	it("warm_caches includes 'mtime' when cache_size is positive", async () => {
		const state = makeState({
			tsgo: makeTsgoStub({ available: () => false, stats: () => ({ cache_size: 5, available: false }) }),
		});
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rh3", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.warm_caches).toEqual(["mtime"]);
	});

	// test-contract: invariant — ArithmeticOperator (`Date.now() - state.started_at` -> `+`)
	it("uptime_ms is the exact difference between now and started_at", async () => {
		const state = makeState({ started_at: Date.now() - 100 });
		const result = await dispatchRpc(
			{ schema_version: "1", id: "rh4", method: "daemon.health", params: {} },
			state,
		);
		if (isError(result)) throw new Error("unexpected error");
		const health = result.result;
		expect(health.uptime_ms).toBe(100);
	});
});
