// Tests for the self-contained collection writer chunk embedded in the
// generated .mjs hook script. Verifies that buildCollectionRecord produces
// valid collection.v1 records for the major tool classes, and that guard
// records (schema_version 3) are correctly excluded.
//
// Pattern: reconstruct the function from the chunk source string (same as
// the .mjs runtime does), then call it with synthetic events.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../non-null.js";
import { COLLECTION_WRITER_CHUNK } from "../collection-writer.js";

/**
 * Build self-contained `buildCollectionRecord` from the chunk source.
 * The chunk defines the function at module scope — wrap it in a
 * Function constructor to get a callable reference.
 */
function getRecordBuilder(): (event: Record<string, unknown>) => Record<string, unknown> | null {
	const fn = new Function(
		`"use strict"; ${COLLECTION_WRITER_CHUNK}\nreturn buildCollectionRecord;`,
	)();
	return fn as (event: Record<string, unknown>) => Record<string, unknown> | null;
}

function makeEditEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		event_type: "tool_use",
		tool_name: "Edit",
		tool_input: { file_path: "/src/foo.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
		ts: "2026-05-19T00:00:00Z",
		...overrides,
	};
}

describe("collection writer chunk — tool class: file_edit", () => {
	const build = getRecordBuilder();

	it("classifies Edit as file_edit", () => {
		const record = build(makeEditEvent());
		expect(record).not.toBeNull();
		expect(record!.tool_class).toBe("file_edit");
	});

	it("sets schema to collection.v1", () => {
		expect(build(makeEditEvent())!.schema).toBe("collection.v1");
	});

	it("sets kind to tool_event", () => {
		expect(build(makeEditEvent())!.kind).toBe("tool_event");
	});

	it("extracts file path into action", () => {
		const action = build(makeEditEvent())!.action as Record<string, unknown>;
		expect(action.path).toBe("/src/foo.ts");
	});

	it("produces diff hunks from old/new strings", () => {
		const action = build(makeEditEvent())!.action as Record<string, unknown>;
		const diff = action.diff as { hunks: Array<{ old: string; new: string }> };
		expect(diff.hunks).toHaveLength(1);
		expect(diff.hunks[0]).toEqual({ old: "const a = 1;", new: "const a = 2;" });
	});
});

describe("collection writer chunk — tool class: file_write", () => {
	const build = getRecordBuilder();

	it("classifies Write as file_write", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Write",
			tool_input: { file_path: "/src/new.ts", content: "export const x = 1;" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("file_write");
	});

	it("captures content in the action", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Write",
			tool_input: { file_path: "/src/new.ts", content: "export const x = 1;" },
			ts: "2026-05-19T00:00:00Z",
		});
		const action = record!.action as Record<string, unknown>;
		expect(action.content).toBe("export const x = 1;");
	});
});

describe("collection writer chunk — tool class: shell_exec", () => {
	const build = getRecordBuilder();

	it("classifies Bash as shell_exec", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("shell_exec");
	});

	it("extracts command into action", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			ts: "2026-05-19T00:00:00Z",
		});
		const action = record!.action as Record<string, unknown>;
		expect(action.command).toBe("npm test");
	});

	it("extracts stdout and exit_code into observation", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "npm test" },
			tool_response: { stdout: "ok", exitCode: 0 },
			ts: "2026-05-19T00:00:00Z",
		});
		const obs = record!.observation as Record<string, unknown>;
		expect(obs.stdout).toBe("ok");
		expect(obs.exit_code).toBe(0);
	});
});

describe("collection writer chunk — tool class: file_read", () => {
	const build = getRecordBuilder();

	it("classifies Read as file_read with content observation", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Read",
			tool_input: { file_path: "/src/index.ts" },
			tool_response: "const x = 1;\n",
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("file_read");
		const obs = record!.observation as Record<string, unknown>;
		expect(obs.content).toBe("const x = 1;\n");
	});
});

describe("collection writer chunk — tool class: search", () => {
	const build = getRecordBuilder();

	it("classifies Grep as search", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Grep",
			tool_input: { pattern: "TODO", path: "/src" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("search");
	});
});

describe("collection writer chunk — tool class: fetch", () => {
	const build = getRecordBuilder();

	it("classifies WebFetch as fetch", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "WebFetch",
			tool_input: { url: "https://example.com" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("fetch");
	});
});

describe("collection writer chunk — tool class: mcp_call", () => {
	const build = getRecordBuilder();

	it("classifies mcp__server__tool names as mcp_call with parsed attribution", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "mcp__context7__resolve-library-id",
			tool_input: { libraryName: "react" },
			tool_response: { content: [{ type: "text", text: "react docs" }] },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("mcp_call");
		expect(record!.action).toEqual({
			server: "context7",
			tool: "resolve-library-id",
			params: { libraryName: "react" },
			params_ref: null,
		});
		expect(record!.observation).toEqual({
			result: { content: [{ type: "text", text: "react docs" }] },
			result_ref: null,
		});
	});
});

describe("collection writer chunk — tool class: other", () => {
	const build = getRecordBuilder();

	it("classifies unknown tools as other", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "CustomMcpTool",
			tool_input: { foo: "bar" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.tool_class).toBe("other");
	});
});

describe("collection writer chunk — phase detection", () => {
	const build = getRecordBuilder();

	it("detects pre phase from tool_use_start", () => {
		const record = build({
			event_type: "tool_use_start",
			tool_name: "Edit",
			tool_input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.phase).toBe("pre");
	});

	it("sets observation to null for pre phase", () => {
		const record = build({
			event_type: "tool_use_start",
			tool_name: "Edit",
			tool_input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.observation).toBeNull();
	});

	it("detects post phase from tool_use", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record!.phase).toBe("post");
	});
});

describe("collection writer chunk — guard exclusion", () => {
	const build = getRecordBuilder();

	it("returns null for guard records (schema_version 3)", () => {
		const record = build({
			schema_version: 3,
			event_type: "tool_use",
			type: "guard_block",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record).toBeNull();
	});
});

describe("collection writer chunk — non-tool event exclusion", () => {
	const build = getRecordBuilder();

	it("returns null for session_start", () => {
		expect(build({ event_type: "session_start", ts: "2026-05-19T00:00:00Z" })).toBeNull();
	});

	it("returns null for session_end", () => {
		expect(build({ event_type: "session_end", ts: "2026-05-19T00:00:00Z" })).toBeNull();
	});

	it("returns null for agent_stop", () => {
		expect(build({ event_type: "agent_stop", ts: "2026-05-19T00:00:00Z" })).toBeNull();
	});

	it("returns null for user_prompt", () => {
		expect(build({ event_type: "user_prompt", ts: "2026-05-19T00:00:00Z" })).toBeNull();
	});

	it("returns null when tool_name is empty", () => {
		expect(build({ event_type: "tool_use", tool_name: "", ts: "2026-05-19T00:00:00Z" })).toBeNull();
	});
});

describe("collection writer chunk — provider detection", () => {
	const build = getRecordBuilder();

	it("detects claude-code as default provider", () => {
		expect(build(makeEditEvent())!.provider).toBe("claude-code");
	});

	it("detects gemini from AfterTool hook_event", () => {
		expect(build(makeEditEvent({ hook_event: "AfterTool" }))!.provider).toBe("gemini-cli");
	});

	it("detects cursor from cursor_version", () => {
		expect(build(makeEditEvent({ cursor_version: "1.0" }))!.provider).toBe("cursor");
	});

	it.each(["copilot", "gemini-cli", "cursor", "opencode", "pi"])(
		"detects %s from client_runner",
		(provider) => {
			expect(build(makeEditEvent({ client_runner: provider }))!.provider).toBe(provider);
		},
	);
});

describe("collection writer chunk — git context", () => {
	const build = getRecordBuilder();

	it("includes git context when present", () => {
		const record = build(makeEditEvent({ git_head: "abc1234567890", git_branch: "main" }));
		expect(record!.git).toEqual({ head: "abc1234567890", branch: "main" });
	});

	it("sets git to null when absent", () => {
		expect(build(makeEditEvent())!.git).toBeNull();
	});
});

describe("collection writer chunk — session/turn linkage", () => {
	const build = getRecordBuilder();

	it("propagates session_id from session field", () => {
		expect(build(makeEditEvent({ session: "sess-123" }))!.session_id).toBe("sess-123");
	});

	it("propagates turn_id", () => {
		expect(build(makeEditEvent({ turn_id: "turn-abc" }))!.turn_id).toBe("turn-abc");
	});

	it("propagates tool_use_id", () => {
		expect(build(makeEditEvent({ tool_use_id: "tu-001" }))!.tool_use_id).toBe("tu-001");
	});

	it("includes fidelity block", () => {
		expect(build(makeEditEvent())!.fidelity).toBeDefined();
	});

	it("includes privacy block", () => {
		expect(build(makeEditEvent())!.privacy).toBeDefined();
	});

	it("includes provider_raw block", () => {
		expect(build(makeEditEvent())!.provider_raw).toBeDefined();
	});
});

describe("collection writer chunk — timestamp fallback (Bug 1)", () => {
	const build = getRecordBuilder();

	it("uses event.ts when present", () => {
		const record = build(makeEditEvent({ ts: "2026-05-19T12:00:00Z" }));
		expect(record!.ts).toBe("2026-05-19T12:00:00Z");
	});

	it("generates an ISO timestamp when event.ts is absent", () => {
		// makeEditEvent sets ts — build one without it
		const noTsRecord = build({
			event_type: "tool_use",
			tool_name: "Edit",
			tool_input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
		});
		expect(noTsRecord).not.toBeNull();
		expect(noTsRecord!.ts).not.toBe("");
		// Must be a valid ISO 8601 timestamp
		expect(new Date(noTsRecord!.ts as string).toISOString()).toBe(noTsRecord!.ts);
	});

	it("generates an ISO timestamp when event.ts is empty string", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			ts: "",
		});
		expect(record).not.toBeNull();
		expect(record!.ts).not.toBe("");
		expect(new Date(record!.ts as string).toISOString()).toBe(record!.ts);
	});
});

describe("collection writer chunk — fidelity (Bug 2)", () => {
	const build = getRecordBuilder();

	it("produces interlinked_capped fidelity for capped Bash response", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "cat huge.log" },
			tool_response: {
				stdout: "truncated output...",
				stderr: "",
				exitCode: 0,
				_interlinked_truncated_bytes: 1048576,
			},
			tool_output_bytes: 1048576,
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record).not.toBeNull();
		const fidelity = record!.fidelity as {
			record: { source: string; completeness: string };
			fields: Record<string, { completeness: string; interlinked_capped: boolean; provider_payload_bytes: number; captured_bytes: number }>;
		};
		expect(fidelity.record.completeness).toBe("interlinked_capped");
		expect(fidelity.fields["observation.stdout"]).toBeDefined();
		expect(nonNull(fidelity.fields["observation.stdout"]).completeness).toBe("interlinked_capped");
		expect(nonNull(fidelity.fields["observation.stdout"]).interlinked_capped).toBe(true);
		expect(nonNull(fidelity.fields["observation.stdout"]).provider_payload_bytes).toBe(1048576);
		expect(nonNull(fidelity.fields["observation.stdout"]).captured_bytes).toBeGreaterThan(0);
	});

	it("produces complete fidelity for uncapped Bash response", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input: { command: "echo hi" },
			tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
			tool_output_bytes: 30,
			ts: "2026-05-19T00:00:00Z",
		});
		expect(record).not.toBeNull();
		const fidelity = record!.fidelity as {
			record: { source: string; completeness: string };
			fields: Record<string, { completeness: string; interlinked_capped: boolean }>;
		};
		expect(fidelity.record.completeness).toBe("complete");
		expect(fidelity.fields["observation.stdout"]).toBeDefined();
		expect(nonNull(fidelity.fields["observation.stdout"]).completeness).toBe("complete");
		expect(nonNull(fidelity.fields["observation.stdout"]).interlinked_capped).toBe(false);
	});

	it("produces interlinked_capped fidelity for capped file_read response", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Read",
			tool_input: { file_path: "/big.log" },
			tool_response: { content: "partial...", _interlinked_truncated_bytes: 500000 },
			tool_output_bytes: 500000,
			ts: "2026-05-19T00:00:00Z",
		});
		const fidelity = record!.fidelity as {
			record: { completeness: string };
			fields: Record<string, { completeness: string; interlinked_capped: boolean }>;
		};
		expect(fidelity.record.completeness).toBe("interlinked_capped");
		expect(fidelity.fields["observation.content"]).toBeDefined();
		expect(nonNull(fidelity.fields["observation.content"]).completeness).toBe("interlinked_capped");
	});

	it("produces complete fidelity for capped search response", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "Grep",
			tool_input: { pattern: "TODO" },
			tool_response: "line1\nline2",
			ts: "2026-05-19T00:00:00Z",
		});
		const fidelity = record!.fidelity as {
			record: { completeness: string };
			fields: Record<string, { completeness: string }>;
		};
		// String response has no _interlinked_truncated_bytes marker
		expect(fidelity.record.completeness).toBe("complete");
		expect(fidelity.fields["observation.result_text"]).toBeDefined();
		expect(nonNull(fidelity.fields["observation.result_text"]).completeness).toBe("complete");
	});

	it("produces complete fidelity for fetch response with result", () => {
		const record = build({
			event_type: "tool_use",
			tool_name: "WebFetch",
			tool_input: { url: "https://example.com" },
			tool_response: { status: 200, result: "page content" },
			ts: "2026-05-19T00:00:00Z",
		});
		const fidelity = record!.fidelity as {
			record: { completeness: string };
			fields: Record<string, { completeness: string }>;
		};
		expect(fidelity.record.completeness).toBe("complete");
		expect(fidelity.fields["observation.result"]).toBeDefined();
		expect(nonNull(fidelity.fields["observation.result"]).completeness).toBe("complete");
	});

	it("has empty fields for pre-phase events", () => {
		const record = build({
			event_type: "tool_use_start",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			ts: "2026-05-19T00:00:00Z",
		});
		const fidelity = record!.fidelity as {
			record: { completeness: string };
			fields: Record<string, unknown>;
		};
		expect(fidelity.record.completeness).toBe("complete");
		expect(Object.keys(fidelity.fields)).toHaveLength(0);
	});

	it("has empty fields for tool classes without fidelity mapping (file_edit)", () => {
		const record = build(makeEditEvent({ tool_response: "success" }));
		const fidelity = record!.fidelity as {
			record: { completeness: string };
			fields: Record<string, unknown>;
		};
		expect(fidelity.record.completeness).toBe("complete");
		expect(Object.keys(fidelity.fields)).toHaveLength(0);
	});
});

describe("collection writer chunk — embedding safety", () => {
	it("contains no backtick so it splices into template literals", () => {
		expect(COLLECTION_WRITER_CHUNK).not.toContain("`");
	});

	it("contains no template interpolation markers", () => {
		expect(COLLECTION_WRITER_CHUNK).not.toContain("${");
	});
});
