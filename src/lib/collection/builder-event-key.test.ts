import { describe, expect, it } from "vitest";
import {
	PRE_EVENT_TYPES,
	TOOL_EVENT_TYPES,
	resolveOutcome,
	resolveToolEventKey,
} from "./builder-event-key.js";

describe("PRE_EVENT_TYPES / TOOL_EVENT_TYPES", () => {
	it("projects both PRE legacy types", () => {
		expect([...PRE_EVENT_TYPES].sort()).toEqual(["permission_request", "tool_use_start"]);
	});

	it("consumes the four legacy tool types", () => {
		expect([...TOOL_EVENT_TYPES].sort()).toEqual([
			"permission_request",
			"tool_use",
			"tool_use_error",
			"tool_use_start",
		]);
	});
});

describe("resolveToolEventKey", () => {
	it("resolves a post event keyed on event_type", () => {
		expect(resolveToolEventKey({ event_type: "tool_use", tool_name: "Bash" })).toEqual({
			eventType: "tool_use",
			toolName: "Bash",
			phase: "post",
		});
	});

	it("resolves a pre event keyed on the legacy `type` field", () => {
		expect(resolveToolEventKey({ type: "tool_use_start", tool: "Read" })).toEqual({
			eventType: "tool_use_start",
			toolName: "Read",
			phase: "pre",
		});
	});

	it("maps permission_request to the pre phase", () => {
		expect(resolveToolEventKey({ type: "permission_request", tool_name: "Edit" })?.phase).toBe("pre");
	});

	it("maps tool_use_error to the post phase", () => {
		expect(resolveToolEventKey({ type: "tool_use_error", tool_name: "Edit" })?.phase).toBe("post");
	});

	it("prefers event_type over type and tool_name over tool", () => {
		expect(
			resolveToolEventKey({
				event_type: "tool_use",
				type: "tool_use_start",
				tool_name: "Write",
				tool: "Read",
			}),
		).toEqual({ eventType: "tool_use", toolName: "Write", phase: "post" });
	});

	it("rejects guard telemetry on event_type", () => {
		expect(resolveToolEventKey({ event_type: "guard_block", tool_name: "Bash" })).toBeNull();
	});

	it("rejects guard telemetry carried only on the legacy `type` field", () => {
		expect(resolveToolEventKey({ event_type: "tool_use", type: "guard_warn", tool_name: "Bash" })).toBeNull();
	});

	it("rejects an unknown event type", () => {
		expect(resolveToolEventKey({ event_type: "session_start", tool_name: "Bash" })).toBeNull();
	});

	it("rejects a tool event with no tool name", () => {
		expect(resolveToolEventKey({ event_type: "tool_use" })).toBeNull();
		expect(resolveToolEventKey({ event_type: "tool_use", tool_name: "" })).toBeNull();
	});

	it("rejects an empty event", () => {
		expect(resolveToolEventKey({})).toBeNull();
	});
});

describe("resolveOutcome", () => {
	it("returns undefined for the pre phase", () => {
		expect(resolveOutcome("pre", "tool_use_start")).toBeUndefined();
		expect(resolveOutcome("pre", "tool_use_error")).toBeUndefined();
	});

	it("returns error for a post tool_use_error", () => {
		expect(resolveOutcome("post", "tool_use_error")).toBe("error");
	});

	it("returns ok for any other post event", () => {
		expect(resolveOutcome("post", "tool_use")).toBe("ok");
	});
});
