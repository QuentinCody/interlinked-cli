// Mutation-kill pass (wave 28) for ../activity-writer.ts. Targets specific
// survivor mutantIds from .interlinked/mutation-manifest.json — see
// scratch/fleet-r3/receipts/activity-writer.jsonl for the disposition of
// every assigned mutant.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActivityPath } from "../../../lib/local-activity-paths.js";
import { readLocalActivity } from "../../../lib/local-activity.js";
import type { HarnessDecision, HarnessEvent } from "../../types.js";
import {
	mapDecisionToGuardRecord,
	mapEventToActivityRecord,
	writeActivityRecord,
	writeGuardDecisionRecord,
} from "../activity-writer.js";

function harnessEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-06-06T12:00:00.000Z",
		...partial,
	};
}

function dec(partial: Partial<HarnessDecision> = {}): HarnessDecision {
	return { decision: "allow", ...partial };
}

describe("summarize — truncation and type-guard mutants", () => {
	// test-contract: public-api — summarize() truncates a command to 200 chars
	it("truncates a long command to 200 chars", () => {
		const long = "x".repeat(300);
		const rec = mapEventToActivityRecord(
			harnessEvent({ tool_name: "Bash", tool_input: { command: long } }),
			"/r",
		);
		expect(rec?.summary).toBe("x".repeat(200));
		expect(rec?.summary?.length).toBe(200);
	});

	// test-contract: public-api — summarize() truncates a pattern to 200 chars
	it("truncates a long pattern to 200 chars", () => {
		const long = "y".repeat(300);
		const rec = mapEventToActivityRecord(
			harnessEvent({ tool_name: "Grep", tool_input: { pattern: long } }),
			"/r",
		);
		expect(rec?.summary).toBe("y".repeat(200));
		expect(rec?.summary?.length).toBe(200);
	});

	// test-contract: boundary — a non-string command must fail the typeof guard
	// in str() and fall through to the tool name, not reach command.slice()
	it("does not treat a non-string command as usable, falls through to tool name", () => {
		const input = { tool_name: "SomeTool", tool_input: { command: 12345 } };
		const rec = mapEventToActivityRecord(harnessEvent(input), "/r");
		expect(rec?.summary).toBe("SomeTool");
	});
});

describe("projectKeys — config-derived workspace/project defaults", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-writer-keys-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: boundary — with no config file at all, both keys fall back to "main"
	it("falls back to workspace 'main' and project 'main' with no config present", () => {
		const rec = mapEventToActivityRecord(harnessEvent({ cwd: dir }), dir);
		expect(rec?.workspace_key).toBe("main");
		expect(rec?.project_key).toBe("main");
	});

	// test-contract: invariant — workspace_id (local config) is used when there is
	// no default_workspace_key, discriminating the inner ?? chain from &&
	it("uses local config.workspace_id when default_workspace_key is absent", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "config.local.json"),
			JSON.stringify({ workspace_id: "ws-explicit" }),
		);
		const rec = mapEventToActivityRecord(harnessEvent({ cwd: dir }), dir);
		expect(rec?.workspace_key).toBe("ws-explicit");
	});

	// test-contract: invariant — projectKeys caches per-cwd; a second call with
	// the same cwd must not re-read a changed config file
	it("caches project keys per cwd across calls", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ default_project: "p1" }));
		const first = mapEventToActivityRecord(harnessEvent({ cwd: dir, session_id: "a" }), dir);
		expect(first?.project_key).toBe("p1");
		writeFileSync(join(dir, ".interlinked", "config.json"), JSON.stringify({ default_project: "p2" }));
		const second = mapEventToActivityRecord(harnessEvent({ cwd: dir, session_id: "b" }), dir);
		expect(second?.project_key).toBe("p1");
	});
});

describe("mapEventToActivityRecord — optional-field presence/absence", () => {
	// test-contract: public-api — absent optional fields must not appear on the record at all
	it("omits parent_tool_use_id, prompt_id, effort, seq, event_id when absent", () => {
		const rec = mapEventToActivityRecord(harnessEvent({}), "/r");
		expect(rec && "parent_tool_use_id" in rec).toBe(false);
		expect(rec && "prompt_id" in rec).toBe(false);
		expect(rec && "effort" in rec).toBe(false);
		expect(rec && "seq" in rec).toBe(false);
		expect(rec && "event_id" in rec).toBe(false);
	});

	// test-contract: public-api — present optional fields must carry through with their value
	it("carries parent_tool_use_id, prompt_id, effort, seq, event_id when present", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({
				parent_tool_use_id: "ptu_1",
				prompt_id: "prompt_1",
				effort: "high",
				seq: 7,
				event_id: "ev_1",
			}),
			"/r",
		);
		expect(rec?.parent_tool_use_id).toBe("ptu_1");
		expect(rec?.prompt_id).toBe("prompt_1");
		expect(rec?.effort).toBe("high");
		expect(rec?.seq).toBe(7);
		expect(rec?.event_id).toBe("ev_1");
	});

	// test-contract: boundary — a missing tool_input must default to {} not undefined
	it("defaults tool_input to {} when the event carries none", () => {
		const rec = mapEventToActivityRecord(harnessEvent({}), "/r");
		expect(rec?.tool_input).toEqual({});
	});
});

describe("writeActivityRecord — thinking-capture branch gating", () => {
	let dir: string;
	let other: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-writer-think-"));
		other = mkdtempSync(join(tmpdir(), "activity-writer-other-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	});

	// test-contract: invariant — thinking capture must only run for tool_use_start,
	// never for tool_use / tool_use_error records
	it("does not attach thinking/model to a non-tool_use_start record", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "t.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { model: "m-x", content: [{ type: "thinking", thinking: "reasoning" }] } })}\n`,
		);
		writeActivityRecord(
			harnessEvent({
				hook_event: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				cwd: dir,
				session_id: "non-start",
				transcript_path: transcript,
			}),
			dir,
		);
		const rec = readLocalActivity({ cwd: dir }).find((e) => e.type === "tool_use");
		expect(rec && "thinking" in rec).toBe(false);
		expect(rec && "model" in rec).toBe(false);
	});

	// test-contract: invariant — the cursor file must be written under the
	// ".interlinked" subdirectory of the resolved cwd, not the cwd root
	it("writes the thinking cursor under <cwd>/.interlinked/thinking-cursor.json", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "t2.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { model: "m-y", content: [{ type: "thinking", thinking: "reasoning-2" }] } })}\n`,
		);
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "x.ts" },
				cwd: dir,
				session_id: "cursor-loc",
				transcript_path: transcript,
			}),
			dir,
		);
		expect(existsSync(join(dir, ".interlinked", "thinking-cursor.json"))).toBe(true);
	});

	// test-contract: boundary — when the transcript has no thinking blocks and no
	// model, neither field should appear on the record (not set-to-undefined)
	it("omits thinking and model when neither is present in the transcript", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "empty.jsonl");
		writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "y.ts" },
				cwd: dir,
				session_id: "no-think",
				transcript_path: transcript,
			}),
			dir,
		);
		const rec = readLocalActivity({ cwd: dir }).find((e) => e.type === "tool_use_start");
		expect(rec && "thinking" in rec).toBe(false);
		expect(rec && "model" in rec).toBe(false);
	});

	// test-contract: invariant — the write must land at event.cwd, never
	// fallbackCwd, when event.cwd is set and differs from fallbackCwd
	it("appends to event.cwd, not fallbackCwd, when both are set and differ", () => {
		writeActivityRecord(
			harnessEvent({
				hook_event: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "echo hi" },
				cwd: dir,
				session_id: "cwd-pref",
			}),
			other,
		);
		expect(readLocalActivity({ cwd: dir }).length).toBe(1);
		expect(readLocalActivity({ cwd: other }).length).toBe(0);
	});
});

describe("mapDecisionToGuardRecord — field derivation mutants", () => {
	// test-contract: invariant — event.cwd wins over fallbackCwd when both are set
	it("prefers event.cwd over fallbackCwd", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({ cwd: "/explicit-cwd" }),
			dec({ decision: "block", reason: "x" }),
			"/other-fallback",
		);
		expect(rec?.cwd).toBe("/explicit-cwd");
	});

	// test-contract: invariant — agent_source is used when agent_name is absent
	// (discriminates the inner ?? chain from &&)
	it("uses agent_source when agent_name is absent", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({ agent_source: "src-x" }),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec?.agent).toBe("src-x");
	});

	// test-contract: invariant — a real tool_name is carried through, not dropped to null
	it("carries a truthy tool_name through instead of null", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({ tool_name: "Bash" }),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec?.tool).toBe("Bash");
	});

	// test-contract: public-api — a long reason string is truncated to exactly 500 chars
	it("truncates a long guard reason to 500 chars", () => {
		const long = "z".repeat(700);
		const rec = mapDecisionToGuardRecord(
			harnessEvent({}),
			dec({ decision: "block", reason: long }),
			"/r",
		);
		expect(rec?.summary?.length).toBe(500);
		expect(rec?.summary).toBe("z".repeat(500));
	});

	// test-contract: boundary — with reason and warnings both absent, the
	// optional chain on warnings?.join must not throw, and summary falls to "guard"
	it("falls back to 'guard' when reason and warnings are both absent", () => {
		const rec = mapDecisionToGuardRecord(harnessEvent({}), dec({ decision: "block" }), "/r");
		expect(rec?.summary).toBe("guard");
	});

	// test-contract: public-api — warnings are joined with "; " as the separator
	it("joins multiple warnings with '; '", () => {
		const rec = mapDecisionToGuardRecord(harnessEvent({}), dec({ warnings: ["a", "b"] }), "/r");
		expect(rec?.summary).toBe("a; b");
	});

	// test-contract: public-api — tool_use_id is omitted from the record when absent
	it("omits tool_use_id when absent", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({}),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec && "tool_use_id" in rec).toBe(false);
	});

	// test-contract: boundary — seq is omitted when the event carries none
	it("omits seq when absent", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({}),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec && "seq" in rec).toBe(false);
	});

	// test-contract: public-api — seq is carried through with its real value when present
	it("carries seq through when present", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({ seq: 5 }),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec?.seq).toBe(5);
	});

	// test-contract: boundary — guard_harness_ms is omitted when checks_timing_ms is absent
	it("omits guard_harness_ms when checks_timing_ms is absent", () => {
		const rec = mapDecisionToGuardRecord(
			harnessEvent({}),
			dec({ decision: "block", reason: "x" }),
			"/r",
		);
		expect(rec && "guard_harness_ms" in rec).toBe(false);
	});
});

describe("writeGuardDecisionRecord — write-target and no-op mutants", () => {
	let dir: string;
	let other: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "guard-writer-cwd-"));
		other = mkdtempSync(join(tmpdir(), "guard-writer-other-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	});

	// test-contract: invariant — the record must land at event.cwd, never fallbackCwd
	it("appends to event.cwd, not fallbackCwd, when both are set and differ", () => {
		writeGuardDecisionRecord(
			harnessEvent({ cwd: dir, tool_name: "Bash", session_id: "gw-cwd" }),
			dec({ decision: "block", reason: "BLOCKED: x" }),
			other,
		);
		expect(readLocalActivity({ cwd: dir }).length).toBe(1);
		expect(readLocalActivity({ cwd: other }).length).toBe(0);
	});

	// test-contract: boundary — a bare allow (mapDecisionToGuardRecord -> null)
	// must write NOTHING at all, not even a raw "null" line to the file
	it("creates no activity.jsonl file at all for a bare allow", () => {
		writeGuardDecisionRecord(harnessEvent({ cwd: dir }), dec(), dir);
		expect(existsSync(getActivityPath(dir))).toBe(false);
	});
});
