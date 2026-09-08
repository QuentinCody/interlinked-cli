import { isJsonObject } from "../../../lib/json-types.js";
// Tests for the daemon's legacy-stream dual-write: HarnessEvent → v5
// LocalActivityEvent → activity.jsonl, so the CLI reader commands keep working
// after the collection.jsonl migration. The round-trip cases drive the actual
// reader (readLocalActivity) to prove the mirror is consumable, not just written.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain } from "../../../lib/audit-chain.js";
import { readLocalActivity } from "../../../lib/local-activity.js";
import { nonNull } from "../../../lib/non-null.js";
import type { HarnessDecision, HarnessEvent } from "../../types.js";
import {
	mapEventToActivityRecord,
	mapLifecycleEventToActivityRecord,
	writeActivityRecord,
	writeGuardDecisionRecord,
	writeLifecycleActivityRecord,
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

describe("mapEventToActivityRecord — v5 mapping", () => {
	it("maps PreToolUse to a tool_use_start record with the core fields", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls -la" },
			}),
			"/repo",
		);
		expect(rec).not.toBeNull();
		expect(rec?.type).toBe("tool_use_start");
		expect(rec?.tool).toBe("Bash");
		expect(rec?.summary).toBe("ls -la");
		expect(rec?.hook).toBe("PreToolUse");
		expect(rec?.session).toBe("sess-1");
		expect(rec?.schema_version).toBe(5);
	});

	it("maps PostToolUse → tool_use and PostToolUseFailure → tool_use_error", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "PostToolUse" }), "/r")?.type).toBe(
			"tool_use",
		);
		expect(
			mapEventToActivityRecord(harnessEvent({ hook_event: "PostToolUseFailure" }), "/r")?.type,
		).toBe("tool_use_error");
	});

	it("maps Gemini BeforeTool/AfterTool", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "BeforeTool" }), "/r")?.type).toBe(
			"tool_use_start",
		);
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "AfterTool" }), "/r")?.type).toBe(
			"tool_use",
		);
	});

	it("returns null for non-tool (lifecycle) events", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "SessionStart" }), "/r")).toBeNull();
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "Stop" }), "/r")).toBeNull();
	});

	it("derives the summary: command, then file path, then pattern, then tool name", () => {
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Bash", tool_input: { command: "npm test" } }),
				"/r",
			)?.summary,
		).toBe("npm test");
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
				"/r",
			)?.summary,
		).toBe("/a.ts");
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
				"/r",
			)?.summary,
		).toBe("foo");
		expect(
			mapEventToActivityRecord(harnessEvent({ tool_name: "SomeTool", tool_input: {} }), "/r")
				?.summary,
		).toBe("SomeTool");
	});

	it("prefers event.cwd over the fallback and carries tool_use_id when present", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({ cwd: "/explicit", tool_use_id: "tu_9" }),
			"/fallback",
		);
		expect(rec?.cwd).toBe("/explicit");
		expect(rec?.tool_use_id).toBe("tu_9");
	});

	it("omits tool_use_id when absent (exactOptionalPropertyTypes)", () => {
		const rec = mapEventToActivityRecord(harnessEvent({}), "/r");
		expect(rec && "tool_use_id" in rec).toBe(false);
	});

	it("uses agent_name when present, else falls back to agent_source", () => {
		expect(mapEventToActivityRecord(harnessEvent({ agent_name: "alice" }), "/r")?.agent).toBe(
			"alice",
		);
		expect(mapEventToActivityRecord(harnessEvent({}), "/r")?.agent).toBe("claude");
	});

	it("carries subagent, parent, and model attribution without replacing the parent session", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({
				session_id: "parent-session",
				agent_name: "/root/kill_a_survivors",
				subagent_id: "sub-thread",
				parent_agent: "parent-thread",
				model: "vendor-model-luna",
			}),
			"/r",
		);
		expect(rec).toMatchObject({
			session: "parent-session",
			agent: "/root/kill_a_survivors",
			subagent_id: "sub-thread",
			parent_agent: "parent-thread",
			model: "vendor-model-luna",
		});
	});
});

describe("mapLifecycleEventToActivityRecord — non-tool mapping", () => {
	it.each([
		["SessionStart", "session_start"],
		["SessionEnd", "session_end"],
		["Interrupt", "interrupt"],
		["Stop", "agent_stop"],
		["UserPromptSubmit", "user_prompt"],
		["Notification", "notification"],
		["PreCompact", "context_compact"],
		["PreCompress", "context_compact"],
		["PostCompact", "context_compacted"],
		["AfterModel", "model_response"],
		["TeammateIdle", "teammate_idle"],
		["PermissionRequest", "permission_request"],
		["WorktreeCreate", "worktree_create"],
		["SkillEnter", "skill_enter"],
		["SkillLeave", "skill_leave"],
		["SkillList", "skill_list"],
	])("normalizes %s to %s", (hookEvent, expectedType) => {
		const rec = mapLifecycleEventToActivityRecord(
			harnessEvent({ hook_event: hookEvent }),
			"/repo",
		);
		expect(rec?.type).toBe(expectedType);
	});

	it("uses the scanner's redacted prompt for both prompt and summary", () => {
		const rawPrompt = "Email alice@example.com with the release details";
		const decision: HarnessDecision = {
			decision: "allow",
			redacted_prompt: "Email <EMAIL> with the release details",
		};
		const rec = mapLifecycleEventToActivityRecord(
			harnessEvent({
				agent_source: "codex",
				hook_event: "UserPromptSubmit",
				prompt: rawPrompt,
				seq: 7,
				event_id: "evt-prompt",
			}),
			"/repo",
			decision,
		);

		expect(rec).toMatchObject({
			type: "user_prompt",
			agent: "codex",
			prompt: "Email <EMAIL> with the release details",
			summary: "Email <EMAIL> with the release details",
			scrubbed: true,
			seq: 7,
			event_id: "evt-prompt",
		});
		expect(JSON.stringify(rec)).not.toContain(rawPrompt);
	});

	it.each([
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"BeforeTool",
		"AfterTool",
		// These already have canonical collection.v1 agent_event records.
		"SubagentStart",
		"SubagentStop",
		"TaskCompleted",
	])(
		"never maps tool event %s through the lifecycle writer",
		(hookEvent) => {
			expect(
				mapLifecycleEventToActivityRecord(harnessEvent({ hook_event: hookEvent }), "/repo"),
			).toBeNull();
		},
	);
});

describe("writeActivityRecord — round-trips through readLocalActivity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-writer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("a written tool event is readable by the reader the CLI commands use", () => {
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				cwd: dir,
				session_id: "round-trip",
			}),
			dir,
		);
		const events = readLocalActivity({ cwd: dir });
		expect(events.length).toBe(1);
		expect(nonNull(events[0]).type).toBe("tool_use_start");
		expect(nonNull(events[0]).tool).toBe("Bash");
		expect(nonNull(events[0]).summary).toBe("ls");
		expect(nonNull(events[0]).session).toBe("round-trip");
	});

	it("writes nothing for a lifecycle event", () => {
		writeActivityRecord(harnessEvent({ hook_event: "SessionStart", cwd: dir }), dir);
		expect(readLocalActivity({ cwd: dir })).toEqual([]);
	});

	it("is best-effort: never throws", () => {
		expect(() =>
			writeActivityRecord(harnessEvent({ hook_event: "PreToolUse", cwd: dir }), dir),
		).not.toThrow();
	});

	it("attaches scrubbed thinking from the transcript to a tool_use_start record", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "transcript.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { model: "claude-test-5", content: [{ type: "thinking", thinking: "the reasoning, secret sk-aaaaaaaaaaaaaaaaaaaaaaaa" }] } })}\n`,
		);
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Read",
				tool_input: { file_path: "x.ts" },
				cwd: dir,
				session_id: "think-rt",
				transcript_path: transcript,
			}),
			dir,
		);
		const tu = readLocalActivity({ cwd: dir }).find((e) => e.type === "tool_use_start");
		expect(tu?.thinking).toContain("the reasoning");
		expect(tu?.thinking).not.toContain("sk-aaaaaaaaaaaaaaaaaaaaaaaa");
		expect(tu?.model).toBe("claude-test-5");
	});

	it("does not run the Claude thinking reader for a Codex rollout", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "codex-rollout.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { model: "wrong-parser", content: [{ type: "thinking", thinking: "must not attach" }] } })}\n`,
		);
		writeActivityRecord(
			harnessEvent({
				agent_source: "codex",
				hook_event: "PreToolUse",
				tool_name: "Read",
				cwd: dir,
				transcript_path: transcript,
			}),
			dir,
		);

		const rec = readLocalActivity({ cwd: dir }).find((event) => event.type === "tool_use_start");
		expect(rec && "thinking" in rec).toBe(false);
		expect(rec && "model" in rec).toBe(false);
		expect(existsSync(join(dir, ".interlinked", "thinking-cursor.json"))).toBe(false);
	});

	// Parity guard: the active hook-entry → daemon path must capture the SAME
	// field surface the old self-contained .mjs hook did. The thinking-capture
	// regression happened because a capability present in one hook impl was
	// silently absent in the active one. If a future edit drops any field below
	// from the active capture path, this fails loudly.
	it("capture completeness (parity guard): a tool_use_start record carries the full field set", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const transcript = join(dir, "t.jsonl");
		writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { model: "model-x", content: [{ type: "thinking", thinking: "reasoning here" }] } })}\n`,
		);
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_use_id: "tu_1",
				cwd: dir,
				session_id: "sess-x",
				transcript_path: transcript,
			}),
			dir,
		);
		const rec = readLocalActivity({ cwd: dir }).find((e) => e.type === "tool_use_start");
		if (!isJsonObject(rec)) throw new Error("Expected an activity record");
		const required = [
			"schema_version",
			"ts",
			"type",
			"tool",
			"summary",
			"session",
			"hook",
			"tool_input",
			"tool_use_id",
			"cwd",
			"thinking",
			"model",
		];
		const missing = required.filter((k) => rec?.[k] === undefined);
		expect(missing).toEqual([]);
	});
});

describe("writeLifecycleActivityRecord — redacted round-trip", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lifecycle-activity-writer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends one redacted prompt row readable by CLI activity readers", () => {
		const rawPrompt = "Contact alice@example.com about the incident";
		writeLifecycleActivityRecord(
			harnessEvent({
				agent_source: "codex",
				cwd: dir,
				hook_event: "UserPromptSubmit",
				prompt: rawPrompt,
				session_id: "codex-prompt",
			}),
			dir,
			{ decision: "allow", redacted_prompt: "Contact <EMAIL> about the incident" },
		);

		const events = readLocalActivity({ cwd: dir });
		expect(events).toHaveLength(1);
		expect(nonNull(events[0])).toMatchObject({
			type: "user_prompt",
			prompt: "Contact <EMAIL> about the incident",
			summary: "Contact <EMAIL> about the incident",
			scrubbed: true,
			session: "codex-prompt",
		});
		expect(readFileSync(join(dir, ".interlinked", "activity.jsonl"), "utf8")).not.toContain(
			rawPrompt,
		);
	});

	it("writes nothing when accidentally passed a PreToolUse event", () => {
		writeLifecycleActivityRecord(
			harnessEvent({ hook_event: "PreToolUse", cwd: dir }),
			dir,
		);
		expect(readLocalActivity({ cwd: dir })).toEqual([]);
	});

	it("hash-chains a SessionEnd record through the same audit contract", () => {
		writeLifecycleActivityRecord(
			harnessEvent({ hook_event: "SessionEnd", cwd: dir, tool_input: { reason: "complete" } }),
			dir,
		);

		expect(verifyAuditChain(dir)).toMatchObject({
			valid: true,
			guard_events: 1,
			chained_events: 1,
			unchained_guard_events: 0,
		});
	});
});

// All three writers are best-effort by contract (feedback_safety_continuity):
// observability I/O must never break hook evaluation. The failure is injected
// for real, not mocked — `.interlinked` is a regular FILE, so every append
// under it raises ENOTDIR — and each case asserts the writer returned with the
// sentinel untouched, i.e. it swallowed the error and wrote nothing.
describe("activity writers — a failed append is swallowed, not propagated", () => {
	const SENTINEL = "a regular file where .interlinked/ should be";
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-writer-unwritable-"));
		writeFileSync(join(dir, ".interlinked"), SENTINEL);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writeActivityRecord swallows an unwritable tool-event mirror", () => {
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				cwd: dir,
			}),
			dir,
		);
		expect(readFileSync(join(dir, ".interlinked"), "utf8")).toBe(SENTINEL);
	});

	it("writeLifecycleActivityRecord swallows an unwritable SessionEnd audit-chain append", () => {
		writeLifecycleActivityRecord(harnessEvent({ hook_event: "SessionEnd", cwd: dir }), dir);
		expect(readFileSync(join(dir, ".interlinked"), "utf8")).toBe(SENTINEL);
	});

	it("writeGuardDecisionRecord swallows an unwritable guard_block append", () => {
		writeGuardDecisionRecord(
			harnessEvent({ hook_event: "PreToolUse", tool_name: "Bash", cwd: dir }),
			{ decision: "block", reason: "BLOCKED: recursive deletion", rule_id: "builtin-rm-rf" },
			dir,
		);
		expect(readFileSync(join(dir, ".interlinked"), "utf8")).toBe(SENTINEL);
	});
});
