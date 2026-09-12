// Behavioral coverage-gap companion for hook-entry-cold-gates.ts.
// Targets the specific uncovered lines/branches from coverage/lcov.info:
// coldGraphShardBlockReason (incl. extractColdTargetPaths, colColdToolName),
// coldMergeConflictBlockReason, coldDestructiveCommandBlockReason,
// coldPackageInstallBlockReason, coldLargeFileBlockReason.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One real absolute path is designated to make statSync throw (simulating a
// permission error / TOCTOU race between existsSync and statSync) while every
// other path is delegated to the real implementation — used only by the
// "continues past a path that throws" test below, exercising the
// `catch { continue; }` branch that existsSync alone cannot trigger (Node's
// existsSync swallows all stat errors and just returns false).
let statThrowPath: string | null = null;
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			const [p] = args;
			if (typeof p === "string" && p === statThrowPath) {
				throw new Error("EACCES: simulated permission error for coverage");
			}
			return actual.statSync(...args);
		},
	};
});

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { ToolCallAction, UnifiedHookEvent } from "./harness/unified-event.js";
import {
	coldDestructiveCommandBlockReason,
	coldGraphShardBlockReason,
	coldLargeFileBlockReason,
	coldMergeConflictBlockReason,
	coldPackageInstallBlockReason,
} from "./hook-entry-cold-gates.js";

// ---- fixtures ---------------------------------------------------------------

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "cold-gates-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function makeToolCallEvent(over: {
	phase?: UnifiedHookEvent["phase"];
	tool_name?: string;
	tool_input?: unknown;
	cwd?: string | undefined;
}): UnifiedHookEvent & { action: ToolCallAction } {
	return {
		schema_version: "1",
		event_id: "e1",
		session_id: "s1",
		ts: "2026-08-05T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: over.phase ?? "pre-tool",
		action: {
			kind: "tool_call",
			tool_name: over.tool_name ?? "edit",
			tool_class: "modify",
			tool_input: over.tool_input,
			tool_input_redacted: over.tool_input,
		},
		context: { cwd: over.cwd ?? cwd },
		raw: {},
	};
}

function makeFileOpEvent(over: {
	path?: string;
	phase?: UnifiedHookEvent["phase"];
	cwd?: string | undefined;
}): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "e2",
		session_id: "s1",
		ts: "2026-08-05T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: over.phase ?? "pre-tool",
		action: {
			kind: "file_operation",
			operation: "edit",
			path: over.path ?? "",
			tool_class: "modify",
		},
		context: { cwd: over.cwd ?? cwd },
		raw: {},
	};
}

// ===========================================================================
// coldGraphShardBlockReason
// ===========================================================================
describe("coldGraphShardBlockReason", () => {
	afterEach(() => {
		delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
	});

	it("returns null outside the pre-tool phase", () => {
		const event = makeToolCallEvent({ phase: "post-tool", tool_input: { file_path: "a.ts" } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null when the opt-out env var is set", () => {
		process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = "1";
		const src = join(cwd, "a.ts");
		const shard = join(cwd, "a.graph.ts");
		writeFileSync(src, "export const x = 1;\n");
		writeFileSync(shard, "{}");
		const event = makeToolCallEvent({ tool_input: { file_path: src } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null for a tool not in the write-tool set", () => {
		const event = makeToolCallEvent({
			tool_name: "read",
			tool_input: { file_path: join(cwd, "a.ts") },
		});
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null (colColdToolName) for an action kind that is neither tool_call nor file_operation", () => {
		const event: UnifiedHookEvent = {
			schema_version: "1",
			event_id: "e3",
			session_id: "s1",
			ts: "2026-08-05T00:00:00.000Z",
			runner: "claude-code",
			runner_native_event: "UserPromptSubmit",
			phase: "pre-tool",
			action: { kind: "user_prompt", text: "hi" },
			context: { cwd },
			raw: {},
		};
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null when no target paths are extracted (empty tool_input)", () => {
		const event = makeToolCallEvent({ tool_input: {} });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("blocks a write to a file with a fresh colocated .graph shard (tool_call, with extension)", () => {
		const src = join(cwd, "a.ts");
		const shard = join(cwd, "a.graph.ts");
		writeFileSync(src, "export const x = 1;\n");
		writeFileSync(shard, "{}");
		const event = makeToolCallEvent({ tool_input: { file_path: src } });
		const reason = coldGraphShardBlockReason(event);
		expect(reason).not.toBeNull();
		expect(reason).toContain("[interlinked:graph-pred][harness-offline]");
		expect(reason).toContain(src);
	});

	it("blocks via a file_operation action (no extension, default tool 'edit')", () => {
		const src = join(cwd, "Makefile");
		const shard = join(cwd, "Makefile.graph");
		writeFileSync(src, "all:\n\techo hi\n");
		writeFileSync(shard, "{}");
		const event = makeFileOpEvent({ path: src });
		const reason = coldGraphShardBlockReason(event);
		expect(reason).not.toBeNull();
		expect(reason).toContain(src);
	});

	it("returns null for a file_operation whose path is blank", () => {
		const event = makeFileOpEvent({ path: "   " });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("resolves a relative path against event.context.cwd", () => {
		const src = join(cwd, "rel.ts");
		const shard = join(cwd, "rel.graph.ts");
		writeFileSync(src, "export const x = 1;\n");
		writeFileSync(shard, "{}");
		const event = makeToolCallEvent({ tool_input: { file_path: "rel.ts" } });
		const reason = coldGraphShardBlockReason(event);
		expect(reason).toContain(src);
	});

	it("returns null when the source file does not exist", () => {
		const event = makeToolCallEvent({ tool_input: { file_path: join(cwd, "nope.ts") } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null when the source exists but the shard does not", () => {
		const src = join(cwd, "a.ts");
		writeFileSync(src, "export const x = 1;\n");
		const event = makeToolCallEvent({ tool_input: { file_path: src } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("returns null when the shard is stale relative to the source (past the grace window)", () => {
		const src = join(cwd, "a.ts");
		const shard = join(cwd, "a.graph.ts");
		writeFileSync(shard, "{}");
		writeFileSync(src, "export const x = 1;\n");
		// Backdate the shard well past the 60s grace window.
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(shard, old, old);
		const event = makeToolCallEvent({ tool_input: { file_path: src } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("extracts apply_patch target paths from Update/Add/Delete and Move headers", () => {
		const src = join(cwd, "patched.ts");
		const shard = join(cwd, "patched.graph.ts");
		writeFileSync(src, "export const x = 1;\n");
		writeFileSync(shard, "{}");
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${src}`,
			"@@",
			"-old",
			"+new",
			"*** Move to: some/other/path.ts",
			"*** End Patch",
		].join("\n");
		const event = makeToolCallEvent({
			tool_name: "apply_patch",
			tool_input: { command: patch },
		});
		const reason = coldGraphShardBlockReason(event);
		expect(reason).toContain(src);
	});

	it("continues past a path whose statSync throws (catch branch), falling through to the next real path", () => {
		const badSrc = join(cwd, "b.ts");
		const badShard = join(cwd, "b.graph.ts");
		writeFileSync(badSrc, "export const x = 1;\n");
		writeFileSync(badShard, "{}");
		const goodSrc = join(cwd, "c.ts");
		const goodShard = join(cwd, "c.graph.ts");
		writeFileSync(goodSrc, "export const x = 1;\n");
		writeFileSync(goodShard, "{}");
		statThrowPath = badSrc;
		try {
			const event = makeToolCallEvent({
				tool_input: { file_path: badSrc, path: goodSrc },
			});
			const reason = coldGraphShardBlockReason(event);
			expect(reason).toContain(goodSrc);
		} finally {
			statThrowPath = null;
		}
	});

	it("treats a missing tool_input as an empty object (?? fallback)", () => {
		const event = makeToolCallEvent({});
		event.action.tool_input = undefined;
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	it("falls back through the apply_patch body-source chain (patch field, no command)", () => {
		const src = join(cwd, "viapatch.ts");
		const shard = join(cwd, "viapatch.graph.ts");
		writeFileSync(src, "export const x = 1;\n");
		writeFileSync(shard, "{}");
		const patch = `*** Update File: ${src}\n@@\n-old\n+new\n`;
		const event = makeToolCallEvent({
			tool_name: "apply_patch",
			// No `command` key -> falls through to `.patch`.
			tool_input: { patch },
		});
		expect(coldGraphShardBlockReason(event)).toContain(src);
	});
});

// ===========================================================================
// coldMergeConflictBlockReason
// ===========================================================================
describe("coldMergeConflictBlockReason", () => {
	it("ignores a pre-tool event with no tool name", () => {
		expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_name: "", tool_input: { content: "plain text" } }))).toBeNull();
	});
	it("returns null outside the pre-tool phase", () => {
		const event = makeToolCallEvent({
			phase: "post-tool",
			tool_input: { content: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> br" },
		});
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("returns null for a non-write tool", () => {
		const event = makeToolCallEvent({
			tool_name: "read",
			tool_input: { content: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> br" },
		});
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("returns null for a file_operation action (extractColdWriteContent kind guard)", () => {
		const event = makeFileOpEvent({ path: join(cwd, "a.ts") });
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("treats a missing tool_input as an empty object (?? fallback -> no content, no crash)", () => {
		const event = makeToolCallEvent({});
		event.action.tool_input = undefined;
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("returns null when content has no merge-conflict markers", () => {
		const event = makeToolCallEvent({ tool_input: { content: "export const x = 1;\n" } });
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("blocks Write content (tool_input.content) carrying conflict markers", () => {
		const event = makeToolCallEvent({
			tool_input: {
				content: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch",
				file_path: join(cwd, "a.ts"),
			},
		});
		const reason = coldMergeConflictBlockReason(event);
		expect(reason).not.toBeNull();
		expect(reason).toContain("[interlinked:merge-conflict]");
		expect(reason).toContain(join(cwd, "a.ts"));
	});

	it("blocks Edit content (tool_input.new_string) carrying conflict markers", () => {
		const event = makeToolCallEvent({
			tool_input: { new_string: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch" },
		});
		expect(coldMergeConflictBlockReason(event)).not.toBeNull();
	});

	it("blocks NotebookEdit content (tool_input.new_source) carrying conflict markers", () => {
		const event = makeToolCallEvent({
			tool_name: "notebook_edit",
			tool_input: { new_source: "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch" },
		});
		expect(coldMergeConflictBlockReason(event)).not.toBeNull();
	});

	it("blocks MultiEdit content (edits[].new_string) carrying conflict markers", () => {
		const event = makeToolCallEvent({
			tool_name: "multi_edit",
			tool_input: {
				edits: [
					{ old_string: "a", new_string: "clean line" },
					{ old_string: "b", new_string: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z" },
				],
			},
		});
		const reason = coldMergeConflictBlockReason(event);
		expect(reason).not.toBeNull();
	});

	it("ignores non-object / string-less entries inside edits[] (no crash, no content)", () => {
		const event = makeToolCallEvent({
			tool_name: "multi_edit",
			tool_input: { edits: [null, 42, { new_string: 7 }, { no_new_string: "x" }] },
		});
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("returns null when edits[] is present but yields no string parts", () => {
		const event = makeToolCallEvent({
			tool_name: "multi_edit",
			tool_input: { edits: [] },
		});
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	it("uses 'the target file' as the location when no target path is extractable", () => {
		const event = makeToolCallEvent({
			tool_input: { content: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> br" },
		});
		const reason = coldMergeConflictBlockReason(event);
		expect(reason).toContain("the target file");
	});
});

// ===========================================================================
// coldDestructiveCommandBlockReason
// ===========================================================================
describe("coldDestructiveCommandBlockReason", () => {
	it("returns null outside the pre-tool phase", () => {
		const event = makeToolCallEvent({
			phase: "post-tool",
			tool_name: "bash",
			tool_input: { command: "rm -rf /" },
		});
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	it("blocks a destructive command via a shell_command action (Cursor-shaped)", () => {
		const event: UnifiedHookEvent = {
			schema_version: "1",
			event_id: "e4",
			session_id: "s1",
			ts: "2026-08-05T00:00:00.000Z",
			runner: "cursor",
			runner_native_event: "beforeShellExecution",
			phase: "pre-tool",
			action: { kind: "shell_command", command: "rm -rf /", tool_class: "side-effect" },
			context: { cwd },
			raw: {},
		};
		expect(coldDestructiveCommandBlockReason(event)).toContain("BLOCKED");
	});

	it("returns null for a tool_call whose tool_name is not a recognized bash tool", () => {
		const event = makeToolCallEvent({ tool_name: "edit", tool_input: { command: "rm -rf /" } });
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	it("blocks a destructive bash tool_call command", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: { command: "rm -rf /" } });
		expect(coldDestructiveCommandBlockReason(event)).toContain("BLOCKED");
	});

	it("returns null for a benign bash command", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: { command: "ls -la" } });
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	it("returns null for an action kind that is neither shell_command nor tool_call", () => {
		const event = makeFileOpEvent({ path: join(cwd, "a.ts") });
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	it("returns null when the bash tool_call has no string command", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: {} });
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	it("treats a missing tool_input as an empty object (?? fallback -> no command, no crash)", () => {
		const event = makeToolCallEvent({ tool_name: "bash" });
		event.action.tool_input = undefined;
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});
});

// ===========================================================================
// coldPackageInstallBlockReason
// ===========================================================================
describe("coldPackageInstallBlockReason", () => {
	afterEach(() => {
		delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
	});

	it("returns null when the opt-out env var is set", () => {
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		const event = makeToolCallEvent({
			tool_name: "bash",
			tool_input: { command: "npm install left-pad@1.3.0" },
		});
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("returns null outside the pre-tool phase", () => {
		const event = makeToolCallEvent({
			phase: "post-tool",
			tool_name: "bash",
			tool_input: { command: "npm install left-pad@1.3.0" },
		});
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("blocks an unapproved, exactly-pinned npm install via a shell_command action", () => {
		const event: UnifiedHookEvent = {
			schema_version: "1",
			event_id: "e5",
			session_id: "s1",
			ts: "2026-08-05T00:00:00.000Z",
			runner: "cursor",
			runner_native_event: "beforeShellExecution",
			phase: "pre-tool",
			action: { kind: "shell_command", command: "npm install left-pad@1.3.0", tool_class: "side-effect" },
			context: { cwd },
			raw: {},
		};
		const reason = coldPackageInstallBlockReason(event);
		expect(reason).not.toBeNull();
		expect(reason).toContain("[interlinked:supply-chain]");
	});

	it("returns null for a tool_call whose tool_name is not a recognized bash tool", () => {
		const event = makeToolCallEvent({
			tool_name: "edit",
			tool_input: { command: "npm install left-pad@1.3.0" },
		});
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("returns null for an action kind that is neither shell_command nor tool_call", () => {
		const event = makeFileOpEvent({ path: join(cwd, "a.ts") });
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("returns null when the bash tool_call has no string command", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: {} });
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("returns null for a command that parses to zero install commands", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: { command: "ls -la" } });
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("blocks via a bash tool_call, falling back to process.cwd() when context.cwd is empty", () => {
		const event = makeToolCallEvent({
			tool_name: "bash",
			tool_input: { command: "npm install left-pad@1.3.0" },
			cwd: "",
		});
		const reason = coldPackageInstallBlockReason(event);
		// process.cwd() is this repo checkout, which has its own committed
		// allowlist — left-pad is not on it, so this still blocks.
		expect(reason).not.toBeNull();
	});

	it("treats a missing tool_input as an empty object (?? fallback -> no command, no crash)", () => {
		const event = makeToolCallEvent({ tool_name: "bash" });
		event.action.tool_input = undefined;
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});

	it("returns null (allow) for an install command evaluatePackageInstall approves", () => {
		// No positional packages, no lockfile/manifest present in the fresh tmp
		// cwd -> falls through evaluateOne's gates to a non-block decision for
		// an action that isn't install_global/positional/sync-from-manifest.
		const event = makeToolCallEvent({
			tool_name: "bash",
			tool_input: { command: "npm uninstall left-pad" },
		});
		expect(coldPackageInstallBlockReason(event)).toBeNull();
	});
});

// ===========================================================================
// coldLargeFileBlockReason
// ===========================================================================
describe("coldLargeFileBlockReason", () => {
	it("returns null outside the pre-tool phase", () => {
		const event = makeToolCallEvent({
			phase: "post-tool",
			tool_input: { file_path: join(cwd, "a.ts"), content: "x\n".repeat(600) },
		});
		expect(coldLargeFileBlockReason(event)).toBeNull();
	});

	it("returns null for an action kind that is not tool_call", () => {
		const event = makeFileOpEvent({ path: join(cwd, "a.ts") });
		expect(coldLargeFileBlockReason(event)).toBeNull();
	});

	it("returns null for a small file well under the line cap", () => {
		const event = makeToolCallEvent({
			tool_input: { file_path: join(cwd, "small.ts"), content: "export const x = 1;\n" },
		});
		expect(coldLargeFileBlockReason(event)).toBeNull();
	});

	it("blocks creating a hand-written code file that starts over the line cap", () => {
		const bigContent = Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join(
			"\n",
		);
		const event = makeToolCallEvent({
			tool_input: { file_path: join(cwd, "big.ts"), content: bigContent },
		});
		const reason = coldLargeFileBlockReason(event);
		expect(reason).not.toBeNull();
		expect(typeof reason).toBe("string");
	});

	it("falls back to process.cwd() when context.cwd is empty (still resolves without throwing)", () => {
		const event = makeToolCallEvent({
			tool_input: { file_path: join(cwd, "x.ts"), content: "export const x = 1;\n" },
			cwd: "",
		});
		expect(coldLargeFileBlockReason(event)).toBeNull();
	});

	it("treats a missing tool_input as an empty object (?? fallback -> no file_path, no crash)", () => {
		const event = makeToolCallEvent({});
		event.action.tool_input = undefined;
		expect(coldLargeFileBlockReason(event)).toBeNull();
	});
});
