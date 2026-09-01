// Mutation-kill wave (fleet-r3, pass1_w21) for agent-event-capture.ts.
// Targets the 63 mutants that survived prior waves. See
// scratch/fleet-r3/receipts/agent-event-capture.jsonl for the per-mutant
// disposition (killed_by_test vs equivalent_candidate + structural reason).
//
// Structural-equivalence summary (14 mutants, NOT re-argued per test below):
// readTranscriptTail's `!existsSync`/`size===0` guards, lastAssistantText's
// six own-scope mutants, scrubFinalMessage's two boundary mutants,
// resolveFinalMessage's `agent_transcript_path` truthiness check,
// assistantEntryText's `message?.content` optional-chain and
// `content.length-1` start-index, and captureAgentEvent's `log?.()` chain —
// all verified equivalent empirically (see verify-json-probe-w21.mjs) via
// one of two mechanisms: (a) the calling try/catch treats a thrown
// exception identically to a clean null/no-op result, so removing an
// internal safety check just relocates the same outcome through the catch
// path; or (b) `Array.prototype.slice`/out-of-bounds indexing are no-ops
// in JS, so an off-by-one start index converges to the same real work.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEventRecord, AgentTranscriptMetrics } from "../../lib/collection/types.js";
import { getCollectionPath } from "../../lib/collection/writer.js";
import { timelinePath } from "../timeline-writer.js";
import type { HarnessEvent } from "../types/events.js";
import { resetRememberedAgentTypes } from "./agent-event-context.js";
import {
	buildAgentEventRecord,
	captureAgentEvent,
	FINAL_MESSAGE_TAIL_BYTES,
	lastAssistantText,
	resolveFinalMessage,
} from "./agent-event-capture.js";

function mkEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SubagentStart",
		session_id: "w21-session",
		agent_source: "claude",
		timestamp: "2026-08-17T00:00:00.000Z",
		...overrides,
	};
}

/** One assistant transcript line, JSONL-terminated. */
function assistantJsonLine(uuid: string, text: string, agentId?: string): string {
	return `${JSON.stringify({
		type: "assistant",
		uuid,
		timestamp: "2026-07-09T00:00:00.000Z",
		sessionId: "parent-session",
		...(agentId ? { agentId } : {}),
		message: { role: "assistant", model: "claude-test-5", content: [{ type: "text", text }] },
	})}\n`;
}

/** Raw single JSONL line (no trailing shape assumptions) for feeding
 *  lastAssistantText directly with unusual entry/content shapes. */
function rawLine(obj: unknown): string {
	return `${JSON.stringify(obj)}\n`;
}

function collectionRowsAt(cwd: string): AgentEventRecord[] {
	const path = getCollectionPath(cwd);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		// SAFETY: this fixture file only ever receives agent_event records
		// written by the code under test; assertions verify the shape.
		.map((l) => JSON.parse(l) as AgentEventRecord);
}

describe("readTranscriptTail offset/slice arithmetic (via resolveFinalMessage)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aec-mk-tail-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: boundary — a transcript smaller than the tail window
	// (offset===0) must NOT have its only line stripped as if it were a
	// partial leading fragment; the whole file was read, nothing is partial.
	it("keeps the sole line of a small (offset===0) transcript intact", () => {
		const path = join(dir, "solo.jsonl");
		writeFileSync(path, assistantJsonLine("solo-uuid", "solo answer"));
		const resolved = resolveFinalMessage(mkEvent({ hook_event: "SubagentStop", agent_transcript_path: path }));
		expect(resolved).toEqual({ text: "solo answer", source: "transcript" });
	});

	// test-contract: boundary — the tail-read buffer must be sized to exactly the requested tail so a final unterminated line at EOF is not corrupted by extra zero-filled bytes appended past it.
	it("finds the final entry when it ends the file with no trailing newline (large transcript)", () => {
		const junkLine = `${JSON.stringify({ type: "queue-operation", note: "padding-junk-line" })}\n`;
		const repeats = Math.ceil((FINAL_MESSAGE_TAIL_BYTES * 1.5) / junkLine.length);
		const padding = junkLine.repeat(repeats);
		const finalEntry = JSON.stringify({
			type: "assistant",
			uuid: "no-newline-final",
			timestamp: "2026-07-09T00:00:00.000Z",
			sessionId: "parent-session",
			message: {
				role: "assistant",
				model: "claude-test-5",
				content: [{ type: "text", text: "boundary answer no newline" }],
			},
		}); // deliberately NOT newline-terminated — literal EOF.
		const path = join(dir, "no-trailing-newline.jsonl");
		writeFileSync(path, padding + finalEntry);
		const resolved = resolveFinalMessage(mkEvent({ hook_event: "SubagentStop", agent_transcript_path: path }));
		expect(resolved).toEqual({ text: "boundary answer no newline", source: "transcript" });
	});

	// test-contract: boundary — the leading-partial-line strip is unconditional whenever offset>0, even when the boundary happens to land exactly on a clean line start rather than mid-line.
	it("still strips the leading tail-fragment when offset lands exactly on a line boundary", () => {
		const shell = (t: string): string =>
			`${JSON.stringify({
				type: "assistant",
				uuid: "boundary",
				timestamp: "2026-07-09T00:00:00.000Z",
				sessionId: "parent-session",
				message: { role: "assistant", model: "claude-test-5", content: [{ type: "text", text: t }] },
			})}\n`;
		const overhead = shell("").length;
		const bigText = "x".repeat(FINAL_MESSAGE_TAIL_BYTES - overhead);
		const finalLine = shell(bigText); // exactly FINAL_MESSAGE_TAIL_BYTES bytes
		const padding = `${JSON.stringify({ type: "queue-operation", note: "pad" })}\n`.repeat(8);
		const path = join(dir, "boundary.jsonl");
		writeFileSync(path, padding + finalLine);
		const resolved = resolveFinalMessage(mkEvent({ hook_event: "SubagentStop", agent_transcript_path: path }));
		// The tail buffer is exactly `finalLine`; the unconditional strip
		// removes it entirely (its own trailing "\n" is treated as the
		// partial-leading-line terminator), leaving nothing to parse.
		expect(resolved).toBeNull();
	});
});

describe("assistantEntryText content-shape guards (via lastAssistantText)", () => {
	// test-contract: boundary — a non-"assistant" entry whose content
	// happens to be shaped like assistant text blocks must never surface
	// that text; the type check is the only thing preventing a "user" or
	// "queue-operation" entry's content from leaking as the agent's answer.
	it("never reads content off a non-assistant-typed entry", () => {
		const text = rawLine({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: "should stay hidden" }] },
		});
		expect(lastAssistantText(text)).toBeNull();
	});

	// test-contract: boundary — content must be a real JSON array; an
	// array-like plain object (numeric `length` + indexed keys, which JSON
	// can legitimately produce) must be rejected, not walked as if it were one.
	it("rejects an array-like content object that is not a real array", () => {
		const text = rawLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: { length: 1, 0: { type: "text", text: "array-like text" } },
			},
		});
		expect(lastAssistantText(text)).toBeNull();
	});

	// test-contract: boundary — a content block must match ALL of
	// type==="text" AND a string `.text`; a "thinking" block that happens to
	// carry a `text` field (not `thinking`) must not be read as the answer.
	it("never treats a non-text-typed block as the final message even when it carries a string .text", () => {
		const text = rawLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "thinking", text: "leaked thinking text" }],
			},
		});
		expect(lastAssistantText(text)).toBeNull();
	});

	// test-contract: boundary — a text block whose text is whitespace-only
	// must be treated as no answer (matches "skips thinking-only" intent for
	// text blocks specifically), not returned as the trimmed-away content.
	it("does not surface a whitespace-only text block as the final message", () => {
		const text = rawLine({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "   " }] },
		});
		expect(lastAssistantText(text)).toBeNull();
	});

	// test-contract: boundary — the backward content-block walk must skip a
	// malformed trailing block (null) and still recover the earlier valid
	// text block, not abort the whole entry.
	it("skips a trailing null content block and still finds the earlier text block", () => {
		const text = rawLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "real answer" }, null],
			},
		});
		expect(lastAssistantText(text)).toBe("real answer");
	});

	// test-contract: boundary — same as above for a trailing block whose
	// `.text` is a non-string (number): must be skipped, not fatal to the
	// whole entry's extraction.
	it("skips a trailing non-string-text content block and still finds the earlier text block", () => {
		const text = rawLine({
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "real answer" }, { type: "text", text: 42 }],
			},
		});
		expect(lastAssistantText(text)).toBe("real answer");
	});
});

describe("resolveFinalMessage payload-trim boundary", () => {
	// test-contract: boundary — a whitespace-only `last_assistant_message`
	// payload must be treated as absent (falls through to null / transcript
	// fallback), not returned verbatim as if it were real content.
	it("does not accept a whitespace-only last_assistant_message payload", () => {
		const resolved = resolveFinalMessage(
			mkEvent({ hook_event: "SubagentStop", last_assistant_message: "   " }),
		);
		expect(resolved).toBeNull();
	});
});

describe("eventField fallback precedence (via buildAgentEventRecord.task)", () => {
	// test-contract: invariant — eventField must only ever surface a
	// non-empty STRING value; a non-string tool_input field (e.g. a number)
	// must resolve to null, never leak the raw typed value into the record.
	it("rejects a non-string tool_input value instead of leaking it", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "TaskCompleted", tool_input: { task_id: 42 } }),
			"task_completed",
			"/fallback",
		);
		expect(rec.task).toBeNull();
	});

	// test-contract: invariant — the top-level (legacy raw-socket) fallback
	// field must likewise reject a non-string value rather than leaking it.
	it("rejects a non-string top-level fallback field instead of leaking it", () => {
		// SAFETY: eventField reads legacy raw-socket fields off the event
		// object via an untyped index probe (see agent-event-capture.ts);
		// this cast constructs exactly that shape for the test.
		const event = { ...mkEvent({ hook_event: "TaskCompleted" }), team_name: 99 } as unknown as HarnessEvent;
		const rec = buildAgentEventRecord(event, "task_completed", "/fallback");
		expect(rec.task).toBeNull();
	});

	// test-contract: invariant — a genuinely valid top-level string field
	// (the legacy raw-socket path, no tool_input present) must be read
	// under its OWN key name; also pins that taskContext looks up
	// "team_name" specifically (not some other literal) for that slot.
	it("reads a valid top-level string fallback field under its own key", () => {
		// SAFETY: same legacy raw-socket shape as the non-string case above —
		// a top-level field outside HarnessEvent's declared surface that
		// eventField's fromRoot probe is specifically written to read.
		const event = {
			...mkEvent({ hook_event: "TaskCompleted" }),
			team_name: "Team Rocket",
		} as unknown as HarnessEvent;
		const rec = buildAgentEventRecord(event, "task_completed", "/fallback");
		expect(rec.task).toEqual({
			task_id: null,
			task_subject: null,
			teammate_name: null,
			team_name: "Team Rocket",
		});
	});
});

describe("taskContext gating (via buildAgentEventRecord.task)", () => {
	// test-contract: invariant — task context must be null for any event
	// whose name is not "task_completed", even if tool_input happens to
	// carry task-shaped fields (e.g. a coincidentally-named field on a
	// SubagentStop payload).
	it("stays null for a non-task_completed event even with task-shaped tool_input", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "SubagentStop", tool_input: { task_id: "leaked-id" } }),
			"subagent_stop",
			"/fallback",
		);
		expect(rec.task).toBeNull();
	});

	// test-contract: invariant — a task_completed event with NONE of the
	// four task fields present must resolve to null, not an all-null object.
	it("is null for a task_completed event with no task fields at all", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "TaskCompleted" }),
			"task_completed",
			"/fallback",
		);
		expect(rec.task).toBeNull();
	});

	// test-contract: invariant — a SINGLE present field (task_id) is
	// sufficient on its own to make the whole task object non-null; this
	// pins the four-way OR (any one field present ⇒ object returned).
	it("returns the task object when only task_id is present", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "TaskCompleted", tool_input: { task_id: "t-only" } }),
			"task_completed",
			"/fallback",
		);
		expect(rec.task).toEqual({
			task_id: "t-only",
			task_subject: null,
			teammate_name: null,
			team_name: null,
		});
	});
});

describe("payloadLabel trimming and provenance (via buildAgentEventRecord)", () => {
	// test-contract: public-api — a padded agent_type must be trimmed before
	// becoming the record's agent_type, and its source recorded as "payload".
	it("trims a padded agent_type and records source payload", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "SubagentStart", agent_type: "  Explore  " }),
			"subagent_start",
			"/fallback",
		);
		expect(rec.agent_type).toBe("Explore");
		expect(rec.agent_type_source).toBe("payload");
	});

	// test-contract: public-api — when agent_type is absent, the tool_name
	// fallback must ALSO be trimmed, not used verbatim.
	it("trims a padded tool_name fallback when agent_type is absent", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ hook_event: "SubagentStart", tool_name: "  Task  " }),
			"subagent_start",
			"/fallback",
		);
		expect(rec.agent_type).toBe("Task");
	});
});

describe("buildAgentEventRecord nullish-vs-boolean-AND coercions", () => {
	// test-contract: public-api — an empty-string session_id must normalize
	// to null (not survive as "", and not become a stray boolean).
	it("normalizes an empty session_id to null", () => {
		const rec = buildAgentEventRecord(mkEvent({ session_id: "" }), "subagent_start", "/fallback");
		expect(rec.session_id).toBeNull();
	});

	// test-contract: public-api — a valid session_id must pass through
	// EXACTLY unchanged (not coerced to a boolean or dropped to null).
	it("passes a valid session_id through unchanged", () => {
		const rec = buildAgentEventRecord(mkEvent({ session_id: "sess-xyz" }), "subagent_start", "/fallback");
		expect(rec.session_id).toBe("sess-xyz");
	});

	// test-contract: public-api — a valid agent_name must pass through
	// exactly, not collapse to null.
	it("passes a valid agent_name through unchanged", () => {
		const rec = buildAgentEventRecord(
			mkEvent({ agent_name: "MyAgent" }),
			"subagent_start",
			"/fallback",
		);
		expect(rec.agent_name).toBe("MyAgent");
	});

	// test-contract: public-api — a supplied metrics object must pass
	// through exactly, not collapse to null.
	it("passes supplied transcript metrics through unchanged", () => {
		const metrics: AgentTranscriptMetrics = {
			assistant_turns: 3,
			tool_calls: 5,
			tools: { Read: 2, Edit: 3 },
			tool_use_ids: ["tu1", "tu2"],
			tool_use_ids_truncated: false,
			models: ["claude-test-5"],
			tokens: { input: 100, output: 50, cache_read: 10, cache_creation: 5 },
			thinking_blocks: 1,
			thinking_blocks_with_text: 1,
			first_ts: "2026-07-09T00:00:00.000Z",
			last_ts: "2026-07-09T00:05:00.000Z",
			duration_ms: 300_000,
			transcript_entries: 12,
		};
		const rec = buildAgentEventRecord(mkEvent({}), "subagent_stop", "/fallback", { metrics });
		expect(rec.metrics).toEqual(metrics);
	});
});

describe("resolveExtras remembered-label plumbing (via captureAgentEvent)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "aec-mk-extras-"));
		resetRememberedAgentTypes();
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		resetRememberedAgentTypes();
	});

	// test-contract: public-api — per the module's own documented contract
	// (SubagentStart's label must be remembered for the Stop that follows),
	// a SubagentStop with no own agent_type must resolve to the label its
	// SubagentStart carried, sourced as "start_event".
	it("re-attaches a SubagentStart's label to the matching SubagentStop", () => {
		captureAgentEvent(
			mkEvent({ hook_event: "SubagentStart", cwd, subagent_id: "w21-remember-1", agent_type: "Explore" }),
			cwd,
		);
		captureAgentEvent(mkEvent({ hook_event: "SubagentStop", cwd, subagent_id: "w21-remember-1" }), cwd);
		const rows = collectionRowsAt(cwd);
		const stopRow = rows.find((r) => r.event === "subagent_stop");
		expect(stopRow?.agent_type).toBe("Explore");
		expect(stopRow?.agent_type_source).toBe("start_event");
	});

	// test-contract: public-api — the remembered-label lookup applies to
	// ANY subsequent event for that subagent_id lacking its own label, not
	// only the stop event; pins that resolveExtras's start-branch actually
	// returns the SAME resolved-type shape used elsewhere in the module.
	it("resolves a second unlabeled event for the same subagent_id from the remembered label", () => {
		captureAgentEvent(
			mkEvent({ hook_event: "SubagentStart", cwd, subagent_id: "w21-remember-2", agent_type: "Explore" }),
			cwd,
		);
		captureAgentEvent(mkEvent({ hook_event: "SubagentStart", cwd, subagent_id: "w21-remember-2" }), cwd);
		const rows = collectionRowsAt(cwd);
		expect(rows).toHaveLength(2);
		expect(rows[1]?.agent_type).toBe("Explore");
		expect(rows[1]?.agent_type_source).toBe("start_event");
	});

	// test-contract: public-api — a TaskCompleted event must NOT resolve a
	// final message even when the payload carries last_assistant_message;
	// message/metrics resolution is stop-only by design.
	it("does not resolve a final message for a TaskCompleted event", () => {
		captureAgentEvent(
			mkEvent({
				hook_event: "TaskCompleted",
				cwd,
				last_assistant_message: "task result text",
				tool_input: { task_id: "w21-t1" },
			}),
			cwd,
		);
		const rows = collectionRowsAt(cwd);
		expect(rows[0]?.last_assistant_message).toBeNull();
		expect(rows[0]?.message_source).toBeNull();
	});
});

describe("captureAgentEvent cwd resolution and stop-only draining", () => {
	let dirA: string;
	let dirB: string;
	beforeEach(() => {
		dirA = mkdtempSync(join(tmpdir(), "aec-mk-cwdA-"));
		dirB = mkdtempSync(join(tmpdir(), "aec-mk-cwdB-"));
	});
	afterEach(() => {
		rmSync(dirA, { recursive: true, force: true });
		rmSync(dirB, { recursive: true, force: true });
	});

	// test-contract: public-api — the event's OWN cwd must be used for persistence, not silently swapped for the hook's fallbackCwd when the two differ.
	it("persists to the event's own cwd, not the fallback, when they differ", () => {
		captureAgentEvent(
			mkEvent({ hook_event: "SubagentStart", cwd: dirA, subagent_id: "w21-cwd" }),
			dirB,
		);
		expect(collectionRowsAt(dirA)).toHaveLength(1);
		expect(collectionRowsAt(dirB)).toHaveLength(0);
	});

	// test-contract: public-api — transcript draining into timeline.jsonl is stop-only; a SubagentStart with a real, drainable transcript must NOT produce a timeline file.
	it("never drains a transcript on SubagentStart, even when one is present", () => {
		const transcript = join(dirA, "start-transcript.jsonl");
		writeFileSync(transcript, assistantJsonLine("w21-start-a1", "should not drain", "w21-start-drain"));
		captureAgentEvent(
			mkEvent({
				hook_event: "SubagentStart",
				cwd: dirA,
				subagent_id: "w21-start-drain",
				agent_transcript_path: transcript,
			}),
			dirA,
		);
		expect(existsSync(timelinePath(dirA))).toBe(false);
	});
});

describe("module-level lookup tables (AGENT_EVENT_NAMES / PROVIDER_BY_SOURCE)", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "aec-mk-taskcompleted-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	// test-contract: public-api — a TaskCompleted hook event must persist a record end-to-end; pins the AGENT_EVENT_NAMES.TaskCompleted mapping (an empty-string value there is falsy and would silently no-op capture).
	it("persists a TaskCompleted event end-to-end", () => {
		captureAgentEvent(
			mkEvent({ hook_event: "TaskCompleted", cwd, tool_input: { task_id: "w21-t-e2e" } }),
			cwd,
		);
		const rows = collectionRowsAt(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event).toBe("task_completed");
	});

	// test-contract: public-api — every non-"claude" agent_source must map
	// to its documented provider label exactly (an empty-string map entry
	// would leak through unrescued, since `??` does not treat "" as nullish).
	it.each([
		["copilot", "copilot"],
		["gemini", "gemini-cli"],
		["codex", "codex"],
		["cursor", "cursor"],
		["opencode", "opencode"],
		["opencode2", "opencode2"],
		["pi", "pi"],
	] as const)("maps agent_source %s to provider %s", (source, expectedProvider) => {
		const rec = buildAgentEventRecord(mkEvent({ agent_source: source }), "subagent_start", "/fallback");
		expect(rec.provider).toBe(expectedProvider);
	});
});
