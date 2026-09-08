import { describe, expect, it } from "vitest";
import {
	asFileOperation,
	asShellCommand,
	asToolCall,
	extractToolClass,
	makeEventId,
	type UnifiedHookEvent,
	validateUnifiedEvent,
} from "./unified-event.js";

function makeEvent(overrides: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	const base: UnifiedHookEvent = {
		schema_version: "1",
		event_id: "evt-abc",
		session_id: "sess-1",
		ts: "2026-04-23T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: "edit",
			tool_class: "modify",
			tool_input: { file_path: "/x" },
			tool_input_redacted: { file_path: "/x" },
		},
		context: { cwd: "/tmp" },
		raw: {},
	};
	return { ...base, ...overrides };
}

describe("makeEventId", () => {
	it("returns a non-empty prefixed string", () => {
		const id = makeEventId();
		expect(id.startsWith("evt-")).toBe(true);
		expect(id.length).toBeGreaterThan("evt-".length + 1);
	});

	it("produces distinct ids across rapid calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) ids.add(makeEventId());
		expect(ids.size).toBeGreaterThan(45);
	});
});

describe("validateUnifiedEvent", () => {
	it("accepts a well-formed event with no violations", () => {
		expect(validateUnifiedEvent(makeEvent())).toEqual([]);
	});

	it("rejects non-objects", () => {
		expect(validateUnifiedEvent(null)).toContain("event must be an object");
		expect(validateUnifiedEvent("foo")).toContain("event must be an object");
	});

	it("rejects wrong schema_version", () => {
		const e = makeEvent();
		const bad = { ...e, schema_version: "2" };
		const problems = validateUnifiedEvent(bad);
		expect(problems.some((p) => p.includes("schema_version"))).toBe(true);
	});

	it("rejects missing context.cwd", () => {
		const e = makeEvent();
		const bad = { ...e, context: {} };
		const problems = validateUnifiedEvent(bad);
		expect(problems.some((p) => p.includes("context.cwd"))).toBe(true);
	});

	it("rejects missing action.kind", () => {
		const bad = { ...makeEvent(), action: {} };
		const problems = validateUnifiedEvent(bad);
		expect(problems.some((p) => p.includes("action.kind"))).toBe(true);
	});
});

describe("action narrowers", () => {
	it("asToolCall returns the action for tool_call, null otherwise", () => {
		const e = makeEvent();
		expect(asToolCall(e)?.tool_name).toBe("edit");
		const other = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
		});
		expect(asToolCall(other)).toBeNull();
	});

	it("asShellCommand narrows correctly", () => {
		const sh = makeEvent({
			action: { kind: "shell_command", command: "ls -la", tool_class: "read" },
		});
		expect(asShellCommand(sh)?.command).toBe("ls -la");
		expect(asShellCommand(makeEvent())).toBeNull();
	});

	it("asFileOperation narrows correctly", () => {
		const fo = makeEvent({
			action: {
				kind: "file_operation",
				operation: "edit",
				path: "/a/b",
				old_string: "x",
				new_string: "y",
				tool_class: "modify",
			},
		});
		expect(asFileOperation(fo)?.operation).toBe("edit");
		expect(asFileOperation(makeEvent())).toBeNull();
	});
});

describe("extractToolClass", () => {
	it("returns the tool_class from tool_call actions", () => {
		expect(extractToolClass(makeEvent())).toBe("modify");
	});

	it("returns the tool_class from shell actions", () => {
		const e = makeEvent({
			action: { kind: "shell_command", command: "git push", tool_class: "side-effect" },
		});
		expect(extractToolClass(e)).toBe("side-effect");
	});

	it("returns unknown for actions without a class", () => {
		const e = makeEvent({
			action: { kind: "session_lifecycle", event: "start" },
		});
		expect(extractToolClass(e)).toBe("unknown");
	});
});

describe("round-trip JSON serialization", () => {
	it("preserves all fields after JSON.stringify + parse", () => {
		const e = makeEvent({
			runner_version: "1.2.3",
			parent_event_id: "evt-parent",
			context: { cwd: "/tmp", workspace_root: "/tmp/repo", branch: "main" },
			raw: { any: "payload", shape: [1, 2, 3] },
		});
		const parsed = JSON.parse(JSON.stringify(e));
		expect(parsed).toEqual(e);
		expect(validateUnifiedEvent(parsed)).toEqual([]);
	});
});
