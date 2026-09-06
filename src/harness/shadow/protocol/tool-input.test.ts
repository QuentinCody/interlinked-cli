import { describe, expect, it } from "vitest";
import { extractApplyPatchRaw } from "../../apply-patch-content.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import { APPLY_PATCH_SOURCE_PRECEDENCE, normalizeToolInput, toolInputHash } from "./tool-input.js";
import type { NormalizedToolInputV1 } from "./types-core.js";

const ROOT = "/Users/dev/repo";

function accepted(request: Parameters<typeof normalizeToolInput>[0]): NormalizedToolInputV1 {
	const result = normalizeToolInput(request);
	if (!result.ok) throw new Error(`expected acceptance, got ${result.reason}: ${result.detail}`);
	return result.normalized;
}

/** A left-nested array chain of the requested depth, built ITERATIVELY so the
 *  fixture itself cannot blow the JS stack. */
function nested(depth: number): unknown {
	let value: unknown = 0;
	for (let index = 0; index < depth; index += 1) value = [value];
	return value;
}

function rejected(request: Parameters<typeof normalizeToolInput>[0]): { reason: string; detail: string } {
	const result = normalizeToolInput(request);
	if (result.ok) throw new Error("expected rejection, got an accepted normalization");
	return { reason: result.reason, detail: result.detail };
}

describe("normalizeToolInput — positive (must accept)", () => {
	it("P1: claude-code Write normalizes to the closed union with semantics_version 1", () => {
		expect(
			accepted({
				client: "claude-code",
				tool: "Write",
				repo_root: ROOT,
				input: { file_path: "src/a.ts", content: "export const a = 1;\n" },
			}),
		).toEqual({
			schema: "shadow-tool-input-v1",
			client: "claude-code",
			tool: "Write",
			semantics_version: 1,
			file_path: "src/a.ts",
			content: "export const a = 1;\n",
		});
	});

	it("P2: claude-code Edit normalizes, defaulting an absent replace_all to false", () => {
		expect(
			accepted({
				client: "claude-code",
				tool: "Edit",
				repo_root: ROOT,
				input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
			}),
		).toEqual({
			schema: "shadow-tool-input-v1",
			client: "claude-code",
			tool: "Edit",
			semantics_version: 1,
			file_path: "src/a.ts",
			old_string: "a",
			new_string: "b",
			replace_all: false,
		});
	});

	it("P3: claude-code MultiEdit normalizes every edit entry", () => {
		expect(
			accepted({
				client: "claude-code",
				tool: "MultiEdit",
				repo_root: ROOT,
				input: {
					file_path: "src/a.ts",
					edits: [
						{ old_string: "a", new_string: "b" },
						{ old_string: "c", new_string: "d", replace_all: true },
					],
				},
			}),
		).toEqual({
			schema: "shadow-tool-input-v1",
			client: "claude-code",
			tool: "MultiEdit",
			semantics_version: 1,
			file_path: "src/a.ts",
			edits: [
				{ old_string: "a", new_string: "b", replace_all: false },
				{ old_string: "c", new_string: "d", replace_all: true },
			],
		});
	});

	it("P4: codex apply_patch records raw_source_field for each precedence field", () => {
		const patch = "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch\n";
		const cases = [
			{ input: { command: patch }, field: "command" },
			{ input: { patch }, field: "patch" },
			{ input: { _raw_patch: patch }, field: "_raw_patch" },
			{ input: { content: patch }, field: "content" },
		] as const;
		for (const testCase of cases) {
			expect(accepted({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: testCase.input })).toEqual({
				schema: "shadow-tool-input-v1",
				client: "codex",
				tool: "apply_patch",
				semantics_version: 1,
				patch,
				raw_source_field: testCase.field,
			});
		}
	});

	it("P5: precedence order matches extractApplyPatchRaw — the single source of truth", () => {
		expect(APPLY_PATCH_SOURCE_PRECEDENCE).toEqual(["command", "patch", "_raw_patch", "content"]);
		const payload = { command: "C", patch: "P", _raw_patch: "R", content: "T" };
		const normalized = accepted({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: payload });
		expect(normalized).toMatchObject({ patch: extractApplyPatchRaw(payload), raw_source_field: "command" });
		const withoutCommand = { patch: "P", _raw_patch: "R", content: "T" };
		expect(accepted({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: withoutCommand })).toMatchObject({
			patch: extractApplyPatchRaw(withoutCommand),
			raw_source_field: "patch",
		});
		const empties = { command: "", patch: "", _raw_patch: "R", content: "T" };
		expect(accepted({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: empties })).toMatchObject({
			patch: extractApplyPatchRaw(empties),
			raw_source_field: "_raw_patch",
		});
		const onlyContent = { command: "", patch: "", _raw_patch: "", content: "T" };
		expect(accepted({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: onlyContent })).toMatchObject({
			patch: extractApplyPatchRaw(onlyContent),
			raw_source_field: "content",
		});
	});

	it("P6: an absolute path under the repo root is relativized to a canonical path", () => {
		expect(
			accepted({
				client: "claude-code",
				tool: "Write",
				repo_root: `${ROOT}/`,
				input: { file_path: `${ROOT}/src/nested/a.ts`, content: "" },
			}),
		).toMatchObject({ file_path: "src/nested/a.ts", content: "" });
	});

	it("P7: extra runner-specific keys are projected away, not rejected", () => {
		expect(
			accepted({
				client: "claude-code",
				tool: "Write",
				repo_root: ROOT,
				input: { file_path: "src/a.ts", content: "x", _tool_call_id: "abc" },
			}),
		).toMatchObject({ file_path: "src/a.ts", content: "x" });
	});

	it("P8: input_hash is stable under raw key reordering", () => {
		const a = accepted({
			client: "claude-code",
			tool: "Edit",
			repo_root: ROOT,
			input: { file_path: "src/a.ts", old_string: "a", new_string: "b", replace_all: true },
		});
		const b = accepted({
			client: "claude-code",
			tool: "Edit",
			repo_root: ROOT,
			input: { replace_all: true, new_string: "b", old_string: "a", file_path: "src/a.ts" },
		});
		expect(toolInputHash(a)).toBe(toolInputHash(b));
		expect(toolInputHash(a)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("P9: input_hash DIFFERS when replace_all flips — content identity is load-bearing", () => {
		const base = { file_path: "src/a.ts", old_string: "a", new_string: "b" };
		const off = accepted({ client: "claude-code", tool: "Edit", repo_root: ROOT, input: { ...base, replace_all: false } });
		const on = accepted({ client: "claude-code", tool: "Edit", repo_root: ROOT, input: { ...base, replace_all: true } });
		expect(toolInputHash(off)).not.toBe(toolInputHash(on));
	});

	it("P10: a payload just under the aggregate cap is still accepted", () => {
		const content = "x".repeat(SHADOW_LIMITS_V1.command_stdin_toolinput_bytes - 200);
		expect(
			accepted({ client: "claude-code", tool: "Write", repo_root: ROOT, input: { file_path: "src/a.ts", content } }),
		).toMatchObject({ file_path: "src/a.ts", content });
	});

	it("P11: a serialized_bytes ABOVE the measured walk is accepted — transport framing costs more, never less", () => {
		const input = { file_path: "src/a.ts", content: "x" };
		const overhead = SHADOW_LIMITS_V1.command_stdin_toolinput_bytes - 1;
		expect(
			accepted({ client: "claude-code", tool: "Write", repo_root: ROOT, input, serialized_bytes: overhead }),
		).toMatchObject({ file_path: "src/a.ts", content: "x" });
	});
});

describe("normalizeToolInput — negative (must reject)", () => {
	it("N1: a path outside the repo root is a projection failure", () => {
		expect(
			rejected({
				client: "claude-code",
				tool: "Write",
				repo_root: ROOT,
				input: { file_path: "/etc/passwd", content: "x" },
			}).reason,
		).toBe("projection");
		expect(
			rejected({
				client: "claude-code",
				tool: "Write",
				repo_root: ROOT,
				input: { file_path: "../outside/a.ts", content: "x" },
			}).reason,
		).toBe("projection");
		expect(
			rejected({
				client: "claude-code",
				tool: "Write",
				repo_root: ROOT,
				input: { file_path: `${ROOT}/src/../../elsewhere/a.ts`, content: "x" },
			}).reason,
		).toBe("projection");
	});

	it("N2: an unknown tool on a supported client is unsupported_capability", () => {
		expect(
			rejected({ client: "claude-code", tool: "NotebookEdit", repo_root: ROOT, input: { file_path: "a.ipynb" } }).reason,
		).toBe("unsupported_capability");
		expect(rejected({ client: "claude-code", tool: "Bash", repo_root: ROOT, input: { command: "ls" } }).reason).toBe(
			"unsupported_capability",
		);
		expect(rejected({ client: "codex", tool: "shell", repo_root: ROOT, input: { command: "ls" } }).reason).toBe(
			"unsupported_capability",
		);
	});

	it("N3: an unknown client is unsupported_capability", () => {
		expect(
			rejected({ client: "gemini", tool: "Write", repo_root: ROOT, input: { file_path: "a.ts", content: "x" } }).reason,
		).toBe("unsupported_capability");
	});

	it("N4: over-limit content is a limits failure, named by the aggregate cap", () => {
		const huge = "x".repeat(SHADOW_LIMITS_V1.command_stdin_toolinput_bytes + 1);
		const failure = rejected({
			client: "claude-code",
			tool: "Write",
			repo_root: ROOT,
			input: { file_path: "src/a.ts", content: huge },
		});
		expect(failure.reason).toBe("limits");
		expect(failure.detail).toContain("command_stdin_toolinput_bytes");
	});

	it("N5: a malformed payload for a supported shape is a projection failure", () => {
		expect(
			rejected({ client: "claude-code", tool: "Write", repo_root: ROOT, input: { file_path: "src/a.ts" } }).reason,
		).toBe("projection");
		expect(rejected({ client: "claude-code", tool: "Write", repo_root: ROOT, input: "not-an-object" }).reason).toBe(
			"projection",
		);
		expect(
			rejected({ client: "claude-code", tool: "Edit", repo_root: ROOT, input: { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: "yes" } }).reason,
		).toBe("projection");
		expect(
			rejected({ client: "claude-code", tool: "MultiEdit", repo_root: ROOT, input: { file_path: "a.ts", edits: [{ old_string: "a" }] } }).reason,
		).toBe("projection");
	});

	it("N6: codex apply_patch with no patch field in any precedence slot is a projection failure", () => {
		expect(rejected({ client: "codex", tool: "apply_patch", repo_root: ROOT, input: { path: "src/a.ts" } }).reason).toBe(
			"projection",
		);
	});

	it("N7: a non-absolute repo root is a projection failure — the root cannot be guessed", () => {
		expect(
			rejected({ client: "claude-code", tool: "Write", repo_root: "repo", input: { file_path: "a.ts", content: "x" } })
				.reason,
		).toBe("projection");
	});

	it("N8: REPRODUCTION — a 1 250 048-byte boolean-heavy payload is a limits failure, not an acceptance", () => {
		// Review 2026-09-04: the string-only counter scored this payload at 3
		// bytes (the key `pad`) and admitted it past the 1 MiB cap.
		const pad = Array.from({ length: 250_000 }, () => true);
		const payload = { file_path: "src/a.ts", content: "x", pad };
		expect(JSON.stringify(payload).length).toBeGreaterThan(SHADOW_LIMITS_V1.command_stdin_toolinput_bytes);
		const failure = rejected({ client: "claude-code", tool: "Write", repo_root: ROOT, input: payload });
		expect(failure.reason).toBe("limits");
		expect(failure.detail).toContain("command_stdin_toolinput_bytes");
	});

	it("N9: REPRODUCTION — 20 000 nested arrays REJECT without throwing (was an uncaught RangeError)", () => {
		const payload = { file_path: "src/a.ts", content: "x", pad: nested(20_000) };
		const request = { client: "claude-code", tool: "Write", repo_root: ROOT, input: payload } as const;
		expect(() => normalizeToolInput(request)).not.toThrow();
		const failure = rejected(request);
		expect(failure.reason).toBe("limits");
		expect(failure.detail).toContain("command_stdin_toolinput_bytes");
	});

	it("N10: a serialized_bytes over the cap is a limits failure, and a malformed one a projection failure", () => {
		const input = { file_path: "src/a.ts", content: "x" };
		const over = rejected({
			client: "claude-code",
			tool: "Write",
			repo_root: ROOT,
			input,
			serialized_bytes: SHADOW_LIMITS_V1.command_stdin_toolinput_bytes + 1,
		});
		expect(over.reason).toBe("limits");
		expect(over.detail).toContain("command_stdin_toolinput_bytes");
		expect(
			rejected({ client: "claude-code", tool: "Write", repo_root: ROOT, input, serialized_bytes: -1 }).reason,
		).toBe("projection");
		expect(
			rejected({ client: "claude-code", tool: "Write", repo_root: ROOT, input, serialized_bytes: 1.5 }).reason,
		).toBe("projection");
	});

	it("N11: a serialized_bytes UNDER the measured walk is refused — a caller cannot understate", () => {
		const input = { file_path: "src/a.ts", content: "x".repeat(4_096) };
		const failure = rejected({
			client: "claude-code",
			tool: "Write",
			repo_root: ROOT,
			input,
			serialized_bytes: 1,
		});
		expect(failure.reason).toBe("projection");
		expect(failure.detail).toContain("serialized_bytes");
	});

	it("N12: a declared serialized_bytes does NOT buy a bypass — the walk still refuses a bomb", () => {
		// Before this change a supplied count SKIPPED the walk, so "declare a
		// small number" admitted any payload at all.
		const bomb: { file_path: string; content: string; pad: unknown } = {
			file_path: "src/a.ts",
			content: "x",
			pad: nested(20_000),
		};
		const failure = rejected({
			client: "claude-code",
			tool: "Write",
			repo_root: ROOT,
			input: bomb,
			serialized_bytes: 4_096,
		});
		expect(failure.reason).toBe("limits");
		expect(failure.detail).toContain("command_stdin_toolinput_bytes");
	});

	it("N13: a payload JSON.stringify could not carry is a projection failure, not a size verdict", () => {
		const failure = rejected({
			client: "claude-code",
			tool: "Write",
			repo_root: ROOT,
			input: { file_path: "src/a.ts", content: "x", stamp: new Date(0) },
		});
		expect(failure.reason).toBe("projection");
	});
});
