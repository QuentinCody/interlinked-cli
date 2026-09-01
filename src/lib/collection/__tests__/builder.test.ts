import { describe, expect, it } from "vitest";
import { nonNull } from "../../non-null.js";
import { buildCollectionRecord } from "../builder.js";

// Helper: minimal activity event with required fields
function baseEvent(overrides: Record<string, unknown> = {}) {
	return {
		ts: "2026-05-19T12:00:00.000Z",
		agent: "test-agent",
		session: "sess-1",
		type: "tool_use",
		event_type: "tool_use",
		hook_event: "PostToolUse",
		...overrides,
	};
}

function preEvent(overrides: Record<string, unknown> = {}) {
	return baseEvent({
		type: "tool_use_start",
		event_type: "tool_use_start",
		hook_event: "PreToolUse",
		...overrides,
	});
}

// -------------------------------------------------------
// Tool class detection
// -------------------------------------------------------
describe("buildCollectionRecord — tool class detection", () => {
	it("returns null for non-tool events", () => {
		expect(buildCollectionRecord(baseEvent({ event_type: "session_start" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "session_end" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "user_prompt" }))).toBeNull();
		expect(buildCollectionRecord(baseEvent({ event_type: "notification" }))).toBeNull();
	});

	it("returns null for guard telemetry regardless of schema_version (type-based, not version-based)", () => {
		// Guard exclusion is keyed on record TYPE (guard_*), not the version
		// number. After the schema unification, guard records carry version 5
		// (was 3); the exclusion must hold across every historical version.
		for (const schema_version of [3, 4, 5, undefined]) {
			for (const event_type of ["guard_block", "guard_warn", "guard_allow"]) {
				expect(
					buildCollectionRecord(baseEvent({ event_type, schema_version })),
					`event_type=${event_type} schema_version=${schema_version}`,
				).toBeNull();
			}
		}
	});

	it("collects tool events regardless of schema_version (version = format, family = type)", () => {
		for (const schema_version of [3, 4, 5]) {
			const rec = buildCollectionRecord(
				baseEvent({ tool_name: "Bash", tool_input: { command: "ls" }, schema_version }),
			);
			expect(rec, `schema_version=${schema_version}`).not.toBeNull();
		}
	});

	it.each([
		["Bash", "shell_exec"],
		["Shell", "shell_exec"],
		["shell", "shell_exec"],
		["run_command", "shell_exec"],
		["Read", "file_read"],
		["ReadFile", "file_read"],
		["read_file", "file_read"],
		["view", "file_read"],
		["Edit", "file_edit"],
		["EditFile", "file_edit"],
		["edit_file", "file_edit"],
		["MultiEdit", "file_edit"],
		["str_replace", "file_edit"],
		["Write", "file_write"],
		["WriteFile", "file_write"],
		["write_file", "file_write"],
		["CreateFile", "file_write"],
		["create_file", "file_write"],
		["apply_patch", "file_edit"],
		["Grep", "search"],
		["grep", "search"],
		["SearchFiles", "search"],
		["search_files", "search"],
		["Glob", "search"],
		["glob", "search"],
		["ListFiles", "search"],
		["list_files", "search"],
		["WebFetch", "fetch"],
		["web_fetch", "fetch"],
		["WebSearch", "fetch"],
		["web_search", "fetch"],
		["NotebookEdit", "notebook_edit"],
		["notebook_edit", "notebook_edit"],
		["TaskCreate", "task"],
		["TaskUpdate", "task"],
		["TaskStop", "task"],
		["mcp__context7__resolve-library-id", "mcp_call"],
		["SomeMcpTool", "other"],
	])("maps %s → %s", (toolName, expectedClass) => {
		const rec = buildCollectionRecord(baseEvent({ tool: toolName, tool_name: toolName }));
		expect(rec).not.toBeNull();
		expect(rec!.tool_class).toBe(expectedClass);
	});
});

describe("buildCollectionRecord — mcp_call", () => {
	it("parses Claude/Codex-style mcp__server__tool provider names", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "mcp__context7__resolve-library-id",
				tool_input: { libraryName: "react" },
				tool_response: { content: [{ type: "text", text: "react docs" }] },
			}),
		)!;

		expect(rec.tool_class).toBe("mcp_call");
		expect(rec.action).toEqual({
			server: "context7",
			tool: "resolve-library-id",
			params: { libraryName: "react" },
			params_ref: null,
		});
		expect(rec.observation).toEqual({
			result: { content: [{ type: "text", text: "react docs" }] },
			result_ref: null,
		});
	});

	it("lets explicit tool_input server/tool fields override provider-name parsing", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "mcp__context7__resolve-library-id",
				tool_input: {
					server: "docs",
					tool: "lookup",
					params: { q: "react" },
				},
			}),
		)!;

		expect(rec.action).toEqual({
			server: "docs",
			tool: "lookup",
			params: { q: "react" },
			params_ref: null,
		});
	});
});

// -------------------------------------------------------
// shell_exec records
// -------------------------------------------------------
describe("buildCollectionRecord — shell_exec", () => {
	const shellPostEvent = baseEvent({
		tool_name: "Bash",
		tool_input: { command: "npm test" },
		tool_response: { stdout: "ok", stderr: "", exitCode: 0 },
		tool_output_bytes: 42,
		cwd: "/repo",
		git_head: "abc123",
		git_branch: "main",
	});

	it("sets schema and kind on post record", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.schema).toBe("collection.v1");
		expect(rec.kind).toBe("tool_event");
	});

	it("sets phase and tool_class on post record", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.phase).toBe("post");
		expect(rec.tool_class).toBe("shell_exec");
		expect(rec.provider_tool).toBe("Bash");
	});

	it("extracts shell action from tool_input", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
	});

	it("extracts shell observation from structured response", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.observation).toMatchObject({ stdout: "ok", stderr: "", exit_code: 0 });
	});

	it("reads exit_code from the exit_code alias when exitCode is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "x" }, tool_response: { exit_code: 2 } }),
		)!;
		expect(rec.observation).toMatchObject({ exit_code: 2 });
	});

	it("reads exit_code from the returncode alias when exitCode/exit_code are absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "x" }, tool_response: { returncode: 3 } }),
		)!;
		expect(rec.observation).toMatchObject({ exit_code: 3 });
	});

	it("reads duration_ms from the response object", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "x" },
				tool_response: { stdout: "x", duration_ms: 150 },
			}),
		)!;
		expect(rec.observation).toMatchObject({ duration_ms: 150 });
	});

	it("carries git context", () => {
		const rec = buildCollectionRecord(shellPostEvent)!;
		expect(rec.git).toEqual({ head: "abc123", branch: "main" });
	});

	it("builds post record with string response (Codex-style)", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_response: "file1.ts\nfile2.ts",
				tool_output_bytes: 20,
			}),
		)!;

		expect(rec.observation).toMatchObject({
			stdout: "file1.ts\nfile2.ts",
			combined_output: true,
		});
	});

	it("builds pre record with action only", () => {
		const rec = buildCollectionRecord(
			preEvent({
				tool_name: "Bash",
				tool_input: { command: "npm test" },
				cwd: "/repo",
			}),
		)!;

		expect(rec.phase).toBe("pre");
		expect(rec.action).toEqual({ command: "npm test", cwd: "/repo" });
		expect(rec.observation).toBeNull();
	});
});

// -------------------------------------------------------
// file_read records
// -------------------------------------------------------
describe("buildCollectionRecord — file_read", () => {
	it("builds post record with structured file response", () => {
		const content = "line1\nline2\nline3";
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/src/main.ts", offset: 0, limit: 100 },
				tool_response: { type: "text", file: { filePath: "/src/main.ts", content } },
			}),
		)!;

		expect(rec.tool_class).toBe("file_read");
		expect(rec.action).toEqual({ path: "/src/main.ts", offset: 0, limit: 100 });
		expect(rec.observation).toMatchObject({
			content,
			line_count: 3,
		});
	});

	it("builds post record with string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/src/main.ts" },
				tool_response: "the file content",
			}),
		)!;

		expect(rec.observation).toMatchObject({ content: "the file content" });
	});
});

// -------------------------------------------------------
// file_edit records
// -------------------------------------------------------
describe("buildCollectionRecord — file_edit", () => {
	it("maps Edit with old_string/new_string to single hunk", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/src/main.ts",
					old_string: "foo",
					new_string: "bar",
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: { hunks: [{ old: "foo", new: "bar" }] },
		});
		expect(rec.observation).toMatchObject({ applied: true });
	});

	it("maps MultiEdit to multiple hunks", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "MultiEdit",
				tool_input: {
					file_path: "/src/main.ts",
					edits: [
						{ old_string: "a", new_string: "b" },
						{ old_string: "c", new_string: "d" },
					],
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: {
				hunks: [
					{ old: "a", new: "b" },
					{ old: "c", new: "d" },
				],
			},
		});
	});

	it("maps apply_patch to file_edit", () => {
		const patchBody = "*** Update File: /src/main.ts\n--- old\n+++ new\n-foo\n+bar";
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: patchBody },
				tool_response: "Patch applied",
			}),
		)!;

		expect(rec.tool_class).toBe("file_edit");
		expect(rec.action).toMatchObject({ path: "/src/main.ts" });
		expect(rec.action).toMatchObject({ diff: { hunks: [{ old: "", new: patchBody }] } });
	});

	it("does not treat a non-MultiEdit tool with a stray edits array as MultiEdit", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: {
					file_path: "/x.ts",
					old_string: "a",
					new_string: "b",
					edits: [{ old_string: "z", new_string: "y" }],
				},
			}),
		)!;

		expect(rec.action).toMatchObject({ diff: { hunks: [{ old: "a", new: "b" }] } });
	});

	it("defaults missing old_string/new_string on a single Edit to empty strings", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: { file_path: "/x.ts" },
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.action).toMatchObject({ diff: { hunks: [{ old: "", new: "" }] } });
	});
});

// -------------------------------------------------------
// file_write records
// -------------------------------------------------------
describe("buildCollectionRecord — file_write", () => {
	it("maps Write to file_write", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Write",
				tool_input: { file_path: "/new.ts", content: "export const x = 1;" },
				tool_response: "File created successfully at /new.ts",
				is_new_file: true,
			}),
		)!;

		expect(rec.tool_class).toBe("file_write");
		expect(rec.action).toMatchObject({
			path: "/new.ts",
			is_new_file: true,
			content: "export const x = 1;",
		});
		expect(rec.observation).toMatchObject({ applied: true });
	});

	it("sets content to null when input.content is not a string", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Write",
				tool_input: { file_path: "/x.ts" },
				tool_response: "File created",
			}),
		)!;

		expect(rec.action).toMatchObject({ content: null });
	});

	it("sets is_new_file to false when the event does not flag a new file", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Write",
				tool_input: { file_path: "/existing.ts", content: "x" },
				tool_response: "File updated",
				is_new_file: false,
			}),
		)!;

		expect(rec.action).toMatchObject({ is_new_file: false });
	});
});

// -------------------------------------------------------
// search records
// -------------------------------------------------------
describe("buildCollectionRecord — search", () => {
	it("maps Grep to search", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Grep",
				tool_input: { pattern: "TODO", path: "/src" },
				tool_response: "src/main.ts:5:// TODO fix",
			}),
		)!;

		expect(rec.tool_class).toBe("search");
		expect(rec.action).toEqual({ pattern: "TODO", path: "/src", flags: null });
		expect(rec.observation).toMatchObject({ result_text: "src/main.ts:5:// TODO fix" });
	});

	it("defaults pattern to an empty string when no pattern/query/glob field is present", () => {
		const rec = buildCollectionRecord(baseEvent({ tool_name: "Grep", tool_input: {} }))!;
		expect(rec.action).toEqual({ pattern: "", path: null, flags: null });
	});
});

// -------------------------------------------------------
// fetch records
// -------------------------------------------------------
describe("buildCollectionRecord — fetch", () => {
	it("maps WebFetch to fetch", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com", prompt: "get data" },
				tool_response: { status: 200, result: "page content" },
			}),
		)!;

		expect(rec.tool_class).toBe("fetch");
		expect(rec.action).toEqual({ url: "https://example.com", prompt: "get data" });
		expect(rec.observation).toMatchObject({ status: 200, result: "page content" });
	});

	it("defaults url to an empty string when neither url nor query is present", () => {
		const rec = buildCollectionRecord(baseEvent({ tool_name: "WebFetch", tool_input: {} }))!;
		expect(rec.action).toEqual({ url: "", prompt: null });
	});
});

// -------------------------------------------------------
// Fidelity
// -------------------------------------------------------
describe("buildCollectionRecord — fidelity", () => {
	it("marks interlinked_capped when _interlinked_truncated_bytes present", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "find /" },
				tool_response: {
					stdout: "truncated...",
					_interlinked_truncated_bytes: 1048576,
				},
				tool_output_bytes: 1048576,
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(stdoutFidelity).toBeDefined();
		expect(nonNull(stdoutFidelity).interlinked_capped).toBe(true);
		expect(nonNull(stdoutFidelity).completeness).toBe("interlinked_capped");
		expect(nonNull(stdoutFidelity).source).toBe("provider_hook");
		expect(nonNull(stdoutFidelity).provider_payload_bytes).toBe(1048576);
	});

	it("marks complete when no truncation signals", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
				tool_output_bytes: 5,
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(nonNull(stdoutFidelity).interlinked_capped).toBe(false);
		expect(nonNull(stdoutFidelity).completeness).toBe("complete");
		expect(nonNull(stdoutFidelity).captured_bytes).toBe(Buffer.byteLength("hi", "utf8"));
		expect(rec.fidelity.record.completeness).toBe("complete");
	});

	it("defaults provider_payload_bytes to 0 when tool_output_bytes is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(nonNull(stdoutFidelity).provider_payload_bytes).toBe(0);
	});

	it("marks absent when observation field is missing", () => {
		const rec = buildCollectionRecord(
			preEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
			}),
		)!;

		expect(rec.fidelity.record.completeness).toBe("complete");
		expect(Object.keys(rec.fidelity.fields)).toHaveLength(0);
	});

	it("omits a fidelity field entry when the observation field itself is null", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: { stderr: "oops", exitCode: 1 },
				tool_output_bytes: 10,
			}),
		)!;

		expect(rec.observation).toMatchObject({ stdout: null });
		expect(rec.fidelity.fields["observation.stdout"]).toBeUndefined();
		expect(rec.fidelity.fields["observation.stderr"]).toBeDefined();
	});

	it("builds exactly the shell_exec field map (stdout + stderr) when both are present", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: { stdout: "hi", stderr: "warn", exitCode: 0 },
				tool_output_bytes: 10,
			}),
		)!;

		expect(Object.keys(rec.fidelity.fields).sort()).toEqual(["observation.stderr", "observation.stdout"]);
	});

	it("builds exactly the file_read field map (content) for a Read", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/x.ts" },
				tool_response: "file body",
				tool_output_bytes: 10,
			}),
		)!;

		expect(Object.keys(rec.fidelity.fields)).toEqual(["observation.content"]);
	});

	it("builds exactly the search field map (result_text) for a Grep", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Grep",
				tool_input: { pattern: "TODO" },
				tool_response: "src/main.ts:5:// TODO",
				tool_output_bytes: 10,
			}),
		)!;

		expect(Object.keys(rec.fidelity.fields)).toEqual(["observation.result_text"]);
	});

	it("does not mark fidelity as capped for a plain string shell response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_response: "file1.ts\nfile2.ts",
				tool_output_bytes: 20,
			}),
		)!;

		const stdoutFidelity = rec.fidelity.fields["observation.stdout"];
		expect(nonNull(stdoutFidelity).interlinked_capped).toBe(false);
		expect(nonNull(stdoutFidelity).completeness).toBe("complete");
	});
});

// -------------------------------------------------------
// Privacy defaults
// -------------------------------------------------------
describe("buildCollectionRecord — privacy", () => {
	it("sets unscanned for post events with observation", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: { stdout: "hi", stderr: "", exitCode: 0 },
			}),
		)!;

		expect(rec.privacy.redaction_status).toBe("unscanned");
		expect(rec.privacy.allowed_for_training).toBe(false);
		expect(rec.privacy.allowed_for_cloud_upload).toBe(false);
		expect(rec.privacy.sensitivity).toBe("unknown");
		expect(rec.privacy.contains_sensitive).toBe("unknown");
		expect(rec.privacy.redaction_passes).toEqual([]);
	});

	it("sets not_required for post events with no observation", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
			}),
		)!;

		expect(rec.privacy.redaction_status).toBe("not_required");
	});

	it("sets not_required for pre events", () => {
		const rec = buildCollectionRecord(
			preEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;

		expect(rec.privacy.redaction_status).toBe("not_required");
	});
});

// -------------------------------------------------------
// Provider metadata
// -------------------------------------------------------
describe("buildCollectionRecord — provider_raw", () => {
	it("carries tool_response_sha256 from activity event", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: "hi",
				tool_response_sha256: "abcd1234",
			}),
		)!;

		expect(rec.provider_raw.tool_response_sha256).toBe("abcd1234");
	});

	it("carries tool_input_sha256 (content_sha256) from activity event", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: "hi",
				content_sha256: "input-hash-abc",
			}),
		)!;

		expect(rec.provider_raw.tool_input_sha256).toBe("input-hash-abc");
	});
});

// -------------------------------------------------------
// Provider detection
// -------------------------------------------------------
describe("buildCollectionRecord — provider", () => {
	it("detects claude-code from hook_event PascalCase", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;
		expect(rec.provider).toBe("claude-code");
	});

	it("detects codex from client_runner field", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				client_runner: "codex",
			}),
		)!;
		expect(rec.provider).toBe("codex");
	});

	it("detects mcp-proxy from client_runner field", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, client_runner: "mcp-proxy" }),
		)!;
		expect(rec.provider).toBe("mcp-proxy");
	});

	it("detects copilot from client_runner field", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, client_runner: "copilot" }),
		)!;
		expect(rec.provider).toBe("copilot");
	});

	it.each(["gemini-cli", "cursor", "opencode", "pi"])(
		"detects %s from client_runner field",
		(provider) => {
			const rec = buildCollectionRecord(
				baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, client_runner: provider }),
			)!;
			expect(rec.provider).toBe(provider);
		},
	);

	it("detects gemini-cli from a BeforeTool/AfterTool hook_event", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, hook_event: "BeforeTool" }),
		)!;
		expect(rec.provider).toBe("gemini-cli");
	});

	it("detects cursor from cursor_version/conversation_id fields", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				hook_event: undefined,
				cursor_version: "1.2.3",
			}),
		)!;
		expect(rec.provider).toBe("cursor");
	});
});

// -------------------------------------------------------
// Edge cases
// -------------------------------------------------------
describe("buildCollectionRecord — edge cases", () => {
	it("handles null tool_response gracefully", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: null }),
		)!;

		expect(rec.observation).toBeNull();
	});

	it("handles missing tool_input gracefully", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", event_type: "tool_use" }),
		)!;

		expect(rec).not.toBeNull();
		expect(rec.action).toMatchObject({ command: "" });
	});

	it("falls back to session_id_hint when session is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				session: undefined,
				session_id_hint: "hint-1",
			}),
		)!;
		expect(rec.session_id).toBe("hint-1");
	});

	it("includes seq when the event carries a numeric seq", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, seq: 7 }),
		)!;
		expect(rec.seq).toBe(7);
	});

	it("omits seq when the event carries no numeric seq", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;
		expect(rec.seq).toBeUndefined();
	});

	it("carries session_id and tool_use_id", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				session: "sess-42",
				tool_use_id: "tu-7",
				turn_id: "turn-3",
			}),
		)!;

		expect(rec.session_id).toBe("sess-42");
		expect(rec.tool_use_id).toBe("tu-7");
		expect(rec.turn_id).toBe("turn-3");
	});
});

// -------------------------------------------------------
// mcp_call — parseMcpProviderTool edge shapes
// -------------------------------------------------------
describe("buildCollectionRecord — mcp_call provider-name edge shapes", () => {
	it("falls back to the whole tool name when no server delimiter is present", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "mcp__onlyname", tool_input: {} }),
		)!;

		expect(rec.action).toEqual({
			server: null,
			tool: "onlyname",
			params: {},
			params_ref: null,
		});
	});

	it("treats an empty server segment as absent (null)", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "mcp____toolname", tool_input: {} }),
		)!;

		expect(rec.action).toEqual({
			server: null,
			tool: "toolname",
			params: {},
			params_ref: null,
		});
	});

	it("falls back to the full remainder when the tool segment after the delimiter is empty", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "mcp__server__", tool_input: {} }),
		)!;

		expect(rec.action).toEqual({
			server: "server",
			tool: "server__",
			params: {},
			params_ref: null,
		});
	});
});

// -------------------------------------------------------
// apply_patch — Move to: header
// -------------------------------------------------------
describe("buildCollectionRecord — apply_patch Move to header", () => {
	it("extracts the destination path from a Move to header", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: {
					command: "*** Move to: /src/renamed.ts\n*** Update File: /src/main.ts",
				},
				tool_response: "Patch applied",
			}),
		)!;

		expect(rec.action).toMatchObject({ path: "/src/renamed.ts" });
	});
});

// -------------------------------------------------------
// Mutation-result observation (file_edit/file_write) — non-string responses
// -------------------------------------------------------
describe("buildCollectionRecord — mutation result observation edge shapes", () => {
	it("treats a non-string edit response as applied with no result message", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
				tool_response: {},
			}),
		)!;

		expect(rec.observation).toEqual({ applied: true, result_message: null, provider_echo_ref: null });
	});

	it("marks applied false when the response message signals failure", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Edit",
				tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
				tool_response: "Error: failed to apply edit",
			}),
		)!;

		expect(rec.observation).toEqual({
			applied: false,
			result_message: "Error: failed to apply edit",
			provider_echo_ref: null,
		});
	});
});

// -------------------------------------------------------
// MultiEdit — malformed entries
// -------------------------------------------------------
describe("buildCollectionRecord — MultiEdit malformed entries", () => {
	it("skips non-object entries in the edits array", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "MultiEdit",
				tool_input: {
					file_path: "/src/main.ts",
					edits: [null, "not-an-object", { old_string: "a", new_string: "b" }],
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: { hunks: [{ old: "a", new: "b" }] },
		});
	});

	it("defaults missing old_string/new_string on an edit entry to empty strings", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "MultiEdit",
				tool_input: {
					file_path: "/src/main.ts",
					edits: [{}],
				},
				tool_response: "File edited successfully",
			}),
		)!;

		expect(rec.action).toMatchObject({
			path: "/src/main.ts",
			diff: { hunks: [{ old: "", new: "" }] },
		});
	});
});

// -------------------------------------------------------
// shell_exec observation — non-string, non-object response
// -------------------------------------------------------
describe("buildCollectionRecord — shell_exec observation edge shapes", () => {
	it("returns the empty observation shape for a non-string non-object response", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, tool_response: 42 }),
		)!;

		expect(rec.observation).toEqual({ stdout: null, stderr: null, exit_code: null, duration_ms: null });
	});
});

// -------------------------------------------------------
// file_read observation — edge shapes
// -------------------------------------------------------
describe("buildCollectionRecord — file_read observation edge shapes", () => {
	it("returns null content for a non-object non-string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Read", tool_input: { file_path: "/x.ts" }, tool_response: 42 }),
		)!;

		expect(rec.observation).toEqual({ content: null, content_ref: null, line_count: null, byte_count: null });
	});

	it("reads content directly when the response has no nested file object", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/x.ts" },
				tool_response: { content: "direct content" },
			}),
		)!;

		expect(rec.observation).toEqual({
			content: "direct content",
			content_ref: null,
			line_count: 1,
			byte_count: Buffer.byteLength("direct content", "utf8"),
		});
	});

	it("falls back to top-level content when r.file is present but not an object", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/x.ts" },
				tool_response: { file: "not-an-object", content: "fallback content" },
			}),
		)!;

		expect(rec.observation).toMatchObject({ content: "fallback content" });
	});
});

// -------------------------------------------------------
// search observation — non-string response
// -------------------------------------------------------
describe("buildCollectionRecord — search observation edge shapes", () => {
	it("returns a null result_text for a non-string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_response: { raw: true } }),
		)!;

		expect(rec.observation).toEqual({ matches: null, match_count: null, result_text: null });
	});
});

// -------------------------------------------------------
// fetch observation — edge shapes
// -------------------------------------------------------
describe("buildCollectionRecord — fetch observation edge shapes", () => {
	it("falls back to the content field when the response has no result field", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com" },
				tool_response: { status: 200, content: "page body" },
			}),
		)!;

		expect(rec.observation).toEqual({ status: 200, result: "page body", result_ref: null, bytes: null });
	});

	it("returns a null result when neither result nor content fields are present", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com" },
				tool_response: { status: 204 },
			}),
		)!;

		expect(rec.observation).toEqual({ status: 204, result: null, result_ref: null, bytes: null });
	});

	it("wraps a raw string response as the result", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com" },
				tool_response: "raw text body",
			}),
		)!;

		expect(rec.observation).toEqual({ status: null, result: "raw text body", result_ref: null, bytes: null });
	});

	it("returns the empty observation shape for a non-object non-string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_response: 42 }),
		)!;

		expect(rec.observation).toEqual({ status: null, result: null, result_ref: null, bytes: null });
	});
});

// -------------------------------------------------------
// task / notebook_edit / other observations
// -------------------------------------------------------
describe("buildCollectionRecord — task/notebook_edit/other observations", () => {
	it("builds a task observation as a passthrough of the response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "TaskCreate",
				tool_input: { subject: "do thing" },
				tool_response: { task_id: "t1" },
			}),
		)!;

		expect(rec.observation).toEqual({ result: { task_id: "t1" } });
	});

	it("marks notebook_edit applied with a string response message", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "NotebookEdit",
				tool_input: { file_path: "/nb.ipynb", cell: "1" },
				tool_response: "Cell updated",
			}),
		)!;

		expect(rec.observation).toEqual({ applied: true, result_message: "Cell updated" });
	});

	it("marks notebook_edit applied with a null result_message for a non-string response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "NotebookEdit",
				tool_input: { file_path: "/nb.ipynb", cell: "1" },
				tool_response: { ok: true },
			}),
		)!;

		expect(rec.observation).toEqual({ applied: true, result_message: null });
	});

	it("builds an other observation as a passthrough of the provider response", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "SomeMcpTool", tool_input: {}, tool_response: { anything: 1 } }),
		)!;

		expect(rec.observation).toEqual({ provider_output: { anything: 1 }, provider_output_ref: null });
	});
});

// -------------------------------------------------------
// Fidelity — non-string field values
// -------------------------------------------------------
describe("buildCollectionRecord — fidelity byte counting for non-string field values", () => {
	it("computes captured_bytes via JSON serialization for a non-string fidelity field", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "WebFetch",
				tool_input: { url: "https://example.com" },
				tool_response: { result: { nested: "value" } },
				tool_output_bytes: 10,
			}),
		)!;

		const resultFidelity = rec.fidelity.fields["observation.result"];
		expect(resultFidelity).toBeDefined();
		expect(nonNull(resultFidelity).captured_bytes).toBe(
			Buffer.byteLength(JSON.stringify({ nested: "value" }), "utf8"),
		);
	});
});

// -------------------------------------------------------
// Guard telemetry — legacy type field discriminator
// -------------------------------------------------------
describe("buildCollectionRecord — guard telemetry via legacy type field", () => {
	it("returns null when only the legacy type field (not event_type) is guard_-prefixed", () => {
		expect(
			buildCollectionRecord(baseEvent({ event_type: "tool_use", type: "guard_block" })),
		).toBeNull();
	});

	it("returns null on a guard-prefixed legacy type even when a real tool_name is present (isolates the guard check from the tool_name gate)", () => {
		expect(
			buildCollectionRecord(
				baseEvent({
					event_type: "tool_use",
					type: "guard_block",
					tool_name: "Bash",
					tool_input: { command: "x" },
				}),
			),
		).toBeNull();
	});
});

// -------------------------------------------------------
// event_type resolution — fallback chain
// -------------------------------------------------------
describe("buildCollectionRecord — event_type resolution fallback", () => {
	it("falls back to the legacy type field when event_type is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ event_type: undefined, type: "tool_use", tool_name: "Bash" }),
		)!;

		expect(rec.phase).toBe("post");
	});

	it("returns null when both event_type and the legacy type field are absent", () => {
		expect(
			buildCollectionRecord(baseEvent({ event_type: undefined, type: undefined, tool_name: "Bash" })),
		).toBeNull();
	});
});

// -------------------------------------------------------
// tool name resolution — missing tool_name/tool
// -------------------------------------------------------
describe("buildCollectionRecord — tool name resolution", () => {
	it("returns null when neither tool_name nor tool is present", () => {
		expect(buildCollectionRecord(baseEvent({ tool_name: undefined }))).toBeNull();
	});

	it("falls back to the legacy tool field when tool_name is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: undefined, tool: "Bash", tool_input: { command: "echo" } }),
		)!;

		expect(rec.provider_tool).toBe("Bash");
	});
});

// -------------------------------------------------------
// ts field — missing fallback
// -------------------------------------------------------
describe("buildCollectionRecord — ts field fallback", () => {
	it("defaults ts to an empty string when the event carries no ts", () => {
		const rec = buildCollectionRecord(
			baseEvent({ ts: undefined, tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;

		expect(rec.ts).toBe("");
	});
});

describe("buildCollectionRecord — outcome discriminator (finding 5)", () => {
	it("a successful post tool event carries outcome 'ok'", () => {
		const rec = buildCollectionRecord(baseEvent({ event_type: "tool_use", tool_name: "Bash" }))!;
		expect(rec.phase).toBe("post");
		expect(rec.outcome).toBe("ok");
	});

	it("a failed post tool event carries outcome 'error'", () => {
		const rec = buildCollectionRecord(
			baseEvent({ event_type: "tool_use_error", tool_name: "Bash" }),
		)!;
		expect(rec.phase).toBe("post");
		expect(rec.outcome).toBe("error");
	});

	it("a pre tool event carries no outcome (none yet)", () => {
		const rec = buildCollectionRecord(preEvent({ tool_name: "Bash" }))!;
		expect(rec.phase).toBe("pre");
		expect(rec.outcome).toBeUndefined();
	});
});

// -------------------------------------------------------
// Git context — buildGit
// -------------------------------------------------------
describe("buildCollectionRecord — git context", () => {
	it("returns null git when neither git_head nor git_branch is present", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } }),
		)!;
		expect(rec.git).toBeNull();
	});

	it("carries a partial git context when only git_head is present", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, git_head: "abc123" }),
		)!;
		expect(rec.git).toEqual({ head: "abc123", branch: null });
	});

	it("carries a partial git context when only git_branch is present", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo" }, git_branch: "main" }),
		)!;
		expect(rec.git).toEqual({ head: null, branch: "main" });
	});
});

// -------------------------------------------------------
// extractFilePath — apply_patch header parsing edge shapes
// -------------------------------------------------------
describe("buildCollectionRecord — extractFilePath field-alias resolution", () => {
	it("resolves the file path from the filePath alias when file_path is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Edit", tool_input: { filePath: "/alias.ts", old_string: "a", new_string: "b" } }),
		)!;
		expect(rec.action).toMatchObject({ path: "/alias.ts" });
	});

	it("resolves the file path from the path alias when file_path/filePath are absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Edit", tool_input: { path: "/alias2.ts", old_string: "a", new_string: "b" } }),
		)!;
		expect(rec.action).toMatchObject({ path: "/alias2.ts" });
	});

	it("defaults path to an empty string when no path field is present", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Edit", tool_input: { old_string: "a", new_string: "b" } }),
		)!;
		expect(rec.action).toMatchObject({ path: "" });
	});
});

describe("buildCollectionRecord — extractFilePath apply_patch header anchoring", () => {
	it("does not treat an embedded 'Move to:' substring mid-line as the destination header", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: "prefix *** Move to: /should-not-match.ts\n*** Update File: /src/real.ts" },
				tool_response: "Patch applied",
			}),
		)!;
		expect(rec.action).toMatchObject({ path: "/src/real.ts" });
	});

	it("does not treat an embedded 'Update File:' substring mid-line as a path header", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: "prefix *** Update File: /should-not-match.ts" },
				tool_response: "Patch applied",
			}),
		)!;
		expect(rec.action).toMatchObject({ path: "" });
	});

	it("trims trailing whitespace from a Move to destination path", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: "*** Move to: /dest.ts   \n*** Update File: /src/main.ts" },
				tool_response: "Patch applied",
			}),
		)!;
		expect(rec.action).toMatchObject({ path: "/dest.ts" });
	});

	it("trims trailing whitespace from an Update File path", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: "*** Update File: /src/main.ts   " },
				tool_response: "Patch applied",
			}),
		)!;
		expect(rec.action).toMatchObject({ path: "/src/main.ts" });
	});

	it("returns an empty path when apply_patch command has no recognizable header", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { command: "some random patch body with no headers" },
				tool_response: "Patch applied",
			}),
		)!;
		expect(rec.action).toMatchObject({ path: "" });
	});
});

// -------------------------------------------------------
// notebook_edit / other / task actions
// -------------------------------------------------------
describe("buildCollectionRecord — notebook_edit action", () => {
	it("builds the notebook_edit action with path, cell, and diff", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "NotebookEdit",
				tool_input: { file_path: "/nb.ipynb", cell: "3", diff: { before: "a", after: "b" } },
				tool_response: "Cell updated",
			}),
		)!;
		expect(rec.action).toEqual({ path: "/nb.ipynb", cell: "3", diff: { before: "a", after: "b" } });
	});

	it("defaults diff to null when input.diff is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "NotebookEdit",
				tool_input: { file_path: "/nb.ipynb", cell: "1" },
				tool_response: "Cell updated",
			}),
		)!;
		expect(rec.action).toEqual({ path: "/nb.ipynb", cell: "1", diff: null });
	});
});

describe("buildCollectionRecord — other action", () => {
	it("builds the other action as a passthrough of the provider input", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "SomeMcpTool", tool_input: { anything: 1 } }),
		)!;
		expect(rec.action).toEqual({ provider_input: { anything: 1 }, provider_input_ref: null });
	});
});

describe("buildCollectionRecord — task action", () => {
	it("builds the task action from subject/task/description fields", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "TaskCreate",
				tool_input: { subject: "write tests", description: "cover survivors" },
			}),
		)!;
		expect(rec.action).toEqual({ task: "write tests", params: "cover survivors" });
	});

	it("falls back to the task field when subject is absent", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "TaskCreate", tool_input: { task: "fallback task" } }),
		)!;
		expect(rec.action).toEqual({ task: "fallback task", params: null });
	});

	it("defaults task to an empty string when neither subject nor task is present", () => {
		const rec = buildCollectionRecord(baseEvent({ tool_name: "TaskCreate", tool_input: {} }))!;
		expect(rec.action).toEqual({ task: "", params: null });
	});
});

// -------------------------------------------------------
// apply_patch — hunks fallback when neither command nor patch is present
// (mutation: file_edit's apply_patch branch defaults `new` to "" when both
// input.command and input.patch are absent; a mutant that changes that
// fallback would leak a sentinel string into the persisted diff hunk)
// -------------------------------------------------------
describe("buildCollectionRecord — apply_patch hunks empty fallback", () => {
	it("produces an empty new-hunk body when neither command nor patch is present on the input", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: {},
				tool_response: "Patch applied",
			}),
		)!;

		expect(rec.action).toMatchObject({ diff: { hunks: [{ old: "", new: "" }] } });
	});

	it("prefers patch over an absent command for the new-hunk body", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "apply_patch",
				tool_input: { patch: "*** Update File: /x.ts\n-a\n+b" },
				tool_response: "Patch applied",
			}),
		)!;

		expect(rec.action).toMatchObject({ diff: { hunks: [{ old: "", new: "*** Update File: /x.ts\n-a\n+b" }] } });
	});
});

// -------------------------------------------------------
// file_read observation — content stays null (and byte/line accounting must
// not throw) when the response is a plain object with neither `.file` nor
// `.content` (mutation: the ternaries guarding content!==null before
// content.split(...) / Buffer.byteLength(...) — content is exactly `null`
// here, and both of those calls throw a TypeError on a null argument)
// -------------------------------------------------------
describe("buildCollectionRecord — file_read null-content byte/line accounting", () => {
	it("does not throw when the response object carries neither .file nor .content", () => {
		expect(() =>
			buildCollectionRecord(
				baseEvent({
					tool_name: "Read",
					tool_input: { file_path: "/x.ts" },
					tool_response: {},
				}),
			),
		).not.toThrow();
	});

	it("reports content, line_count, and byte_count all as null (not a thrown error) for that response shape", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Read",
				tool_input: { file_path: "/x.ts" },
				tool_response: {},
			}),
		)!;
		expect(rec.observation).toEqual({ content: null, content_ref: null, line_count: null, byte_count: null });
	});
});

// -------------------------------------------------------
// buildObservation — the null/undefined short-circuit must run BEFORE
// dispatching to a per-class observation builder (mutation: disabling this
// guard would let a per-class builder run on a null response and return a
// non-null "empty" observation object instead of the true null)
// -------------------------------------------------------
describe("buildCollectionRecord — observation short-circuits on a null tool_response", () => {
	it("returns the JS null value itself, not a per-class empty-observation object, for a shell_exec null response", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				tool_response: null,
			}),
		)!;
		// Strict identity: a mutant that bypasses the null guard would produce
		// { stdout: null, stderr: null, exit_code: null, duration_ms: null }
		// here instead — an object, not null.
		expect(rec.observation).toBe(null);
	});
});

// -------------------------------------------------------
// buildFidelity — the phase/observation gate must not run for a post event
// whose observation resolves to null (mutation: forcing this gate open would
// cast the null observation to an object and crash on property access, or —
// depending on which clause is mutated — populate fidelity.fields for a
// tool_response that was never actually captured)
// -------------------------------------------------------
describe("buildCollectionRecord — fidelity gate on post-with-null-observation", () => {
	it("does not throw for a post event whose tool_response is entirely absent", () => {
		expect(() =>
			buildCollectionRecord(baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } })),
		).not.toThrow();
	});

	it("produces an empty fidelity fields map (not a thrown error) for that same post-with-no-response event", () => {
		const rec = buildCollectionRecord(baseEvent({ tool_name: "Bash", tool_input: { command: "echo" } }))!;
		expect(rec.observation).toBeNull();
		expect(rec.fidelity.fields).toEqual({});
		expect(rec.fidelity.record.completeness).toBe("complete");
	});

	it("never creates a fidelity entry for a field whose observation value is exactly null, even alongside a present sibling field", () => {
		const rec = buildCollectionRecord(
			baseEvent({
				tool_name: "Bash",
				tool_input: { command: "echo" },
				tool_response: { stderr: "only stderr present" },
				tool_output_bytes: 5,
			}),
		)!;
		expect(rec.observation).toMatchObject({ stdout: null, stderr: "only stderr present" });
		expect("observation.stdout" in rec.fidelity.fields).toBe(false);
		expect("observation.stderr" in rec.fidelity.fields).toBe(true);
	});
});

// -------------------------------------------------------
// buildPrivacy — redaction_status depends on BOTH phase and observation
// presence (mutation: forcing the gate open would mark a pre-phase or
// empty-observation record "unscanned" even though nothing was captured)
// -------------------------------------------------------
describe("buildCollectionRecord — privacy gate depends on phase AND observation", () => {
	it("is not_required for a pre-phase event", () => {
		const rec = buildCollectionRecord(
			preEvent({ tool_name: "Bash", tool_input: { command: "echo hi" } }),
		)!;
		expect(rec.privacy.redaction_status).toBe("not_required");
	});

	it("is not_required for a post-phase event whose observation resolves to null (explicit null tool_response)", () => {
		const rec = buildCollectionRecord(
			baseEvent({ tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: null }),
		)!;
		expect(rec.observation).toBeNull();
		expect(rec.privacy.redaction_status).toBe("not_required");
	});
});
