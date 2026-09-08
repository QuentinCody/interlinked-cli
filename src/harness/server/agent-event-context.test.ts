import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	MAX_REMEMBERED_AGENT_TYPES,
	readAgentMetrics,
	rememberAgentType,
	resetRememberedAgentTypes,
	resolveAgentType,
} from "./agent-event-context.js";

function event(over: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "SubagentStop",
		session_id: "s1",
		agent_source: "claude",
		tool_input: {},
		timestamp: "2026-08-07T22:00:00.000Z",
		...over,
	};
}

describe("resolveAgentType — positive (must resolve)", () => {
	beforeEach(() => {
		resetRememberedAgentTypes();
	});

	it("P1: prefers the payload label and marks it as such", () => {
		expect(resolveAgentType(event({ agent_type: "general-purpose" }))).toEqual({
			type: "general-purpose",
			source: "payload",
		});
	});

	it("P2: reuses the label remembered from this agent's SubagentStart", () => {
		rememberAgentType("a1", "workflow-subagent");
		expect(resolveAgentType(event({ subagent_id: "a1" }))).toEqual({
			type: "workflow-subagent",
			source: "start_event",
		});
	});

	it("P3: falls back to tool_name when no agent_type is delivered", () => {
		expect(resolveAgentType(event({ tool_name: "Explore" }))).toEqual({
			type: "Explore",
			source: "payload",
		});
	});

	it("P4: evicts the oldest labels past the bound but keeps the newest", () => {
		for (let i = 0; i < MAX_REMEMBERED_AGENT_TYPES + 10; i++) rememberAgentType(`a${i}`, `type${i}`);
		expect(resolveAgentType(event({ subagent_id: "a0" })).type).toBeNull();
		const newest = `a${MAX_REMEMBERED_AGENT_TYPES + 9}`;
		expect(resolveAgentType(event({ subagent_id: newest })).source).toBe("start_event");
	});
});

describe("resolveAgentType — negative (must not invent a label)", () => {
	beforeEach(() => {
		resetRememberedAgentTypes();
	});

	it("N1: an empty-string agent_type is not a label", () => {
		expect(resolveAgentType(event({ agent_type: "" }))).toEqual({ type: null, source: null });
	});

	it("N2: a whitespace-only agent_type is not a label", () => {
		expect(resolveAgentType(event({ agent_type: "   " }))).toEqual({ type: null, source: null });
	});

	it("N3: another agent's remembered label is not borrowed", () => {
		rememberAgentType("a1", "general-purpose");
		expect(resolveAgentType(event({ subagent_id: "a2" }))).toEqual({ type: null, source: null });
	});

	it("N4: remembering with a missing id or label is a no-op", () => {
		rememberAgentType(null, "general-purpose");
		rememberAgentType("a3", null);
		expect(resolveAgentType(event({ subagent_id: "a3" })).type).toBeNull();
	});
});

describe("readAgentMetrics", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-metrics-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P5: summarizes a real transcript file", () => {
		const path = join(dir, "agent-a1.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "assistant",
				timestamp: "2026-08-07T22:00:00.000Z",
				uuid: "u1",
				message: {
					role: "assistant",
					model: "vendor-model-v5",
					usage: { output_tokens: 42, cache_read_input_tokens: 900 },
					content: [{ type: "tool_use", name: "Bash", id: "toolu_1", input: {} }],
				},
			})}\n`,
		);
		const m = readAgentMetrics(path);
		expect(m?.tokens.output).toBe(42);
		expect(m?.tokens.cache_read).toBe(900);
		expect(m?.tool_use_ids).toEqual(["toolu_1"]);
		expect(m?.models).toEqual(["vendor-model-v5"]);
	});

	it("N5: a missing path yields null, not zeroed metrics", () => {
		expect(readAgentMetrics(join(dir, "nope.jsonl"))).toBeNull();
	});

	it("N6: an undefined path yields null", () => {
		expect(readAgentMetrics(undefined)).toBeNull();
	});

	it("N7: an existing path that cannot be read yields null instead of throwing", () => {
		// A directory clears both guards — it exists and its size is far under
		// the cap — so only the read fails. Without the degrade-to-null arm the
		// EISDIR error would escape and take the whole stop-event handler down.
		expect(readAgentMetrics(dir)).toBeNull();
	});
});
