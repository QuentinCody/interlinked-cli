import { describe, expect, it } from "vitest";
import { parseResponseFrame } from "./daemon-response-parser.js";
import { makeError } from "./daemon-protocol.js";

const health = {
	status: "ready", uptime_ms: 12, warm_caches: ["tsgo"], tsgo_status: "ready",
	rpc_inflight: 0, protocol_version: "1",
};

describe("RPC response validation", () => {
	it("preserves a correlated method result and its optional hook metadata", () => {
		const result = {
			decision: "ask", reason: "confirm deletion", system_message: "user-only context",
			warnings: ["review target"], updated_input: { path: "/repo/a.ts" },
			resolved_targets: [{ kind: "file", value: "/repo/a.ts" }],
			check_results: [{ source: "quality", name: "typescript", severity: "error", message: "invalid assignment", determinism: "fully_deterministic", line: 2 }],
		};
		expect(parseResponseFrame(JSON.stringify({ id: "r", result }), "hook.pre_tool_use"))
			.toEqual({ id: "r", result });
	});

	it("accepts health and errors produced by the daemon", () => {
		expect(parseResponseFrame(JSON.stringify({ id: "r", result: health }), "daemon.health"))
			.toEqual({ id: "r", result: health });
		const error = makeError("r", "schema_mismatch", "unsupported schema_version", false);
		expect(parseResponseFrame(JSON.stringify(error), "daemon.health")).toEqual(error);
	});

	it.each([
		{ id: "r" },
		{ id: "r", result: null },
		{ id: "r", result: { ack: true } },
		{ id: "r", result: { ...health, warm_caches: [null] } },
		{ id: "r", result: { ...health, rpc_inflight: "0" } },
		{ id: "r", result: health, error: {} },
		{ id: "r", result: health, method: "daemon.health" },
		{ id: "r", error: { code: "unexpected", message: "m", recoverable: true } },
	])("rejects malformed or wrong-variant health frames: %j", (frame) => {
		expect(parseResponseFrame(JSON.stringify(frame), "daemon.health")).toBeNull();
	});

	it.each([
		{ decision: "other" },
		{ decision: "allow", warnings: [null] },
		{ decision: "allow", resolved_targets: [{ kind: "file" }] },
		{ decision: "allow", check_results: [null] },
		{ decision: "allow", tool_breakdown: [{ tool: "tsc", ms: "1", finding_count: 0 }] },
		{ decision: "allow", _contentScan: { hook: "user_prompt", parts: [null] } },
	])("rejects malformed decision fields: %j", (result) => {
		expect(parseResponseFrame(JSON.stringify({ id: "r", result }), "hook.pre_tool_use")).toBeNull();
	});

	it("checks nested diagnostic entries before exposing compiler results", () => {
		const result = { diagnostics: [null], cached: false, elapsed_ms: 1 };
		expect(parseResponseFrame(JSON.stringify({ id: "r", result }), "tsgo.check_file")).toBeNull();
		const valid = { diagnostics: [{ file: "a.ts", line: 1, column: 2, code: 2322, severity: "error", message: "invalid assignment" }], cached: false, elapsed_ms: 1 };
		expect(parseResponseFrame(JSON.stringify({ id: "r", result: valid }), "tsgo.check_file"))
			.toEqual({ id: "r", result: valid });
	});
});
