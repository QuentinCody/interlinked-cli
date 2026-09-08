import { readJsonRecord } from "./__tests__/json.js";
import type { JsonObject } from "../../lib/json-types.js";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCollectionPath } from "../../lib/collection/writer.js";
import { timelinePath } from "../timeline-writer.js";
import type { HarnessEvent } from "../types/events.js";
import {
	AGENT_TRANSCRIPT_REDRAIN_MS,
	buildAgentEventRecord,
	captureAgentEvent,
	FINAL_MESSAGE_MAX_CHARS,
	lastAssistantText,
	resolveFinalMessage,
	scrubFinalMessage,
} from "./agent-event-capture.js";

function assistantLine(opts: {
	uuid: string;
	text?: string;
	thinking?: string;
	agentId?: string;
}): string {
	const content: unknown[] = [];
	if (opts.thinking) content.push({ type: "thinking", thinking: opts.thinking });
	if (opts.text) content.push({ type: "text", text: opts.text });
	return `${JSON.stringify({
		type: "assistant",
		uuid: opts.uuid,
		timestamp: "2026-07-09T00:00:00.000Z",
		sessionId: "parent-session",
		...(opts.agentId ? { agentId: opts.agentId } : {}),
		message: { role: "assistant", model: "claude-test-5", content },
	})}\n`;
}

function userLine(uuid: string, text: string): string {
	return `${JSON.stringify({
		type: "user",
		uuid,
		timestamp: "2026-07-09T00:00:00.000Z",
		sessionId: "parent-session",
		message: { role: "user", content: text },
	})}\n`;
}

function stopEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SubagentStop",
		session_id: "parent-session",
		agent_source: "claude",
		timestamp: "2026-07-09T00:00:01.000Z",
		...overrides,
	};
}

function collectionRows(cwd: string): JsonObject[] {
	const path = getCollectionPath(cwd);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => readJsonRecord(l));
}

describe("lastAssistantText", () => {
	it("returns the LAST assistant entry's last text block", () => {
		const text =
			assistantLine({ uuid: "a1", text: "first answer" }) +
			userLine("u1", "follow-up") +
			assistantLine({ uuid: "a2", thinking: "hmm", text: "final answer" });
		expect(lastAssistantText(text)).toBe("final answer");
	});

	it("skips trailing non-assistant and truncated lines", () => {
		const text =
			assistantLine({ uuid: "a1", text: "the result" }) +
			`${JSON.stringify({ type: "queue-operation", content: "notify" })}\n` +
			'{"type":"assistant","message":{"content":[{"type":"te';
		expect(lastAssistantText(text)).toBe("the result");
	});

	it("skips assistant entries with only thinking blocks", () => {
		const text =
			assistantLine({ uuid: "a1", text: "spoken text" }) +
			assistantLine({ uuid: "a2", thinking: "silent reasoning" });
		expect(lastAssistantText(text)).toBe("spoken text");
	});

	it("returns null when no assistant text exists", () => {
		expect(lastAssistantText("")).toBeNull();
		expect(lastAssistantText(userLine("u1", "just a prompt"))).toBeNull();
	});

	describe("malformed lines (must not crash)", () => {
		it("P1: a trailing non-object JSON line (array) is skipped, still finds the earlier entry", () => {
			const text = assistantLine({ uuid: "a1", text: "first answer" }) + "[1,2,3]\n";
			expect(lastAssistantText(text)).toBe("first answer");
		});

		it("N1: null/number/array lines interleaved before a valid entry never throw", () => {
			const text =
				assistantLine({ uuid: "a1", text: "first answer" }) +
				"[1,2,3]\n" +
				"42\n" +
				"null\n" +
				assistantLine({ uuid: "a2", text: "second answer" });
			expect(lastAssistantText(text)).toBe("second answer");
		});
	});
});

describe("scrubFinalMessage", () => {
	it("passes ordinary text through unchanged", () => {
		expect(scrubFinalMessage("There are 3 R's in Strawberry.")).toBe(
			"There are 3 R's in Strawberry.",
		);
	});

	it("caps runaway messages at FINAL_MESSAGE_MAX_CHARS", () => {
		const huge = "x".repeat(FINAL_MESSAGE_MAX_CHARS + 500);
		expect(scrubFinalMessage(huge)).toHaveLength(FINAL_MESSAGE_MAX_CHARS);
	});
});

describe("resolveFinalMessage", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aec-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("prefers the hook payload when present", () => {
		const transcript = join(dir, "agent-x.jsonl");
		writeFileSync(transcript, assistantLine({ uuid: "a1", text: "from transcript" }));
		const resolved = resolveFinalMessage(
			stopEvent({ last_assistant_message: "from payload", agent_transcript_path: transcript }),
		);
		expect(resolved).toEqual({ text: "from payload", source: "payload" });
	});

	it("falls back to a transcript tail-read when the payload omits it", () => {
		const transcript = join(dir, "agent-y.jsonl");
		writeFileSync(
			transcript,
			userLine("u1", "do the work") + assistantLine({ uuid: "a1", text: "work is done" }),
		);
		const resolved = resolveFinalMessage(stopEvent({ agent_transcript_path: transcript }));
		expect(resolved).toEqual({ text: "work is done", source: "transcript" });
	});

	it("returns null when neither payload nor transcript has a message", () => {
		expect(resolveFinalMessage(stopEvent())).toBeNull();
		expect(
			resolveFinalMessage(stopEvent({ agent_transcript_path: join(dir, "missing.jsonl") })),
		).toBeNull();
	});
});

describe("buildAgentEventRecord", () => {
	it.each(["custom-client", "cli", "toString", "__proto__"])("preserves unknown source %s", (agentSource) => {
		const record = buildAgentEventRecord(stopEvent({ agent_source: agentSource }), "subagent_stop", "/repo");
		expect(record.provider).toBe(agentSource);
	});
	it.each(["opencode", "pi"] as const)("preserves the %s provider identity", (agentSource) => {
		const rec = buildAgentEventRecord(
			stopEvent({ agent_source: agentSource }),
			"subagent_stop",
			"/fallback",
		);
		expect(rec.provider).toBe(agentSource);
	});

	it("maps a SubagentStop with full context", () => {
		const rec = buildAgentEventRecord(
			stopEvent({
				subagent_id: "af2124f",
				agent_type: "Explore",
				parent_agent: "Lead",
				agent_transcript_path: "/tmp/agent-af2124f.jsonl",
				cwd: "/repo",
			}),
			"subagent_stop",
			"/fallback",
			{ resolved: { text: "the answer", source: "payload" } },
		);
		expect(rec).toMatchObject({
			schema: "collection.v1",
			kind: "agent_event",
			event: "subagent_stop",
			provider: "claude-code",
			subagent_id: "af2124f",
			agent_type: "Explore",
			parent_agent: "Lead",
			agent_transcript_path: "/tmp/agent-af2124f.jsonl",
			last_assistant_message: "the answer",
			message_source: "payload",
			task: null,
			cwd: "/repo",
		});
	});

	it("falls back to tool_input.agent_id / tool_name and the fallback cwd", () => {
		const rec = buildAgentEventRecord(
			stopEvent({ tool_name: "Explore", tool_input: { agent_id: "sid-9" } }),
			"subagent_stop",
			"/fallback",
		);
		expect(rec.subagent_id).toBe("sid-9");
		expect(rec.agent_type).toBe("Explore");
		expect(rec.cwd).toBe("/fallback");
		expect(rec.last_assistant_message).toBeNull();
		expect(rec.message_source).toBeNull();
	});

	it("carries TaskCompleted task context", () => {
		const rec = buildAgentEventRecord(
			stopEvent({
				hook_event: "TaskCompleted",
				tool_input: { task_id: "t1", task_subject: "ship it", teammate_name: "worker-2" },
			}),
			"task_completed",
			"/fallback",
		);
		expect(rec.task).toEqual({
			task_id: "t1",
			task_subject: "ship it",
			teammate_name: "worker-2",
			team_name: null,
		});
	});
});

describe("captureAgentEvent (end-to-end into collection + timeline)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "aec-e2e-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("persists a SubagentStop record and drains the agent transcript", () => {
		const transcript = join(cwd, "agent-z1.jsonl");
		writeFileSync(
			transcript,
			userLine("e2e-u1", "count the r's") +
				assistantLine({ uuid: "e2e-a1", text: "There are 3 R's.", agentId: "z1" }),
		);
		captureAgentEvent(
			stopEvent({ cwd, subagent_id: "z1", agent_transcript_path: transcript }),
			cwd,
		);

		const rows = collectionRows(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "agent_event",
			event: "subagent_stop",
			subagent_id: "z1",
			last_assistant_message: "There are 3 R's.",
			message_source: "transcript",
		});

		const timeline = readFileSync(timelinePath(cwd), "utf-8").trim().split("\n");
		const assistant = timeline
			.map((l) => readJsonRecord(l))
			.find((r) => r.text === "There are 3 R's.");
		expect(assistant?.agent_id).toBe("z1");
	});

	it("persists SubagentStart without draining a timeline", () => {
		captureAgentEvent(stopEvent({ hook_event: "SubagentStart", cwd, subagent_id: "z2" }), cwd);
		const rows = collectionRows(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.event).toBe("subagent_start");
		expect(existsSync(timelinePath(cwd))).toBe(false);
	});

	it("ignores non-agent hook events", () => {
		captureAgentEvent(stopEvent({ hook_event: "PreToolUse", cwd }), cwd);
		captureAgentEvent(stopEvent({ hook_event: "Stop", cwd }), cwd);
		expect(collectionRows(cwd)).toHaveLength(0);
	});

	it("re-drains the transcript after the runner's late flush (SubagentStop write race)", () => {
		vi.useFakeTimers();
		try {
			const transcript = join(cwd, "agent-late.jsonl");
			writeFileSync(transcript, userLine("late-u1", "do the work"));
			captureAgentEvent(
				stopEvent({ cwd, subagent_id: "late", agent_transcript_path: transcript }),
				cwd,
			);
			// The runner flushes the final assistant entry AFTER SubagentStop fires
			// (observed 29ms in the live probe) — the immediate drain misses it.
			appendFileSync(
				transcript,
				assistantLine({ uuid: "late-a1", text: "late final answer", agentId: "late" }),
			);
			expect(readFileSync(timelinePath(cwd), "utf-8")).not.toContain("late final answer");
			vi.advanceTimersByTime(AGENT_TRANSCRIPT_REDRAIN_MS + 50);
			expect(readFileSync(timelinePath(cwd), "utf-8")).toContain("late final answer");
		} finally {
			vi.useRealTimers();
		}
	});

	it("survives a missing transcript (record persists with null message)", () => {
		captureAgentEvent(
			stopEvent({ cwd, agent_transcript_path: join(cwd, "gone.jsonl") }),
			cwd,
		);
		const rows = collectionRows(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.last_assistant_message).toBeNull();
	});

	it("survives a transcript path that exists but cannot be read as a file", () => {
		// A directory passes the existsSync/size guards and then fails the read
		// (EISDIR). The tail-read must degrade to "no message" rather than throw
		// — a thrown read would abort capture before the record is appended.
		const transcript = join(cwd, "agent-dir.jsonl");
		mkdirSync(transcript);
		captureAgentEvent(
			stopEvent({ cwd, subagent_id: "unreadable", agent_transcript_path: transcript }),
			cwd,
		);
		expect(collectionRows(cwd)[0]).toMatchObject({
			event: "subagent_stop",
			subagent_id: "unreadable",
			last_assistant_message: null,
			message_source: null,
		});
	});

	it("keeps the persisted record when the caller's log callback throws", () => {
		// The log sink is the last step, after the record and the timeline drain
		// have landed. A failing sink is exactly the "never break the pipeline"
		// case the outer catch exists for: the throw is swallowed and everything
		// already written stays written.
		const seen: string[] = [];
		const log = (msg: string): void => {
			seen.push(msg);
			throw new Error("log sink is down");
		};
		captureAgentEvent(stopEvent({ cwd, subagent_id: "noisy" }), cwd, log);

		expect(seen).toEqual([expect.stringContaining("Agent event captured: subagent_stop (noisy,")]);
		expect(collectionRows(cwd)[0]).toMatchObject({
			event: "subagent_stop",
			subagent_id: "noisy",
		});
	});
});
