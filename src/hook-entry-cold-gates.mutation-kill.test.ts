import { // interlinked: defer test_missing_sut_import -- direct SUT import (3 named exports, used throughout below); the detector's sutBase strips only ".test.ts" from the filename, computing "hook-entry-cold-gates.mutation-kill" (from this file's ".mutation-kill.test.ts" suffix) instead of "hook-entry-cold-gates", so its regex never matches this correct specifier
	coldDestructiveCommandBlockReason,
	coldGraphShardBlockReason,
	coldMergeConflictBlockReason,
} from "./hook-entry-cold-gates.js";

// Mutation-survivor-kill companion for hook-entry-cold-gates.ts (fleet-r3,
// W5). Targets the 69 tractable survivors from
// `npx tsx src/index.ts mutation survivors --file src/hook-entry-cold-gates.ts`
// that hook-entry-cold-gates.test.ts's existing coverage did not distinguish.
// Every case here was empirically shadow-verified against the EXACT
// originalLexeme->replacement text before being ported here — see
// scratch/fleet-r3/src_hook-entry-cold-gates.ts-shadow-verify.mts and its
// receipts at scratch/fleet-r3/receipts/src_hook-entry-cold-gates.ts.jsonl.
// The remaining 23 survivors are equivalent mutants (dead code, redundant
// regex anchors, or reasoning the code's own downstream guards neutralize) —
// see the receipts file for the classification of each.

import { mkdtempSync, rmSync, statSync as realStatSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUnifiedEvent } from "./harness/__tests__/fixtures/unified-event.js";
import type { UnifiedHookEvent } from "./harness/unified-event.js";

// ---- fixtures ---------------------------------------------------------------

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "cold-gates-mk-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function makeToolCallEvent(over: {
	phase?: UnifiedHookEvent["phase"];
	tool_name?: string;
	tool_input?: unknown;
	cwd?: string;
}): UnifiedHookEvent {
	return makeUnifiedEvent({
		phase: over.phase ?? "pre-tool",
		action: {
			kind: "tool_call", tool_name: over.tool_name ?? "edit", tool_class: "modify",
			tool_input: over.tool_input, tool_input_redacted: over.tool_input,
		},
		context: { cwd: over.cwd ?? cwd },
	});
}

function makeFileOpEvent(over: { path: string; cwd?: string }): UnifiedHookEvent {
	return makeUnifiedEvent({
		action: { kind: "file_operation", operation: "edit", path: over.path, tool_class: "modify" },
		context: { cwd: over.cwd ?? cwd },
	});
}

// ===========================================================================
// coldGraphShardBlockReason
// ===========================================================================
describe("coldGraphShardBlockReason — mutation kills", () => {
	// test-contract: invariant — the cold gate's scope is limited to the pre-tool phase; a non-pre-tool event returns null even when a blocking shard condition is otherwise present.
	it("P1: phase gate — a non-pre-tool event never blocks even with a fresh shard", () => {
		const src = join(cwd, "a.ts");
		writeFileSync(src, "x");
		// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
		writeFileSync(join(cwd, "a.graph.ts"), "{}");
		const event = makeToolCallEvent({ phase: "post-tool", tool_input: { file_path: src } });
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	// test-contract: invariant — the block banner and its no-herd recovery guidance (retry, don't hand-start the daemon, wait 30s, override var) must match verbatim.
	it("P2: blocks a write to a file with a fresh colocated .graph shard (exact banner text)", () => {
		const src = join(cwd, "a.ts");
		writeFileSync(src, "x");
		// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
		writeFileSync(join(cwd, "a.graph.ts"), "{}");
		const reason = coldGraphShardBlockReason(makeToolCallEvent({ tool_input: { file_path: src } }));
		expect(reason).not.toBeNull();
		expect(reason).toContain("has a fresh Supermodel shard colocated. Edits to E-fresh files MUST go through the predict/reveal/reconcile loop.");
		// No-herd wording (2026-08-16): the banner must tell the reader to WAIT,
		// not to start a daemon. Every blocked caller running `harness start` at
		// once is the restart storm this repo spent two days unwinding.
		expect(reason).toContain(
			"Retry your edit in a few seconds — the daemon supervisor restarts the harness for you.",
		);
		expect(reason).toContain("Do NOT start one by hand; concurrent starts race each other.");
		expect(reason).toContain("Only if it is still down after 30 seconds, run: interlinked harness start.");
		expect(reason).toContain("Override (advanced, defeats the protocol): set INTERLINKED_DISABLE_GRAPH_SHARD_INLINE=1.");
	});

	// test-contract: invariant — only tool names classified as write tools are subject to the shard-freshness check; a read tool passes through even against an otherwise-blocking fresh shard.
	it("P: a read tool with a target path is not treated as a write tool", () => {
		// `colColdToolName` must preserve the tool_call's actual name. If its
		// file_operation branch is changed to unconditional, this becomes the
		// default `edit` tool and the fresh shard is incorrectly blocked.
		const src = join(cwd, "read-only.ts");
		writeFileSync(src, "x");
		// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
		writeFileSync(join(cwd, "read-only.graph.ts"), "{}");
		expect(
			coldGraphShardBlockReason(
				makeToolCallEvent({ tool_name: "read", tool_input: { file_path: src } }),
			),
		).toBeNull();
	});

	// test-contract: boundary — an apply_patch command with no parseable file header yields zero target paths; the parser must not fabricate a placeholder target.
	it("P: an empty apply_patch header list stays empty rather than inventing a sentinel target", () => {
		// The ArrayDeclaration mutant seeds `found` with "Stryker was here".
		// Make that exact path a fresh graph-sharded file so the fabricated
		// target would be observable through the cold graph gate.
		const sentinel = join(cwd, "Stryker was here");
		writeFileSync(sentinel, "x");
		// interlinked: defer real_io_in_tests -- path is under mkdtemp tmpdir, not the repo
		writeFileSync(`${sentinel}.graph`, "{}");
		const event = makeToolCallEvent({
			tool_name: "apply_patch",
			tool_input: { command: "*** Update File:   " },
		});
		expect(coldGraphShardBlockReason(event)).toBeNull();
	});

	// test-contract: boundary — a blank file_operation.path resolves to zero target paths rather than a default or sentinel location.
	it("P: a blank file_operation path produces no target paths", () => {
		// This also makes the `return []` array declaration observable: a
		// sentinel path would resolve to the deliberately sharded file below.
		const sentinel = join(cwd, "Stryker was here");
		writeFileSync(sentinel, "x");
		// interlinked: defer real_io_in_tests -- path is under mkdtemp tmpdir, not the repo
		writeFileSync(`${sentinel}.graph`, "{}");
		expect(coldGraphShardBlockReason(makeFileOpEvent({ path: "   " }))).toBeNull();
	});

	// test-contract: invariant — the shard check requires an actual colocated .graph file; the source file's own existence never satisfies it.
	it("P: the graph shard suffix is required; a source file alone is not its own shard", () => {
		const src = join(cwd, "suffix.ts");
		writeFileSync(src, "x");
		expect(coldGraphShardBlockReason(makeToolCallEvent({ tool_input: { file_path: src } }))).toBeNull();
	});

	// test-contract: invariant — with no colocated shard present at all, the gate never blocks the write.
	it("N1: source file exists but has no shard at all -> null", () => {
		const src = join(cwd, "onlysrc.ts");
		writeFileSync(src, "x");
		expect(coldGraphShardBlockReason(makeToolCallEvent({ tool_input: { file_path: src } }))).toBeNull();
	});

	describe("extractDirectPathInputs' condition-site .trim() (file_path key, tool_call branch)", () => {
		// test-contract: boundary — a whitespace-only tool_call file_path is filtered out before resolution, so it can never resolve to and block on the cwd's own shard.
		it("P1: a whitespace-only file_path is correctly filtered out even when cwd itself HAS a fresh 'trap' shard", () => {
			// resolvePath(cwd, "") === cwd itself if a blank path were WRONGLY
			// treated as non-blank -- a real cwd-level shard here is the trap
			// that would catch that bug and falsely block. The correct
			// (pristine) behavior keeps the path list empty and stays null.
			// interlinked: defer real_io_in_tests -- path is under mkdtemp tmpdir, not the repo
			writeFileSync(`${cwd}.graph`, "{}");
			const event = makeToolCallEvent({ tool_input: { file_path: "   " } });
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});

		// test-contract: boundary — baseline: a blank tool_call file_path never blocks when no cwd-level shard exists either.
		it("N1: an actually-blank file_path with no cwd-level shard present -> null (baseline)", () => {
			const event = makeToolCallEvent({ tool_input: { file_path: "   " } });
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});
	});

	// test-contract: boundary — a tool_call file_path padded with surrounding whitespace still resolves to the real, trimmed file and its shard.
	it("P: extractDirectPathInputs' push-site .trim() — a padded REAL path (tool_call file_path) still resolves to the trimmed file", () => {
		const src = join(cwd, "a.ts");
		writeFileSync(src, "x");
		// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
		writeFileSync(join(cwd, "a.graph.ts"), "{}");
		const event = makeToolCallEvent({ tool_input: { file_path: `  ${src}  ` } });
		expect(coldGraphShardBlockReason(event)).not.toBeNull();
	});

	describe("extractColdTargetPaths' file_operation-branch .trim() (path key)", () => {
		// test-contract: boundary — a whitespace-only file_operation.path is filtered out before resolution, so it can never resolve to and block on the cwd's own shard.
		it("P1: a whitespace-only file_operation.path is correctly filtered out even when cwd itself HAS a fresh 'trap' shard", () => {
			// interlinked: defer real_io_in_tests -- path is under mkdtemp tmpdir, not the repo
			writeFileSync(`${cwd}.graph`, "{}");
			expect(coldGraphShardBlockReason(makeFileOpEvent({ path: "   " }))).toBeNull();
		});

		// test-contract: boundary — baseline: a blank file_operation.path never blocks when no cwd-level shard exists either.
		it("N1: same whitespace-only path with no cwd-level shard -> null (baseline)", () => {
			expect(coldGraphShardBlockReason(makeFileOpEvent({ path: "   " }))).toBeNull();
		});

		// test-contract: boundary — a file_operation.path padded with surrounding whitespace still resolves to the real, trimmed file's shard.
		it("P3: a padded REAL file_operation.path still resolves to the trimmed file's shard", () => {
			const src = join(cwd, "a.ts");
			writeFileSync(src, "x");
			// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
			writeFileSync(join(cwd, "a.graph.ts"), "{}");
			expect(coldGraphShardBlockReason(makeFileOpEvent({ path: `  ${src}  ` }))).not.toBeNull();
		});
	});

	// test-contract: invariant — for a multi-dot filename, the shard path is derived from the file's actual final extension, not an earlier dot segment.
	it("P: the anchored extension regex takes the LAST dot-run, not the first (multi-dot filename)", () => {
		// /\.[^./]+$/ (anchored) must resolve "multi.dot.ts" -> ext ".ts" and
		// shard "multi.dot.graph.ts"; an unanchored mutant would instead find
		// ".dot" as the "extension" and look for a nonexistent bogus shard.
		const src = join(cwd, "multi.dot.ts");
		writeFileSync(src, "x");
		// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
		writeFileSync(join(cwd, "multi.dot.graph.ts"), "{}");
		expect(coldGraphShardBlockReason(makeToolCallEvent({ tool_input: { file_path: src } }))).not.toBeNull();
	});

	// test-contract: boundary — a shard mtime exactly at the grace-window edge still counts as fresh and blocks; the boundary value itself belongs to the fresh side.
	it("P vs N: shardMtime EXACTLY at the grace-window boundary still counts as fresh (< not <=)", () => {
		const src = join(cwd, "boundary.ts");
		writeFileSync(src, "x");
		const srcSec = Math.floor(realStatSync(src).mtimeMs / 1000) * 1000;
		utimesSync(src, new Date(srcSec), new Date(srcSec));
		const shard = join(cwd, "boundary.graph.ts");
		writeFileSync(shard, "{}");
		const GRACE_MS = 60_000;
		utimesSync(shard, new Date(srcSec - GRACE_MS), new Date(srcSec - GRACE_MS));
		// At the EXACT boundary, `shardMtime < sourceMtime - GRACE_MS` is
		// FALSE (they're equal) -> the shard still counts as fresh -> blocks.
		// A `<=` mutant would treat the boundary itself as stale -> null.
		expect(coldGraphShardBlockReason(makeToolCallEvent({ tool_input: { file_path: src } }))).not.toBeNull();
	});

	describe("apply_patch header extraction (APPLY_PATCH_FILE_HEADER_RE / APPLY_PATCH_MOVE_HEADER_RE)", () => {
		// test-contract: public-api — an apply_patch body containing both an Update File header and a Move header extracts the Update File target as a blockable path.
		it("P1: extracts BOTH an Update File header and a Move header target", () => {
			const src = join(cwd, "patched.ts");
			writeFileSync(src, "x");
			// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
			writeFileSync(join(cwd, "patched.graph.ts"), "{}");
			const patch = [
				"*** Begin Patch",
				`*** Update File: ${src}`,
				"@@",
				"-old",
				"+new",
				"*** Move to: some/other/path.ts",
				"*** End Patch",
			].join("\n");
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toContain(src);
		});

		// test-contract: boundary — Update File header text embedded mid-line is not treated as a real header; only a line-start header is recognized.
		it("P2: header text NOT at the start of a line is ignored (^ anchor, Update File)", () => {
			const src = join(cwd, "patched.ts");
			writeFileSync(src, "x");
			// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
			writeFileSync(join(cwd, "patched.graph.ts"), "{}");
			const patch = `junk text *** Update File: ${src}\n@@\n-old\n+new\n`;
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});

		// test-contract: boundary — Move-to header text embedded mid-line is not treated as a real header; only a line-start header is recognized.
		it("P3: header text NOT at the start of a line is ignored (^ anchor, Move to)", () => {
			const src = join(cwd, "patched.ts");
			writeFileSync(src, "x");
			// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
			writeFileSync(join(cwd, "patched.graph.ts"), "{}");
			const patch = `junk text *** Move to: ${src}\n@@\n-old\n+new\n`;
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});

		// test-contract: public-api — a patch containing only a Move-to header, with no Update/Add/Delete header, still extracts the move target.
		it("P4: a Move-to-only patch (no Update/Add/Delete header) still extracts the move target", () => {
			const src = join(cwd, "patched.ts");
			writeFileSync(src, "x");
			// interlinked: defer write_without_mkdir -- parent dir created by mkdtempSync in beforeEach above
			writeFileSync(join(cwd, "patched.graph.ts"), "{}");
			const patch = `*** Move to: ${src}\n@@\n-old\n+new\n`;
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toContain(src);
		});

		// test-contract: boundary — trailing whitespace after a header's path is stripped, so the trimmed real path is what the shard check resolves against.
		it("P5: collectApplyPatchHeaderPaths' (m[1] ?? \"\").trim() strips trailing padding after the real path", () => {
			const src = join(cwd, "patched.ts");
			writeFileSync(src, "x");
			writeFileSync(join(cwd, "patched.graph.ts"), "{}");
			const patch = `*** Update File: ${src}   \n@@\n-old\n+new\n`;
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toContain(src);
		});

		// test-contract: boundary — a header target that is only whitespace is discarded rather than treated as an empty real path that could resolve to cwd.
		it("P6: an all-whitespace header target (empty after trim) is filtered out, not treated as a real path", () => {
			// \s+ can consume up to end-of-string, forcing the regex engine to
			// backtrack down to a single leftover whitespace char for the
			// capture group -- which trims to "". The falsy-p guard must
			// reject it; letting it through would make cwd itself (via
			// resolvePath(cwd, "")) a spurious "target".
			// interlinked: defer real_io_in_tests -- path is under mkdtemp tmpdir, not the repo
			writeFileSync(`${cwd}.graph`, "{}");
			const patch = "*** Update File:   ";
			const event = makeToolCallEvent({ tool_name: "apply_patch", tool_input: { command: patch } });
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});

		// test-contract: invariant — tool_input.content is parsed as an apply_patch body only for the apply_patch tool; other tools' content is never scanned for header text.
		it("N: a non-apply_patch tool call never treats tool_input.content as a patch body", () => {
			// A "write" call's content happening to CONTAIN header-shaped text
			// must not be misread as an apply_patch body.
			const src = join(cwd, "a.ts");
			writeFileSync(src, "x");
			writeFileSync(join(cwd, "a.graph.ts"), "{}");
			const event = makeToolCallEvent({
				tool_name: "write",
				tool_input: { content: `*** Update File: ${src}` },
			});
			expect(coldGraphShardBlockReason(event)).toBeNull();
		});
	});

	describe("GRAPH_SHARD_WRITE_TOOLS membership — every surviving StringLiteral member", () => {
		const members = [
			"write_file",
			"edit_file",
			"file_write",
			"file_edit",
			"str_replace",
			"Edit",
			"create",
			"Write",
			"MultiEdit",
			"NotebookEdit",
			"EditFile",
			"WriteFile",
			"FileWrite",
			"FileEdit",
		];
		// test-contract: public-api — every listed write-tool name (across all supported runners) is recognized and triggers the shard block.
		it.each(members)("P: tool_name %s is recognized as a write tool and blocks", (toolName) => {
			const src = join(cwd, "a.ts");
			writeFileSync(src, "x");
			writeFileSync(join(cwd, "a.graph.ts"), "{}");
			const event = makeToolCallEvent({ tool_name: toolName, tool_input: { file_path: src } });
			expect(coldGraphShardBlockReason(event)).not.toBeNull();
		});
	});
});

// ===========================================================================
// coldMergeConflictBlockReason
// ===========================================================================
describe("coldMergeConflictBlockReason — mutation kills", () => {
	const MARKERS = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch";

	// test-contract: invariant — the merge-conflict block message text is pinned exactly, including the target path being written.
	it("P: blocks Write content (tool_input.content) carrying conflict markers, with the exact target path", () => {
		const p = join(cwd, "a.ts");
		const reason = coldMergeConflictBlockReason(
			makeToolCallEvent({ tool_input: { content: MARKERS, file_path: p } }),
		);
		expect(reason).not.toBeNull();
		expect(reason).toContain(p);
		expect(reason).toBe(
			`[interlinked:merge-conflict] BLOCKED: merge-conflict markers (<<<<<<<, =======, >>>>>>>) detected in the content being written to ${p}. A file with conflict markers is a guaranteed parse error — resolve the conflict before writing.`,
		);
	});

	// test-contract: security — a non-string edits[].new_string is rejected by its type guard before any implicit toString coercion could smuggle marker text past detection.
	it("P: an object new_string containing marker text is skipped without coercion", () => {
		// Array.prototype.join coerces non-string elements via ToString; the
		// `typeof ns === "string"` guard must reject BEFORE that coercion
		// ever has a chance to run.
		const event = makeToolCallEvent({
			tool_name: "multi_edit",
			tool_input: { edits: [{ new_string: { toString: MARKERS } }] },
		});
		expect(coldMergeConflictBlockReason(event)).toBeNull();
	});

	describe("MERGE_CONFLICT_MARKER_RE alternatives — brace count, anchor, whitespace class", () => {
		// test-contract: boundary — exactly seven '<' characters followed by a space is recognized as a genuine conflict-start marker.
		it("P1: exactly 7 '<' plus a space matches (first alternative)", () => {
			expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "<<<<<<< a\nx\n" } }))).not.toBeNull();
		});
		// test-contract: boundary — six '<' characters, one short of the marker, is not recognized as a conflict marker.
		it("N1: 6 '<' (one short) does not match via the first alternative", () => {
			expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "<<<<<< a\nx\n" } }))).toBeNull();
		});
		// test-contract: boundary — a conflict-start marker appearing mid-line rather than at line start is not recognized.
		it("P2: '<<<<<<<' mid-line (not at line start) does not match — the ^ anchor is required", () => {
			expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "abc <<<<<<< x\n" } }))).toBeNull();
		});
		// test-contract: boundary — exactly seven '=' characters alone on their own line is recognized as a genuine conflict-separator marker.
		it("P3: exactly 7 '=' alone on its own line matches (second alternative)", () => {
			expect(
				coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "line1\n=======\nline2\n" } })),
			).not.toBeNull();
		});
		// test-contract: boundary — seven '=' characters followed by any trailing character is not recognized as a conflict-separator marker.
		it("P4: 7 '=' plus a trailing character does not match — the $ anchor requires nothing after", () => {
			expect(
				coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "line1\n=======x\nline2\n" } })),
			).toBeNull();
		});
		// test-contract: boundary — a conflict-separator marker appearing mid-line rather than at line start is not recognized.
		it("P5: '=======' mid-line (not at line start) does not match — the ^ anchor is required", () => {
			expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "abc=======\n" } }))).toBeNull();
		});
		// test-contract: boundary — a conflict-end marker appearing mid-line rather than at line start is not recognized.
		it("P6: '>>>>>>>' mid-line (not at line start) does not match — the ^ anchor is required", () => {
			expect(coldMergeConflictBlockReason(makeToolCallEvent({ tool_input: { content: "abc >>>>>>> b\n" } }))).toBeNull();
		});
	});
});

// ===========================================================================
// coldDestructiveCommandBlockReason
// ===========================================================================
describe("coldDestructiveCommandBlockReason — mutation kills", () => {

	// test-contract: security — a non-string command value is rejected by its type guard before implicit toString coercion could smuggle destructive command text past detection.
	it("P: an object command containing destructive text is skipped without coercion", () => {
		// checkDestructiveCommand(cmd: string) has no typeof guard of its own
		// and uses regex .test()/.match() (which DO coerce via ToString), so
		// the `typeof ti.command === "string"` guard upstream is the ONLY
		// thing standing between a non-string command and a false block.
		const event = makeToolCallEvent({
			tool_name: "bash",
			tool_input: { command: { toString: "rm -rf /" } },
		});
		expect(coldDestructiveCommandBlockReason(event)).toBeNull();
	});

	describe("COLD_BASH_TOOL_NAMES membership — every surviving StringLiteral member", () => {
		const members = ["Bash", "Shell", "shell", "run_command", "local_shell"];
		// test-contract: public-api — every listed bash-tool name (across all supported runners) is recognized and a destructive command through it is blocked.
		it.each(members)("P: tool_name %s is recognized as a bash tool and blocks a destructive command", (toolName) => {
			const event = makeToolCallEvent({ tool_name: toolName, tool_input: { command: "rm -rf /" } });
			expect(coldDestructiveCommandBlockReason(event)).toContain("BLOCKED");
		});
	});

	// test-contract: invariant — the rm -rf block reason text in the cold fallback path matches the canonical message exactly.
	it("P: the canonical rm -rf reason is preserved in the cold path", () => {
		const event = makeToolCallEvent({ tool_name: "bash", tool_input: { command: "rm -rf /tmp/example" } });
		expect(coldDestructiveCommandBlockReason(event)).toBe(
			"BLOCKED: Recursive force-delete (rm -rf). Use targeted, non-recursive removal.",
		);
	});
});
