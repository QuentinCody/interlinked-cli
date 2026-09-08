// Supplementary behavioral coverage for src/hook-entry.ts.
//
// The primary companion (src/hook-entry.test.ts) exercises the happy paths
// (daemon round-trips, legacy raw socket, the destructive-command cold gate).
// This file targets the remaining uncovered branches:
//   - The merge-conflict, graph-shard, and supply-chain cold fail-closed gates
//   - extractColdTargetPaths' apply_patch / file_operation / multi-key paths
//   - extractColdWriteContent across Write/Edit/NotebookEdit/MultiEdit shapes
//   - discoverSocket's alphabetical fallback + session-id sanitization
//   - the cold-fallback-after-a-failed-call path (socket present, call fails)
//   - the post-tool phase short-circuits on every gate
//   - the CLI wrapper internals (mainFromStdin / readStdinJson / argOrEnv /
//     isDirectRun) driven through a real subprocess of the module via tsx.
//
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSocket, runHookEntry } from "./hook-entry.js";

let tmp = "";
let interlinkedDir = "";

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-hecov-"));
	interlinkedDir = join(tmp, ".interlinked");
	mkdirSync(interlinkedDir);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** A socket path that does not exist — forces the cold fallback. */
function missingSocket(): string {
	return join(tmp, "absent.sock");
}

/** Write a source file with a colocated, fresh `.graph.<ext>` shard. */
function writeSourceWithFreshShard(rel: string): string {
	const abs = join(tmp, rel);
	mkdirSync(dirname(abs), { recursive: true });
	const ext = ".ts";
	const shard = abs.slice(0, -ext.length) + ".graph" + ext;
	writeFileSync(abs, "export const SENTINEL = 1;\n");
	writeFileSync(shard, "// @generated supermodel-sidecar\n// risk MEDIUM\n");
	const t = Date.parse("2026-05-10T12:00:00Z") / 1000;
	utimesSync(abs, t, t);
	utimesSync(shard, t, t);
	return abs;
}

// ---------------------------------------------------------------------------
// Cold gate: merge-conflict markers (checked first in encodeColdFallback).
// ---------------------------------------------------------------------------

describe("cold fallback — merge-conflict gate", () => {
	it("blocks a Write whose content carries conflict markers (content shape)", async () => {
		const conflicted = "before\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\nafter\n";
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "mc1",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: "src/conflict.ts", content: conflicted },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("merge-conflict fail-closed gate engaged");
		const out = JSON.parse(result.stdout ?? "{}");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
			"[interlinked:merge-conflict]",
		);
		// The block reason names the target file extracted from tool_input.
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("src/conflict.ts");
	});

	it("blocks an Edit whose new_string carries conflict markers (new_string shape)", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "mc2",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: {
					file_path: "src/a.ts",
					old_string: "x",
					new_string: "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> z\n",
				},
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("merge-conflict fail-closed gate engaged");
	});

	it("blocks a MultiEdit whose edits[].new_string carries markers (edits[] shape)", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "mc3",
				cwd: tmp,
				tool_name: "MultiEdit",
				tool_input: {
					file_path: "src/multi.ts",
					edits: [
						{ old_string: "a", new_string: "clean line" },
						{ old_string: "b", new_string: ">>>>>>> theirs-branch\n" },
					],
				},
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("merge-conflict fail-closed gate engaged");
	});

	it("does NOT fire the merge gate for a clean Write (falls through to allow)", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "mc4",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: "src/clean.ts", content: "export const ok = 1;\n" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("merge-conflict");
	});

	it("uses the 'the target file' placeholder when no path key is present", async () => {
		// NotebookEdit content via new_source, with NO file_path key — the merge
		// gate fires while extractColdTargetPaths returns [], exercising both the
		// `paths.length > 0 ? paths[0] : "the target file"` else arm AND the
		// new_source content shape in extractColdWriteContent.
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "mc5",
				cwd: tmp,
				tool_name: "NotebookEdit",
				tool_input: { new_source: "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("merge-conflict fail-closed gate engaged");
		const out = JSON.parse(result.stdout ?? "{}");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("the target file");
	});
});

// ---------------------------------------------------------------------------
// Cold gate: graph-shard fail-closed (fresh .graph.* shard colocated).
// Checked AFTER merge-conflict, so use clean (no-marker) content here.
// ---------------------------------------------------------------------------

describe("cold fallback — graph-shard gate", () => {
	it("blocks an Edit to a file with a fresh colocated .graph shard", async () => {
		const abs = writeSourceWithFreshShard("src/hk.ts");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs1",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: abs, old_string: "1", new_string: "2" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("graph-shard fail-closed gate engaged");
		const out = JSON.parse(result.stdout ?? "{}");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain("graph-pred");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(abs);
	});

	it("resolves a relative target path against event.context.cwd", async () => {
		writeSourceWithFreshShard("src/rel.ts");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs2",
				cwd: tmp,
				tool_name: "Edit",
				// Relative path — resolved against context.cwd (= tmp via raw.cwd).
				tool_input: { file_path: "src/rel.ts", old_string: "1", new_string: "2" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("graph-shard fail-closed gate engaged");
	});

	it("does NOT fire when the shard is stale (older than source minus grace)", async () => {
		const abs = join(tmp, "src", "stale.ts");
		mkdirSync(dirname(abs), { recursive: true });
		const shard = abs.slice(0, -3) + ".graph.ts";
		writeFileSync(abs, "export const S = 1;\n");
		writeFileSync(shard, "// shard\n");
		const sourceT = Date.parse("2026-05-10T12:00:00Z") / 1000;
		// Shard a full 10 minutes older than source → well past the 60s grace.
		const shardT = sourceT - 600;
		utimesSync(abs, sourceT, sourceT);
		utimesSync(shard, shardT, shardT);
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs3",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: abs, old_string: "1", new_string: "2" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("graph-shard");
	});

	it("does NOT fire when the target source file does not exist on disk", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs4",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { file_path: join(tmp, "src", "ghost.ts"), content: "x" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("graph-shard");
	});

	it("does NOT fire when the source exists but has NO colocated shard", async () => {
		// Source on disk, no `.graph.ts` sibling → existsSync(shardPath) false →
		// the loop `continue`s and the gate returns null (covers the no-shard arm).
		const abs = join(tmp, "src", "noshard.ts");
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, "export const N = 1;\n");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs7",
				cwd: tmp,
				tool_name: "Edit",
				tool_input: { file_path: abs, old_string: "1", new_string: "2" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("graph-shard");
	});

	it("does NOT fire for a write tool with NO target path keys (empty paths)", async () => {
		// A Write with clean content and no path key → merge gate passes, graph
		// gate sees toolName "write" but extractColdTargetPaths returns [] →
		// early `paths.length === 0` return null.
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs8",
				cwd: tmp,
				tool_name: "Write",
				tool_input: { content: "export const ok = 1;\n" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("graph-shard");
	});

	it("is bypassed by INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1", async () => {
		const abs = writeSourceWithFreshShard("src/bypass.ts");
		const prev = process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
		process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = "1";
		try {
			const result = await runHookEntry({
				nativeEventName: "PreToolUse",
				nativeJson: {
					session_id: "gs5",
					cwd: tmp,
					tool_name: "Edit",
					tool_input: { file_path: abs, old_string: "1", new_string: "2" },
				},
				env: {},
				runner: "claude-code",
				cwd: tmp,
				socketPath: missingSocket(),
			});
			expect(result.stderr).toContain("evaluator skipped");
			expect(result.stderr).not.toContain("graph-shard");
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE;
			else process.env.INTERLINKED_DISABLE_GRAPH_SHARD_INLINE = prev;
		}
	});

	it("does not fire the graph gate for a non-write tool (Read)", async () => {
		// Read normalizes to "read", which is absent from GRAPH_SHARD_WRITE_TOOLS
		// → colColdToolName yields a non-write name → early null.
		writeSourceWithFreshShard("src/readonly.ts");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "gs6",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: join(tmp, "src", "readonly.ts") },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("graph-shard");
	});
});

// ---------------------------------------------------------------------------
// extractColdTargetPaths — apply_patch header parsing + file_operation kind.
// Driven via the codex runner, which preserves the raw `apply_patch` tool name.
// ---------------------------------------------------------------------------

describe("cold fallback — apply_patch path extraction", () => {
	function writePatchTarget(rel: string): string {
		const target = join(tmp, rel);
		mkdirSync(dirname(target), { recursive: true });
		const shard = target.slice(0, -3) + ".graph.ts";
		writeFileSync(target, "export const P = 1;\n");
		writeFileSync(shard, "// shard\n");
		const t = Date.parse("2026-05-10T12:00:00Z") / 1000;
		utimesSync(target, t, t);
		utimesSync(shard, t, t);
		return target;
	}

	it("extracts Update + Move headers from an apply_patch body and graph-blocks", async () => {
		// The blocked path comes ONLY from the apply_patch body (no file_path
		// key), exercising both the file-header and move-header regex loops.
		const target = writePatchTarget("src/patched.ts");
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${target}`,
			"@@",
			"-export const P = 1;",
			"+export const P = 2;",
			`*** Move to: ${join(tmp, "src", "moved.ts")}`,
			"*** End Patch",
		].join("\n");

		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "ap1",
				cwd: tmp,
				tool_name: "apply_patch",
				tool_input: { command: patch },
			},
			env: {},
			runner: "codex",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("graph-shard fail-closed gate engaged");
		// Codex PreToolUse blocks use the native permission-decision envelope.
		const out = JSON.parse(result.stdout ?? "{}");
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(target);
	});

	it("reads the apply_patch body from the `patch` field when `command` is absent", async () => {
		const target = writePatchTarget("src/viapatchfield.ts");
		const patch = ["*** Begin Patch", `*** Add File: ${target}`, "+new", "*** End Patch"].join(
			"\n",
		);
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "ap2",
				cwd: tmp,
				tool_name: "apply_patch",
				tool_input: { patch },
			},
			env: {},
			runner: "codex",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("graph-shard fail-closed gate engaged");
	});

	it("allows an apply_patch with no matching fresh shard (header parsed, no block)", async () => {
		const patch = [
			"*** Begin Patch",
			`*** Update File: ${join(tmp, "src", "noshard.ts")}`,
			"+x",
			"*** End Patch",
		].join("\n");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "ap3",
				cwd: tmp,
				tool_name: "apply_patch",
				tool_input: { content: patch },
			},
			env: {},
			runner: "codex",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
	});
});

// ---------------------------------------------------------------------------
// file_operation action kind — Cursor's beforeReadFile produces a pre-tool
// file_operation action. colColdToolName maps any file_operation to "edit"
// (a write tool), so a fresh shard on the file_operation.path blocks.
// ---------------------------------------------------------------------------

describe("cold fallback — file_operation action", () => {
	it("graph-blocks a Cursor beforeReadFile file_operation with a fresh shard", async () => {
		const target = join(tmp, "src", "fileop.ts");
		mkdirSync(dirname(target), { recursive: true });
		const shard = target.slice(0, -3) + ".graph.ts";
		writeFileSync(target, "export const F = 1;\n");
		writeFileSync(shard, "// shard\n");
		const t = Date.parse("2026-05-10T12:00:00Z") / 1000;
		utimesSync(target, t, t);
		utimesSync(shard, t, t);

		const result = await runHookEntry({
			nativeEventName: "beforeReadFile",
			nativeJson: {
				session_id: "fo1",
				cwd: tmp,
				path: target,
			},
			env: {},
			runner: "cursor",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("graph-shard fail-closed gate engaged");
	});

	it("allows a pre-tool file_operation with no shard (destructive + package else-arms)", async () => {
		// A Cursor beforeReadFile with NO colocated shard flows through every cold
		// gate: merge (no content → null), graph (no shard → null), destructive
		// and package (action.kind is file_operation, neither shell_command nor
		// tool_call → the `else { return null }` arms) → clean allow.
		const target = join(tmp, "src", "plainread.ts");
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, "export const R = 1;\n");
		const result = await runHookEntry({
			nativeEventName: "beforeReadFile",
			nativeJson: {
				session_id: "fo2",
				cwd: tmp,
				path: target,
			},
			env: {},
			runner: "cursor",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("fail-closed gate engaged");
	});
});

// ---------------------------------------------------------------------------
// Cold gate: package-install supply-chain.
// ---------------------------------------------------------------------------

describe("cold fallback — supply-chain gate", () => {
	it("blocks an unapproved npm install via Bash when the daemon is down", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "sc1",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: "npm install left-pad" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("supply-chain fail-closed gate engaged");
		const out = JSON.parse(result.stdout ?? "{}");
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
			"[interlinked:supply-chain]",
		);
	});

	it("blocks an unapproved install via a Cursor shell_command", async () => {
		const result = await runHookEntry({
			nativeEventName: "beforeShellExecution",
			nativeJson: {
				session_id: "sc2",
				cwd: tmp,
				command: "pip install evilpkg",
			},
			env: {},
			runner: "cursor",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("supply-chain fail-closed gate engaged");
	});

	it("is bypassed by INTERLINKED_DISABLE_PACKAGE_GUARD=1 (install allowed)", async () => {
		const prev = process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = "1";
		try {
			const result = await runHookEntry({
				nativeEventName: "PreToolUse",
				nativeJson: {
					session_id: "sc3",
					cwd: tmp,
					tool_name: "Bash",
					tool_input: { command: "npm install left-pad" },
				},
				env: {},
				runner: "claude-code",
				cwd: tmp,
				socketPath: missingSocket(),
			});
			expect(result.stderr).toContain("evaluator skipped");
			expect(result.stderr).not.toContain("supply-chain");
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_PACKAGE_GUARD;
			else process.env.INTERLINKED_DISABLE_PACKAGE_GUARD = prev;
		}
	});

	it("does not fire the supply-chain gate for a non-install bash command", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "sc4",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: "echo hello" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("supply-chain");
	});

	it("ignores a Bash tool_input with a non-string command (empty short-circuit)", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "sc5",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: 123 },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		// Non-string command → both destructive and supply-chain gates see "" →
		// clean fall-through to allow.
		expect(result.stderr).toContain("evaluator skipped");
	});

	it("does not fire the supply-chain gate for a non-shell tool (Read)", async () => {
		// Read is not in COLD_BASH_TOOL_NAMES → coldPackageInstallBlockReason
		// returns null at the tool-name guard.
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "sc6",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/x" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.stderr).toContain("evaluator skipped");
	});
});

// ---------------------------------------------------------------------------
// Non-pre-tool phase: every cold gate early-returns null on phase mismatch, so
// a PostToolUse cold fallback should allow (no block), exercising the
// phase-guard early returns.
// ---------------------------------------------------------------------------

describe("cold fallback — post-tool phase short-circuits every gate", () => {
	it("allows a PostToolUse even with conflict-marker content (phase != pre-tool)", async () => {
		const result = await runHookEntry({
			nativeEventName: "PostToolUse",
			nativeJson: {
				session_id: "pt1",
				cwd: tmp,
				tool_name: "Write",
				tool_input: {
					file_path: "src/x.ts",
					content: "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> c\n",
				},
				tool_response: { ok: true },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			socketPath: missingSocket(),
		});
		expect(result.fell_back).toBe(true);
		// None of the pre-tool-gated gates engage on a post-tool event.
		expect(result.stderr).toContain("evaluator skipped");
		expect(result.stderr).not.toContain("fail-closed gate engaged");
	});
});

// ---------------------------------------------------------------------------
// Cold fallback after a FAILED daemon call (socket file exists but no live
// listener). discoverSocket finds the file; the call throws; encodeColdFallback
// runs with the call's error reason — covering the post-failed-call path.
// ---------------------------------------------------------------------------

describe("cold fallback — socket present but call fails", () => {
	it("falls back to cold evaluation when a discovered framed socket has no listener", async () => {
		// A plain (non-socket) file named harness-default.sock: discoverSocket
		// returns it, but connecting fails → safeCallDaemon returns {ok:false}.
		const sockFile = join(interlinkedDir, "harness-default.sock");
		writeFileSync(sockFile, "");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "fail1",
				cwd: tmp,
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
			// No explicit socketPath → discoverSocket picks harness-default.sock.
		});
		expect(result.fell_back).toBe(true);
		// The cold destructive gate still engages after the failed call.
		expect(result.stderr).toContain("destructive-command fail-closed gate engaged");
	});

	it("falls back when a discovered legacy raw socket has no listener", async () => {
		const sockFile = join(interlinkedDir, "harness.sock");
		writeFileSync(sockFile, "");
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {
				session_id: "fail2",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("evaluator skipped");
	});

	it("falls back on a post-tool call with a dead socket (post-tool timeout branch)", async () => {
		// A post-tool event with a discovered-but-dead socket exercises
		// defaultTimeoutForPhase's non-pre-tool branch before the call fails.
		const sockFile = join(interlinkedDir, "harness-default.sock");
		writeFileSync(sockFile, "");
		const result = await runHookEntry({
			nativeEventName: "PostToolUse",
			nativeJson: {
				session_id: "fail3",
				cwd: tmp,
				tool_name: "Read",
				tool_input: { file_path: "/a" },
				tool_response: { ok: true },
			},
			env: {},
			runner: "claude-code",
			cwd: tmp,
		});
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("evaluator skipped");
	});
});

// ---------------------------------------------------------------------------
// discoverSocket — alphabetical fallback + session-id sanitization + ancestor
// walk.
// ---------------------------------------------------------------------------

describe("discoverSocket — fallback ordering", () => {
	it("returns the first alphabetical harness-*.sock when no preferred name matches", () => {
		writeFileSync(join(interlinkedDir, "harness-zeta.sock"), "");
		writeFileSync(join(interlinkedDir, "harness-alpha.sock"), "");
		const found = discoverSocket(tmp, "no-such-session");
		expect(found?.endsWith("harness-alpha.sock")).toBe(true);
	});

	it("sanitizes unsafe session-id characters when building the per-session name", () => {
		const sanitized = "weird_session__id__";
		writeFileSync(join(interlinkedDir, `harness-${sanitized}.sock`), "");
		const found = discoverSocket(tmp, "weird/session  id//");
		expect(found?.endsWith(`harness-${sanitized}.sock`)).toBe(true);
	});

	it("walks up ancestor directories to find the repo root (.interlinked)", () => {
		const nested = join(tmp, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(interlinkedDir, "harness.sock"), "");
		const found = discoverSocket(nested, "no-match");
		expect(found?.endsWith("harness.sock")).toBe(true);
	});

	it("returns null when no .interlinked ancestor exists within the depth cap", () => {
		// A path more than 20 directories deep with NO `.interlinked` in any
		// ancestor — findRepoRoot exhausts its 20-iteration cap and returns null
		// before it ever reaches the filesystem root.
		const deepRoot = mkdtempSync(join(tmpdir(), "interlinked-deep-"));
		try {
			const segments = Array.from({ length: 25 }, (_unused, i) => `lvl${i}`);
			const deep = join(deepRoot, ...segments);
			mkdirSync(deep, { recursive: true });
			expect(discoverSocket(deep, "x")).toBeNull();
		} finally {
			rmSync(deepRoot, { recursive: true, force: true });
		}
	});

	it("tolerates an unreadable .interlinked dir (safeReaddir swallows EACCES)", () => {
		// The dir exists (so findRepoRoot + the existsSync(dir) guard pass) and
		// holds no preferred-name socket, but is chmod 000 so readdirSync throws
		// EACCES — safeReaddir's catch returns [] and discoverSocket yields null.
		// The root user bypasses directory permissions, so the EACCES path isn't
		// reachable there; skip the assertion in that case.
		const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
		if (isRoot) return;
		const root = mkdtempSync(join(tmpdir(), "interlinked-noperm-"));
		const dir = join(root, ".interlinked");
		mkdirSync(dir);
		chmodSync(dir, 0o000);
		try {
			expect(discoverSocket(root, "no-match")).toBeNull();
		} finally {
			chmodSync(dir, 0o755);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Adapter resolution — explicit-but-unknown runner id triggers the "unknown
// runner id" detail branch of resolveAdapter / runHookEntry.
// ---------------------------------------------------------------------------

describe("runHookEntry — unknown explicit runner", () => {
	it("reports an unknown runner id on stderr and falls back", async () => {
		const result = await runHookEntry({
			nativeEventName: "PreToolUse",
			nativeJson: {},
			env: {},
			// Deliberately an id no adapter registers.
			runner: "totally-made-up",
			cwd: tmp,
		});
		expect(result.exit_code).toBe(0);
		expect(result.fell_back).toBe(true);
		expect(result.stderr).toContain("unknown runner id: totally-made-up");
	});
});

// ---------------------------------------------------------------------------
// CLI wrapper internals (mainFromStdin / readStdinJson / argOrEnv /
// isDirectRun + the bottom IIFE) only run when the module is the process
// entry point, so they are unreachable from an in-process import. Drive them
// through a real subprocess of the TypeScript module via tsx, which sets
// import.meta.url === argv[1] and trips isDirectRun()'s true branch.
// ---------------------------------------------------------------------------

describe("hook-entry as a direct-run subprocess", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const entry = join(here, "hook-entry.ts");
	// Resolve tsx through module resolution, never a hand-built
	// node_modules/.bin path: a Stryker sandbox copies this file to
	// .stryker-tmp/sandbox-*/src with no .bin directory beside it, so the
	// literal path spawned ENOENT (status null) and every dry run that
	// scoped this file died as "expected null to be +0" with the cause
	// invisible. package.json is always an exported subpath, and spawning
	// process.execPath removes the shebang/exec-bit dependency too.
	const tsxCli = join(
		dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
		"dist",
		"cli.mjs",
	);

	function stdinErrorEntry(): string {
		const launcher = join(tmp, "stdin-error.mjs");
		writeFileSync(launcher, [
			'import { Readable } from "node:stream";',
			'Object.defineProperty(process, "stdin", { value: new Readable({ read() { this.destroy(new Error("stdin unavailable")); } }) });',
			`process.argv[1] = ${JSON.stringify(entry)};`,
			`await import(${JSON.stringify(entry)});`,
		].join("\n"));
		return launcher;
	}

	function runSubprocess(args: string[], input: string, extraEnv: Record<string, string>, stdinError = false) {
		const childHome = join(tmp, "home");
		mkdirSync(childHome, { recursive: true });
		const childEnv: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? dirname(process.execPath),
			HOME: childHome,
			USERPROFILE: childHome,
			TMPDIR: tmp,
			TMP: tmp,
			TEMP: tmp,
			NODE_ENV: "test",
			NO_COLOR: "1",
			INTERLINKED_HOME: interlinkedDir,
			INTERLINKED_DATA_DIR: interlinkedDir,
			INTERLINKED_SOCKET: missingSocket(),
			...extraEnv,
		};
		const r = spawnSync(process.execPath, [tsxCli, stdinError ? stdinErrorEntry() : entry, ...args], {
			input,
			encoding: "utf-8",
			cwd: tmp,
			env: childEnv,
			timeout: 30_000,
		});
		// A spawn-layer failure (missing binary/cwd, timeout kill) yields
		// status null; throw the real error rather than letting an assertion
		// report a bare "expected null to be +0".
		if (r.error) throw r.error;
		return r;
	}

	// test-contract: hermeticity — the direct-run contract must execute in a fresh child process without inheriting Vitest/Stryker loaders, worker IDs, user data paths, or the repository daemon's socket state.
	it("reads stdin JSON, dispatches via --runner/--event flags, and exits 0 (cold allow)", () => {
		const payload = JSON.stringify({
			session_id: "subproc1",
			cwd: tmp,
			tool_name: "Read",
			tool_input: { file_path: "/a" },
		});
		const r = runSubprocess(["--runner", "claude-code", "--event", "PreToolUse"], payload, {
			INTERLINKED_SOCKET: missingSocket(),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("evaluator skipped");
	});

	it("blocks rm -rf via the subprocess cold destructive gate and writes stdout", () => {
		const payload = JSON.stringify({
			session_id: "subproc2",
			cwd: tmp,
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
		});
		const r = runSubprocess(["--runner", "claude-code", "--event", "PreToolUse"], payload, {
			INTERLINKED_SOCKET: missingSocket(),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("permissionDecision");
		expect(r.stderr).toContain("destructive-command fail-closed gate engaged");
	});

	it("honors the --flag=value argOrEnv form", () => {
		const payload = JSON.stringify({
			session_id: "subproc3",
			cwd: tmp,
			tool_name: "Read",
			tool_input: {},
		});
		const r = runSubprocess(
			[`--runner=claude-code`, `--event=PreToolUse`, `--socket=${missingSocket()}`],
			payload,
			{},
		);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("evaluator skipped");
	});

	it("falls back to env vars when flags are absent, and tolerates empty stdin", () => {
		// No flags; everything via env. Empty stdin → readStdinJson returns {}.
		// With no payload cwd the daemon-down gate would resolve process.cwd()
		// (this repo IS a configured interlinked project) and fail closed, so we
		// stand that gate down to isolate the stdin-parsing path under test. The
		// daemon-down gate has its own coverage in hook-entry-daemon-gate.test.ts.
		const r = runSubprocess([], "", {
			INTERLINKED_RUNNER: "claude-code",
			INTERLINKED_EVENT: "PreToolUse",
			INTERLINKED_SOCKET: missingSocket(),
			INTERLINKED_ALLOW_NO_DAEMON: "1",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("evaluator skipped");
	});

	it("tolerates malformed stdin JSON (parse catch → {} payload)", () => {
		// Malformed stdin → {} payload → no cwd; stand down the daemon-down gate
		// (see the empty-stdin test above) so this exercises only stdin parsing.
		const r = runSubprocess(["--runner", "claude-code", "--event", "PreToolUse"], "{not json", {
			INTERLINKED_SOCKET: missingSocket(),
			INTERLINKED_ALLOW_NO_DAEMON: "1",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("evaluator skipped");
	});

	it("emits the no-runner-detected stderr when no runner is given", () => {
		const r = runSubprocess(["--event", "PreToolUse"], JSON.stringify({ session_id: "s" }), {
			// Strip inherited runner hints so detection genuinely fails.
			INTERLINKED_RUNNER: "",
			CLAUDE_CODE: "",
			CLAUDECODE: "",
			CLAUDE_CODE_VERSION: "",
			CLAUDE_WORKING_DIR: "",
			CURSOR_SESSION_ID: "",
			CURSOR_TRACE_ID: "",
			CURSOR_API_URL: "",
			CODEX_CLI: "",
			CODEX_SESSION_ID: "",
			CODEX_VERSION: "",
			OPENAI_CODEX_CLI: "",
			INTERLINKED_CLIENT: "",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no runner detected");
	});
	it("resolves stdin via the error-listener path (readStdinJson stdin error)", () => {
		const result = runSubprocess(
			["--runner", "claude-code", "--event", "PreToolUse"],
			"",
			{ INTERLINKED_ALLOW_NO_DAEMON: "1" },
			true,
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("evaluator skipped");
	});
});
