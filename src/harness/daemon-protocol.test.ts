import { describe, expect, it } from "vitest";
import {
	decodeFrame,
	encodeFrame,
	isError,
	isRequest,
	makeError,
	methodForPhase,
	PROTOCOL_VERSION,
	type RpcError,
	type RpcRequest,
	type RpcResponse,
	splitFrames,
} from "./daemon-protocol.js";
import type { UnifiedHookEvent } from "./unified-event.js";

describe("protocol version", () => {
	it("is stable at '1'", () => {
		expect(PROTOCOL_VERSION).toBe("1");
	});
});

describe("encodeFrame / decodeFrame round-trip", () => {
	it("preserves a request envelope", () => {
		const event: UnifiedHookEvent = {
			schema_version: "1",
			event_id: "evt-1",
			session_id: "s",
			ts: "2026-04-23T00:00:00.000Z",
			runner: "claude-code",
			runner_native_event: "PreToolUse",
			phase: "pre-tool",
			action: { kind: "session_lifecycle", event: "start" },
			context: { cwd: "/r" },
			raw: {},
		};
		const req: RpcRequest = {
			schema_version: "1",
			id: "r-1",
			method: "hook.pre_tool_use",
			params: event,
		};
		const encoded = encodeFrame(req);
		expect(encoded.endsWith("\n")).toBe(true);
		const decoded = decodeFrame(encoded.replace(/\n$/, ""));
		expect(decoded.id).toBe("r-1");
		expect(isRequest(decoded)).toBe(true);
	});

	it("preserves a response envelope", () => {
		const resp: RpcResponse<"daemon.health"> = {
			id: "r-2",
			result: {
				status: "ready",
				uptime_ms: 42,
				warm_caches: ["tsgo"],
				tsgo_status: "ready",
				rpc_inflight: 0,
				protocol_version: "1",
			},
		};
		const decoded = decodeFrame(encodeFrame(resp).replace(/\n$/, ""));
		expect(decoded.id).toBe("r-2");
	});

	it("preserves an error envelope", () => {
		const err: RpcError = makeError("r-3", "timeout", "took too long");
		const decoded = decodeFrame(encodeFrame(err).replace(/\n$/, ""));
		expect(isError(decoded)).toBe(true);
		if (isError(decoded)) expect(decoded.error.code).toBe("timeout");
	});
});

describe("decodeFrame error paths", () => {
	it("throws on malformed JSON", () => {
		expect(() => decodeFrame("{broken")).toThrow();
	});
	it("throws on non-object payloads", () => {
		expect(() => decodeFrame("42")).toThrow();
	});
	it("throws when id is missing", () => {
		expect(() => decodeFrame(JSON.stringify({ method: "x" }))).toThrow();
	});
});

describe("splitFrames", () => {
	it("preserves a partial frame until a later chunk supplies its newline", () => {
		expect(splitFrames('"value"', '{"id":')).toEqual({ frames: [], remainder: '{"id":"value"' });
	});

	it("ignores leading and repeated blank frames while retaining complete JSON", () => {
		expect(splitFrames('\n{"id":"1"}\n\n{"id":')).toEqual({ frames: ['{"id":"1"}'], remainder: '{"id":' });
	});

	it("splits newline-delimited frames and returns remainder", () => {
		const { frames, remainder } = splitFrames('{"id":"1"}\n{"id":"2"}\n{"id":"3');
		expect(frames.length).toBe(2);
		expect(remainder).toBe('{"id":"3');
	});
	it("carries the pending chunk forward", () => {
		const pending = '{"id":"0":';
		const { frames, remainder } = splitFrames('true}\n{"id":"1"}\n', pending);
		expect(frames.length).toBe(2);
		expect(remainder).toBe("");
	});
	it("returns empty frames on empty input", () => {
		expect(splitFrames("")).toEqual({ frames: [], remainder: "" });
	});
});

describe("makeError", () => {
	it("sets recoverable to true by default", () => {
		const e = makeError("x", "timeout", "m");
		expect(e.error.recoverable).toBe(true);
	});
	it("honors an explicit recoverable=false", () => {
		const e = makeError("x", "schema_mismatch", "nope", false);
		expect(e.error.recoverable).toBe(false);
	});
});

// isError regression (2026-08-09): the predicate tested only that `error` was a
// non-null object, so every other required field of RpcError went unchecked.
// Foreign messages remain unknown until all error fields have been checked.
describe("isError — validates every required field of RpcError", () => {
	const wire = (v: unknown): unknown => v;

	it("accepts what makeError produces", () => {
		expect(isError(makeError("r-1", "timeout", "took too long"))).toBe(true);
	});

	it("rejects an error object missing code/message/recoverable", () => {
		expect(isError(wire({ id: "r-1", error: {} }))).toBe(false);
	});

	it("rejects a non-string id", () => {
		expect(isError(wire({ error: { code: "timeout", message: "m", recoverable: true } }))).toBe(
			false,
		);
		expect(
			isError(wire({ id: 7, error: { code: "timeout", message: "m", recoverable: true } })),
		).toBe(false);
	});

	it("rejects a non-boolean recoverable", () => {
		expect(
			isError(wire({ id: "r-1", error: { code: "timeout", message: "m", recoverable: "yes" } })),
		).toBe(false);
	});

	it("still rejects a plain response that carries no error", () => {
		expect(isError(wire({ id: "r-1", result: { ok: true } }))).toBe(false);
		expect(isError(wire({ id: "r-1", error: null }))).toBe(false);
	});
});

describe("methodForPhase", () => {
	it("maps each known phase to a method", () => {
		expect(methodForPhase("pre-tool")).toBe("hook.pre_tool_use");
		expect(methodForPhase("post-tool")).toBe("hook.post_tool_use");
		expect(methodForPhase("session-start")).toBe("hook.session_start");
		expect(methodForPhase("session-end")).toBe("hook.session_end");
		expect(methodForPhase("user-prompt")).toBe("hook.user_prompt");
		expect(methodForPhase("pre-compact")).toBe("hook.pre_compact");
		expect(methodForPhase("permission-request")).toBe("hook.permission_request");
		expect(methodForPhase("post-compact")).toBe("hook.post_compact");
	});
	it("routes lifecycle and unknown phases to the observation-only method", () => {
		expect(methodForPhase("stop")).toBe("hook.lifecycle");
		expect(methodForPhase("subagent-start")).toBe("hook.lifecycle");
		expect(methodForPhase("other")).toBe("hook.lifecycle");
	});
});
