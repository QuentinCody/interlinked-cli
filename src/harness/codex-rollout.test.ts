import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildExperience } from "../commands/experience/build.js";
import { parseCodexRolloutText } from "./codex-rollout.js";
import { isTurnStart } from "./transcript-record.js";

// A synthetic Codex rollout covering every entry family we map.
const rollout = [
	{ timestamp: "2026-07-18T18:40:04.725Z", type: "session_meta", payload: { session_id: "sess-1", cwd: "/repo", model_provider: "openai" } },
	{ timestamp: "2026-07-18T18:40:05.000Z", type: "response_item", payload: { type: "turn_context", model: "oai-model-v6" } },
	{ timestamp: "2026-07-18T18:40:06.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Review these files." }] } },
	{ timestamp: "2026-07-18T18:40:07.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
	{ timestamp: "2026-07-18T18:40:16.000Z", type: "event_msg", payload: { type: "agent_message", message: "I'll inspect the substrate files.", phase: "commentary" } },
	{ timestamp: "2026-07-18T18:40:17.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "rg --files src", call_id: "call_1", id: "ctc_1" } },
	{ timestamp: "2026-07-18T18:40:18.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "src/a.ts\nsrc/b.ts" }] } },
	{ timestamp: "2026-07-18T18:42:14.000Z", type: "response_item", payload: { type: "function_call", name: "wait", arguments: '{"cell_id":"5"}', call_id: "call_2" } },
	{ timestamp: "2026-07-18T18:42:23.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "Script completed" }] } },
	{ timestamp: "2026-07-18T19:22:27.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "1. [severity: high] a bug." }] } },
]
	.map((e) => JSON.stringify(e))
	.join("\n");

describe("parseCodexRolloutText", () => {
	const recs = parseCodexRolloutText(rollout);
	const byCat = (c: string) => recs.filter((r) => r.category === c);

	it("stamps every record with provider codex and the session id", () => {
		expect(recs.length).toBeGreaterThan(0);
		expect(recs.every((r) => r.provider === "codex")).toBe(true);
		expect(recs.every((r) => r.session === "sess-1")).toBe(true);
		expect(recs.every((r) => r.schema === "timeline.v1")).toBe(true);
	});

	it("reads current Codex subagent session metadata into timeline attribution", () => {
		const current = [
			{
				timestamp: "2026-08-20T15:48:40Z",
				type: "session_meta",
				payload: {
					id: "sub-thread",
					cwd: "/repo",
					source: {
						subagent: {
							thread_spawn: {
								parent_thread_id: "parent-thread",
								agent_path: "/root/kill_a_survivors",
								agent_nickname: "Curie",
							},
						},
					},
				},
			},
			{
				timestamp: "2026-08-20T15:48:41Z",
				type: "turn_context",
				payload: { model: "vendor-model-luna" },
			},
			{
				timestamp: "2026-08-20T15:48:42Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Done." }],
				},
			},
		].map((entry) => JSON.stringify(entry)).join("\n");
		const records = parseCodexRolloutText(current);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			session: "sub-thread",
			agent_id: "sub-thread",
			attribution_agent: "/root/kill_a_survivors",
			is_sidechain: true,
			model: "vendor-model-luna",
		});
	});

	it("maps developer/user messages to user_prompt and assistant to agent_message", () => {
		expect(byCat("user_prompt").map((r) => r.text)).toEqual(["Review these files."]);
		expect(byCat("agent_message")[0]?.text).toContain("a bug");
		expect(byCat("agent_message")[0]?.role).toBe("assistant");
		// A non-assistant message is stamped "user", not left blank.
		expect(byCat("user_prompt")[0]?.role).toBe("user");
		// Both branches mark the record scrubbed (the pipeline trusts this flag
		// to know the text already went through PII/secret redaction).
		expect(byCat("user_prompt")[0]?.scrubbed).toBe(true);
		expect(byCat("agent_message")[0]?.scrubbed).toBe(true);
	});

	it("captures streamed commentary as agent_thinking", () => {
		expect(byCat("agent_thinking").map((r) => r.text)).toEqual(["I'll inspect the substrate files."]);
		expect(byCat("agent_thinking")[0]?.role).toBe("assistant");
		expect(byCat("agent_thinking")[0]?.scrubbed).toBe(true);
	});

	it("maps function_call and custom_tool_call to tool_use with raw input", () => {
		const tools = byCat("tool_use");
		expect(tools.map((r) => r.tool_name).sort()).toEqual(["exec", "wait"]);
		expect(tools.find((r) => r.tool_name === "exec")?.tool_input).toBe("rg --files src");
		expect(tools.find((r) => r.tool_name === "wait")?.tool_input).toBe('{"cell_id":"5"}');
		expect(tools.find((r) => r.tool_name === "exec")?.tool_use_id).toBe("call_1");
		expect(tools.every((r) => r.role === "assistant")).toBe(true);
	});

	it("maps *_output to tool_result with raw flattened content", () => {
		const results = byCat("tool_result");
		expect(results.find((r) => r.tool_use_id === "call_1")?.text).toBe("src/a.ts\nsrc/b.ts");
		expect(results.find((r) => r.tool_use_id === "call_2")?.text).toBe("Script completed");
		expect(results.every((r) => r.role === "user")).toBe(true);
	});

	it("labels model-bearing records with the discovered model slug", () => {
		expect(byCat("agent_message")[0]?.model).toBe("oai-model-v6");
		expect(byCat("tool_use")[0]?.model).toBe("oai-model-v6");
		// user prompts are input TO the model — no model label (parity with Claude).
		expect(byCat("user_prompt")[0]?.model).toBeUndefined();
	});

	it("uses a stable codex:<session>:<line> dedup key so re-parses match", () => {
		const again = parseCodexRolloutText(rollout);
		expect(again.map((r) => `${r.uuid}#${r.seq}`)).toEqual(recs.map((r) => `${r.uuid}#${r.seq}`));
		expect(recs.every((r) => r.uuid.startsWith("codex:sess-1:"))).toBe(true);
	});

	it("skips lifecycle events and returns [] without a session_meta", () => {
		expect(byCat("event")).toEqual([]); // task_started produced nothing
		expect(parseCodexRolloutText('{"type":"event_msg","payload":{"type":"task_started"}}')).toEqual([]);
		expect(parseCodexRolloutText("not json\n\n")).toEqual([]);
	});

	it("scrubs natural-language text but leaves tool I/O raw", () => {
		// A fabricated secret in a prompt is scrubbed; the same shape in tool
		// input/result is preserved (RAW parity with the Claude parser).
		const sk = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD";
		const doc = [
			JSON.stringify({ timestamp: "2026-07-18T18:40:04Z", type: "session_meta", payload: { session_id: "s2", cwd: "/r" } }),
			JSON.stringify({ timestamp: "2026-07-18T18:40:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `key ${sk} here` }] } }),
			JSON.stringify({ timestamp: "2026-07-18T18:40:06Z", type: "response_item", payload: { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: `key ${sk} here` }] } }),
		].join("\n");
		const r = parseCodexRolloutText(doc);
		expect(r.find((x) => x.category === "user_prompt")?.text).not.toContain(sk);
		expect(r.find((x) => x.category === "tool_result")?.text).toContain(sk);
	});
});

// parseCodexEntry / parseCodexPayload — direct boundary-parser coverage
// (replaces `JSON.parse(line) as CodexEntry`), exercised through
// parseCodexRolloutText, the module's only entry point.
describe("parseCodexEntry / parseCodexPayload boundary parsing", () => {
	const meta = { timestamp: "2026-07-18T00:00:00Z", type: "session_meta", payload: { session_id: "s3", cwd: "/r" } };

	it("P1: a well-formed entry with every string payload field intact round-trips", () => {
		const doc = [
			meta,
			{
				timestamp: "2026-07-18T00:00:01Z",
				type: "response_item",
				payload: { type: "custom_tool_call", name: "exec", call_id: "call_9", id: "ctc_9", arguments: "{}" },
			},
		].map((e) => JSON.stringify(e)).join("\n");
		const tool = parseCodexRolloutText(doc).find((r) => r.category === "tool_use");
		expect(tool?.tool_name).toBe("exec");
		expect(tool?.tool_use_id).toBe("call_9");
	});

	it("N1: a numeric timestamp is dropped (not flowed into TimelineRecord.ts unchecked) — the record is skipped instead of corrupted", () => {
		const doc = [
			meta,
			{ timestamp: 12345, type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
		].map((e) => JSON.stringify(e)).join("\n");
		const recs = parseCodexRolloutText(doc);
		expect(recs.some((r) => r.category === "user_prompt")).toBe(false);
	});

	it("N2: a non-string top-level type is treated as absent, not passed through untyped", () => {
		const doc = [
			meta,
			{ timestamp: "2026-07-18T00:00:01Z", type: 42, payload: { type: "message", role: "user", content: "hi" } },
		].map((e) => JSON.stringify(e)).join("\n");
		// type !== "response_item" (it's absent) -> entryRecords' response_item
		// branch never triggers, so no user_prompt record is produced.
		expect(parseCodexRolloutText(doc).some((r) => r.category === "user_prompt")).toBe(false);
	});

	it("N3: a non-object payload does not crash — the entry is treated as payload-less", () => {
		const doc = [meta, { timestamp: "2026-07-18T00:00:01Z", type: "response_item", payload: "not-an-object" }]
			.map((e) => JSON.stringify(e))
			.join("\n");
		expect(() => parseCodexRolloutText(doc)).not.toThrow();
		expect(parseCodexRolloutText(doc)).toEqual([]);
	});

	it("N4: a line that parses to a bare JSON array or number produces no records and does not crash", () => {
		const doc = [JSON.stringify(meta), "[1,2,3]", "42", "null"].join("\n");
		expect(() => parseCodexRolloutText(doc)).not.toThrow();
		expect(parseCodexRolloutText(doc)).toEqual([]);
	});

	it("N5: a wrongly-typed payload string field (numeric name) is dropped, not forwarded as tool_name", () => {
		const doc = [
			meta,
			{
				timestamp: "2026-07-18T00:00:01Z",
				type: "response_item",
				payload: { type: "custom_tool_call", name: 999, call_id: "call_x" },
			},
		].map((e) => JSON.stringify(e)).join("\n");
		const tool = parseCodexRolloutText(doc).find((r) => r.category === "tool_use");
		expect(tool?.tool_name).toBeUndefined();
		expect(tool?.tool_use_id).toBe("call_x");
	});
});

// ===========================================================================
// Mutation-kill: W6 residue (scratch/fleet-r3/CONTRACT-W6.md). Each case below
// targets a specific surviving mutant from the last measurement wave.
// Receipts (including suspected-equivalent write-ups for mutants no test can
// distinguish from pristine) live in
// scratch/fleet-r3/receipts/src_harness_codex-rollout.ts.jsonl.
// ===========================================================================
describe("mutation-kill: survivor patches (W6)", () => {
	const toDoc = (entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");
	const META = { timestamp: "2026-08-16T00:00:00Z", type: "session_meta", payload: { session_id: "mk-sess", cwd: "/mk" } };

	describe("flattenCodexContent — arbitrary tool-output shapes", () => {
		// test-contract: boundary — a non-string, non-array output (e.g. a bare
		// number) flattens to nothing; it must not be misread as an array (which
		// would crash on .map) or leak a placeholder string.
		it("a non-string, non-array tool output flattens to nothing", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t1", output: 12345 } }]);
			expect(() => parseCodexRolloutText(doc)).not.toThrow();
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t1")?.text).toBeUndefined();
		});

		// test-contract: boundary — a raw string output is the fast path: used
		// verbatim, not misclassified as "not an array" and discarded.
		it("a raw string tool output is used verbatim", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t2", output: "hello raw" } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t2")?.text).toBe("hello raw");
		});

		// test-contract: boundary — a content block with no usable text (no
		// `.text` field) drops out of the join instead of leaving a blank line.
		it("a content block with no usable text contributes nothing to the join", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t3", output: [{}, { type: "input_text", text: "only" }] } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t3")?.text).toBe("only");
		});

		// test-contract: boundary — multiple text blocks join with a newline
		// separator, not back-to-back concatenation.
		it("multiple text blocks are newline-joined, not concatenated", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t4", output: ["first", "second"] } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t4")?.text).toBe("first\nsecond");
		});

		// test-contract: boundary — a bare string content block survives next
		// to object-shaped blocks in the same array.
		it("a bare string content block survives next to object blocks", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t5", output: ["plain-string-item", { type: "input_text", text: "b" }] } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t5")?.text).toBe("plain-string-item\nb");
		});

		// test-contract: boundary — a null content block is skipped through
		// safe optional access rather than a direct `.text` read that throws.
		it("a null content block does not crash the flattener", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t6", output: [null, { type: "input_text", text: "b" }] } }]);
			expect(() => parseCodexRolloutText(doc)).not.toThrow();
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t6")?.text).toBe("b");
		});

		// test-contract: boundary — a block whose `.text` is present but not
		// itself a string (e.g. an array) is dropped, not coerced into the join.
		it("a non-string .text field is dropped, not coerced into the output", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-t7", output: [{ type: "input_text", text: ["nonstring-value"] }, { type: "input_text", text: "keep-me" }] } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-t7")?.text).toBe("keep-me");
		});
	});

	describe("scanContext — session id / cwd / model derivation", () => {
		// test-contract: invariant — with no session_meta anywhere in the
		// rollout, the whole rollout is discarded even when later entries look
		// like valid records (never leak data under a fabricated empty session).
		it("without any session_meta entry, the whole rollout is discarded", () => {
			const doc = toDoc([{ timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: "hi" } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});

		// test-contract: security — a non-session_meta entry cannot spoof the
		// session id or cwd even if its own payload happens to carry those
		// field names; the type gate, not field presence, decides what's trusted.
		it("only session_meta-typed entries can set the session id and cwd", () => {
			const doc = toDoc([
				{ timestamp: "t0", type: "session_meta", payload: { session_id: "real-sess", cwd: "/real" } },
				{ timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: "hi", session_id: "BOGUS", cwd: "/bogus" } },
			]);
			const recs = parseCodexRolloutText(doc);
			expect(recs[0]?.session).toBe("real-sess");
			expect(recs[0]?.cwd).toBe("/real");
		});

		// test-contract: invariant — a later session_meta that omits session_id
		// must not blank out an already-established session id.
		it("a later session_meta missing session_id does not clear an already-known session", () => {
			const doc = toDoc([
				{ timestamp: "t0", type: "session_meta", payload: { session_id: "real-sess", cwd: "/r" } },
				{ timestamp: "t1", type: "session_meta", payload: { cwd: "/r2" } },
				{ timestamp: "t2", type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
			]);
			expect(parseCodexRolloutText(doc)[0]?.session).toBe("real-sess");
		});

		// test-contract: invariant — a later session_meta that omits cwd must
		// not blank out an already-known cwd.
		it("a later session_meta missing cwd does not clear an already-known cwd", () => {
			const doc = toDoc([
				{ timestamp: "t0", type: "session_meta", payload: { session_id: "sess-d", cwd: "/real-cwd" } },
				{ timestamp: "t1", type: "session_meta", payload: { session_id: "sess-d" } },
				{ timestamp: "t2", type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
			]);
			expect(parseCodexRolloutText(doc)[0]?.cwd).toBe("/real-cwd");
		});

		// test-contract: public-api — the positive twin of the two tests above:
		// a genuinely valid string cwd on session_meta DOES propagate to records.
		it("a valid string cwd propagates to records built from the rollout", () => {
			const doc = toDoc([
				{ timestamp: "t0", type: "session_meta", payload: { session_id: "sess-e", cwd: "/propagated" } },
				{ timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: "hi" } },
			]);
			expect(parseCodexRolloutText(doc)[0]?.cwd).toBe("/propagated");
		});

		// test-contract: invariant — the FIRST model slug discovered wins; a
		// later model-bearing entry must never overwrite it once set.
		it("the first model slug seen wins over a later one", () => {
			const doc = toDoc([
				META,
				{ timestamp: "t1", type: "response_item", payload: { type: "turn_context", model: "model-a" } },
				{ timestamp: "t2", type: "response_item", payload: { type: "turn_context", model: "model-b" } },
				{ timestamp: "t3", type: "response_item", payload: { type: "function_call", name: "noop", call_id: "mk-model" } },
			]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-model")?.model).toBe("model-a");
		});
	});

	describe("messageRecords — emptiness handling", () => {
		// test-contract: boundary — content that is entirely whitespace is
		// treated the same as no content: no user_prompt record at all (not a
		// record carrying blank/whitespace text).
		it("whitespace-only content produces no user_prompt record", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "   " }] } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});
	});

	describe("toolUseRecord / toolResultRecord — record shape", () => {
		// test-contract: public-api — a function_call entry always yields
		// exactly one well-formed tool_use record, pinned field-for-field so a
		// body collapsing to nothing is caught as loudly as a scrambled field.
		it("a function_call entry yields exactly one well-formed tool_use record", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call", name: "run", arguments: "{}", call_id: "mk-fc" } }]);
			expect(() => parseCodexRolloutText(doc)).not.toThrow();
			expect(parseCodexRolloutText(doc)).toEqual([
				{
					schema: "timeline.v1", ts: "t1", session: "mk-sess", uuid: "codex:mk-sess:1",
					provider: "codex", cwd: "/mk", seq: 0, category: "tool_use", role: "assistant",
					model: undefined, tool_name: "run", tool_input: "{}", tool_use_id: "mk-fc",
				},
			]);
		});

		// test-contract: public-api — a function_call_output entry always
		// yields exactly one well-formed tool_result record.
		it("a function_call_output entry yields exactly one well-formed tool_result record", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-fco", output: [{ type: "input_text", text: "done" }] } }]);
			expect(() => parseCodexRolloutText(doc)).not.toThrow();
			expect(parseCodexRolloutText(doc)).toEqual([
				{
					schema: "timeline.v1", ts: "t1", session: "mk-sess", uuid: "codex:mk-sess:1",
					provider: "codex", cwd: "/mk", seq: 0, category: "tool_result", role: "user",
					tool_use_id: "mk-fco", text: "done",
				},
			]);
		});

		// test-contract: boundary — a tool result that flattens to an empty
		// string reports text as undefined, not a zero-length string (parity
		// with "no output" rather than a distinguishable empty-output signal).
		it("a tool result flattening to an empty string reports text as undefined", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "function_call_output", call_id: "mk-empty", output: [] } }]);
			expect(parseCodexRolloutText(doc).find((r) => r.tool_use_id === "mk-empty")?.text).toBeUndefined();
		});
	});

	describe("entryRecords — dispatch guards", () => {
		// test-contract: boundary — a response_item whose payload type matches
		// none of message/function_call/*_output (e.g. turn_context alone)
		// produces no record; it must not fall into the tool-result branch.
		it("an unrecognized response_item payload subtype produces no record", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "response_item", payload: { type: "turn_context", model: "m" } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});

		// test-contract: security — agent_thinking content only ever surfaces
		// from a genuine event_msg entry; a different entry type carrying an
		// "agent_message"-shaped payload must not leak through.
		it("agent_thinking never surfaces from a non-event_msg entry", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "unrelated_event", payload: { type: "agent_message", message: "should not surface" } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});

		// test-contract: boundary — within a real event_msg entry, a
		// non-"agent_message" payload subtype still produces nothing.
		it("event_msg entries with a non-agent_message payload type produce nothing", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "event_msg", payload: { type: "not_agent_message", message: "should not surface" } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});

		// test-contract: boundary — a non-string event_msg message is ignored
		// without crashing (no unguarded `.trim()` call on a non-string).
		it("a non-string event_msg message is ignored, not crashed on", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "event_msg", payload: { type: "agent_message", message: 42 } }]);
			expect(() => parseCodexRolloutText(doc)).not.toThrow();
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});

		// test-contract: boundary — a whitespace-only event_msg message is
		// treated as empty, the same as a whitespace-only prompt.
		it("a whitespace-only event_msg message produces no record", () => {
			const doc = toDoc([META, { timestamp: "t1", type: "event_msg", payload: { type: "agent_message", message: "   " } }]);
			expect(parseCodexRolloutText(doc)).toEqual([]);
		});
	});
});

// Codex injects hook output ("[interlinked:...]") as a `developer` message
// between a tool call and its output. Such a message is model input, so it
// stays a user_prompt, but it must not split the turn.
describe("parseCodexRolloutText — developer hook messages inside a turn", () => {
	const hookTurn = [
		{ timestamp: "2026-10-21T10:00:00.000Z", type: "session_meta", payload: { id: "sess-hook", cwd: "/repo" } },
		{ timestamp: "2026-10-21T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the parser." }] } },
		{ timestamp: "2026-10-21T10:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"rg -n role src"}', call_id: "call_h1" } },
		{ timestamp: "2026-10-21T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "[interlinked:checks-deferred] NOT CHECKED: tsc" }] } },
		{ timestamp: "2026-10-21T10:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_h1", output: "src/a.ts:1:role" } },
		{ timestamp: "2026-10-21T10:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
	]
		.map((e) => JSON.stringify(e))
		.join("\n");
	const recs = parseCodexRolloutText(hookTurn);
	const prompts = recs.filter((r) => r.category === "user_prompt");

	it("keeps the developer message a user_prompt with input_role developer", () => {
		expect(prompts.map((r) => [r.text, r.input_role])).toEqual([
			["Fix the parser.", "user"],
			["[interlinked:checks-deferred] NOT CHECKED: tsc", "developer"],
		]);
		// Category, role and the dedup key are unchanged by the new field.
		expect(prompts[1]).toMatchObject({ category: "user_prompt", role: "user", uuid: "codex:sess-hook:3", seq: 0 });
	});

	it("isTurnStart is true for the user message and false for the developer message", () => {
		expect(prompts.map((r) => isTurnStart(r))).toEqual([true, false]);
		expect(recs.filter((r) => isTurnStart(r)).map((r) => r.text)).toEqual(["Fix the parser."]);
	});

	it("isTurnStart reads an unset input_role (Claude rows, historical rows) as a turn start", () => {
		expect(isTurnStart({ category: "user_prompt" })).toBe(true);
		expect(isTurnStart({ category: "user_prompt", input_role: "system" })).toBe(false);
		expect(isTurnStart({ category: "agent_message" })).toBe(false);
	});

	it("an unknown message role keeps input_role unset", () => {
		const doc = [
			{ timestamp: "t0", type: "session_meta", payload: { id: "s" } },
			{ timestamp: "t1", type: "response_item", payload: { type: "message", role: "narrator", content: "hi" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n");
		const [only] = parseCodexRolloutText(doc);
		expect(only?.category).toBe("user_prompt");
		expect(only !== undefined && "input_role" in only).toBe(false);
	});

	it("experience build keeps the tool call and the assistant message in one episode", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-hook-turn-"));
		try {
			mkdirSync(join(dir, ".interlinked"), { recursive: true });
			writeFileSync(join(dir, ".interlinked", "timeline.jsonl"), `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
			const built = buildExperience({ dir, sessionId: "sess-hook", format: "ix" });
			const meta = built.records[0];
			expect(meta !== undefined && "ix_meta" in meta ? meta.ix_meta.episodes : undefined).toBe(1);
			const episodes = built.records.slice(1).map((r) => ("ix" in r ? r.ix?.episode : undefined));
			// user prompt, tool call, developer message, tool result, assistant reply
			expect(episodes).toEqual([0, 0, 0, 0, 0]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
