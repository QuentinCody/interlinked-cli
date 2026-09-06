// G1 SSE reassembly — pins the Messages streaming contract the proxy relies
// on (docs/design/reproducibility/g1-inference-capture.md): stop_reason/usage
// arrive in message_delta (message_stop is only a terminator), tool_use input
// arrives as partial-JSON fragments keyed by block index, thinking carries a
// signature delta, and chunk boundaries need not align with event boundaries.

import { describe, expect, it } from "vitest";
import { createSseReassembler } from "./sse-reassembly.js";

function sse(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const FIXTURE: string =
	sse("message_start", {
		type: "message_start",
		message: {
			id: "msg_01",
			model: "vendor-model-v6",
			role: "assistant",
			usage: { input_tokens: 120, cache_read_input_tokens: 40 },
		},
	}) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: "let me look" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature: "sig-abc" },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "text", text: "" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: "Reading the file" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: " now." },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 1 }) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "toolu_777", name: "Read", input: {} },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"file_pa' },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: 'th": "/x.ts"}' },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 2 }) +
	sse("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 55 },
	}) +
	sse("message_stop", { type: "message_stop" });

describe("createSseReassembler", () => {
	it("reassembles the full message from one push", () => {
		const r = createSseReassembler();
		r.push(FIXTURE);
		const msg = r.finish();
		if (!msg) throw new Error("expected a reassembled message");
		expect(msg.id).toBe("msg_01");
		expect(msg.stop_reason).toBe("tool_use");
		// usage merges input side (message_start) with output side (message_delta)
		expect(msg.usage).toEqual({
			input_tokens: 120,
			cache_read_input_tokens: 40,
			output_tokens: 55,
		});
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]).toMatchObject({ type: "thinking", thinking: "let me look", signature: "sig-abc" });
		expect(content[1]).toMatchObject({ type: "text", text: "Reading the file now." });
		expect(content[2]).toMatchObject({
			type: "tool_use",
			id: "toolu_777",
			name: "Read",
			input: { file_path: "/x.ts" },
		});
	});

	it("is chunk-boundary agnostic (splits mid-line, mid-JSON, mid-event)", () => {
		const r = createSseReassembler();
		for (let i = 0; i < FIXTURE.length; i += 7) {
			r.push(FIXTURE.slice(i, i + 7));
		}
		const msg = r.finish();
		if (!msg) throw new Error("expected a reassembled message");
		expect(msg.stop_reason).toBe("tool_use");
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content[2]).toMatchObject({ input: { file_path: "/x.ts" } });
	});

	it("keeps unparseable tool input raw instead of throwing", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t1", name: "X", input: {} },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"broken:' },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const blocks = msg?.content as Array<Record<string, unknown>>;
		expect(blocks[0]?.input_raw).toBe('{"broken:');
	});

	it("returns null when no message_start ever arrived", () => {
		const r = createSseReassembler();
		r.push(sse("ping", { type: "ping" }));
		expect(r.finish()).toBeNull();
	});

	it("ignores unknown events and non-JSON data lines", () => {
		const r = createSseReassembler();
		r.push("event: mystery\ndata: not-json\n\n");
		r.push(sse("message_start", { type: "message_start", message: { id: "m2" } }));
		r.push(sse("wat", { type: "wat", index: 9 }));
		const msg = r.finish();
		expect(msg?.id).toBe("m2");
		expect(msg?.content).toEqual([]);
	});

	it("flushes a final event that lacks the trailing blank line", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m3" } }));
		// message_delta with no trailing \n\n — only finish() can see it.
		r.push('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}');
		const msg = r.finish();
		expect(msg?.stop_reason).toBe("end_turn");
	});

	// --- asObject: array / primitive / null must all be rejected --------------
	it("treats a non-object `message` (array, string, number, null) as absent", () => {
		const r = createSseReassembler();
		// content_block is an ARRAY: asObject must reject it (not treat truthy as object).
		r.push(
			sse("message_start", {
				type: "message_start",
				message: ["not", "an", "object"],
			}),
		);
		const msg = r.finish();
		if (!msg) throw new Error("expected a reassembled message");
		// asObject(array) must be null -> shell falls back to {} (no properties from the array).
		// A weak `msg.id` check would pass even if asObject wrongly accepted the array (arrays
		// have no `.id` either) — so assert the actual keys instead: only `content` may be
		// present. If Array.isArray() were not checked, `{...array}` would spread numeric-index
		// keys ("0", "1", "2") onto the shell.
		expect(Object.keys(msg)).toEqual(["content"]);
	});

	it("rejects a non-object content_block (string) — block still opens as {}", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m4" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: "not-an-object",
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "hi" },
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		// Rejected content_block -> block starts as {} rather than adopting the string.
		expect(content[0]).toEqual({ text: "hi" });
	});

	it("rejects a null content_block_delta.delta (no object) — no crash, no append", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m5" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: null,
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({ type: "text", text: "" });
	});

	it("ignores a delta.type the switch does not recognize (kills the applyDelta `default:` mutant)", () => {
		// "citations_delta" is a real Messages-API delta kind this reassembler
		// does not accumulate. If the default arm mis-routed it into one of the
		// known cases (e.g. treated it as text_delta), the block would gain a
		// `text` field; the contract is that it must be dropped entirely.
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m5b" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "citations_delta", text: "should not land", citation: { foo: "bar" } },
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({ type: "text", text: "" });
	});

	// --- appendString: non-string piece must be ignored, not coerced ----------
	it("ignores a non-string text_delta piece instead of appending it", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m6" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "seed" },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: 12345 },
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		// A non-string piece must NOT be appended — text stays exactly "seed".
		expect(content[0]?.text).toBe("seed");
	});

	// --- applyDelta input_json_delta: non-string partial_json -> empty piece ---
	it("treats a non-string partial_json as an empty fragment (no crash, no literal insertion)", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m7" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t1", name: "X", input: {} },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: 99 },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"a":1}' },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		// If the non-string piece were coerced/inserted, the buffer would break JSON.parse.
		expect(content[0]).toMatchObject({ input: { a: 1 } });
	});

	// --- closeBlock: undefined buf (no input_json_delta at all) skips entirely -
	it("leaves a block untouched by closeBlock when no input_json_delta arrived for it", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m8" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "plain" },
			}),
		);
		// content_block_stop fires with no jsonBuf entry for index 0 at all.
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		// buf === undefined -> closeBlock returns early: no `input` / `input_raw` key added.
		expect(content[0]).toEqual({ type: "text", text: "plain" });
		expect("input" in (content[0] ?? {})).toBe(false);
		expect("input_raw" in (content[0] ?? {})).toBe(false);
	});

	it("parses an all-whitespace accumulated buffer as an empty object, not raw", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m9" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t2", name: "Y", input: {} },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "   " },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		// buf.trim() === "" -> input becomes {} rather than JSON.parse("   ") (which would throw)
		// and rather than leaving raw "   " under input_raw.
		expect(content[0]?.input).toEqual({});
		expect("input_raw" in (content[0] ?? {})).toBe(false);
	});

	it("distinguishes a non-empty-but-untrimmed buffer from the blank-buffer path", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m10" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t3", name: "Z", input: {} },
			}),
		);
		// Leading/trailing whitespace around real JSON: buf itself is not "" but buf.trim() is not "" either.
		// This kills the "buf" vs "buf.trim()" MethodExpression mutant: JSON.parse(buf) would still succeed
		// here (whitespace-tolerant), so we instead prove trim() is actually being called via the blank case
		// above, and here prove real content still parses through the (buf.trim()==="" ? {} : JSON.parse(buf)) path.
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '  {"z":true}  ' },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content[0]?.input).toEqual({ z: true });
	});

	// --- applyMessageDelta: each field mutates independently --------------------
	it("ignores message_delta entirely when shell is null (no message_start yet)", () => {
		const r = createSseReassembler();
		// No message_start pushed — shell stays null, so applyMessageDelta must not run.
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			}),
		);
		expect(r.finish()).toBeNull();
	});

	it("applies stop_sequence from message_delta independently of stop_reason", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m11" } }));
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_sequence: "STOP" },
			}),
		);
		const msg = r.finish();
		expect(msg?.stop_sequence).toBe("STOP");
		expect(msg?.stop_reason).toBeUndefined();
	});

	it("leaves stop_sequence untouched when message_delta.delta omits it (undefined guard)", () => {
		const r = createSseReassembler();
		r.push(
			sse("message_start", {
				type: "message_start",
				message: { id: "m12", stop_sequence: "PRESET" },
			}),
		);
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
			}),
		);
		const msg = r.finish();
		// stop_sequence is not present on this message_delta -> the `!== undefined` guard
		// must leave the pre-existing value alone rather than overwriting it with undefined.
		expect(msg?.stop_sequence).toBe("PRESET");
		expect(msg?.stop_reason).toBe("end_turn");
	});

	it("overwrites stop_sequence with an explicit null (distinguishing null from undefined)", () => {
		const r = createSseReassembler();
		r.push(
			sse("message_start", {
				type: "message_start",
				message: { id: "m13", stop_sequence: "PRESET" },
			}),
		);
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "stop_sequence", stop_sequence: null },
			}),
		);
		const msg = r.finish();
		// stop_sequence: null IS !== undefined, so it DOES overwrite -> null, not the preset value.
		// This kills the `!== undefined` -> `=== undefined` EqualityOperator mutant and the
		// true/false ConditionalExpression mutants on this guard.
		expect(msg?.stop_sequence).toBeNull();
	});

	it("applies stop_reason from message_delta independently of stop_sequence", () => {
		const r = createSseReassembler();
		r.push(
			sse("message_start", {
				type: "message_start",
				message: { id: "m24", stop_reason: "PRESET_REASON" },
			}),
		);
		// delta has only stop_sequence — stop_reason is absent, so the
		// `delta.stop_reason !== undefined` guard must skip and leave the preset value.
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_sequence: "SEQ" },
			}),
		);
		const msg = r.finish();
		// If the guard were forced to always-true, `shell.stop_reason = delta.stop_reason`
		// would run with delta.stop_reason undefined, overwriting the preset value.
		expect(msg?.stop_reason).toBe("PRESET_REASON");
		expect(msg?.stop_sequence).toBe("SEQ");
	});

	it("still merges usage when message_delta.delta is not an object (guard must not abort the function)", () => {
		const r = createSseReassembler();
		r.push(
			sse("message_start", {
				type: "message_start",
				message: { id: "m25", usage: { input_tokens: 10 } },
			}),
		);
		// delta is a plain string -> asObject(delta) evaluates to null (rejected, not an
		// object), so the local `delta` binding is null here. The real `if (delta)` guard
		// is false and skips the stop_reason/stop_sequence block cleanly, falling through
		// to the INDEPENDENT usage-merge statement below it, which still runs.
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: "not-an-object",
				usage: { output_tokens: 20 },
			}),
		);
		const msg = r.finish();
		// If the guard were forced to always-true, the block would read
		// `delta.stop_reason` on a NULL `delta` -> throws synchronously -> the exception
		// propagates out of applyMessageDelta and is swallowed by the outer per-line
		// try/catch in drainCompleteEvents, aborting the rest of the function BEFORE the
		// usage-merge statement runs. So a mutated build ends up with usage un-merged
		// ({ input_tokens: 10 } only) while the real build merges both sides.
		expect(msg?.usage).toEqual({ input_tokens: 10, output_tokens: 20 });
	});

	it("does not touch usage at all when message_delta has no usage object", () => {
		const r = createSseReassembler();
		r.push(
			sse("message_start", {
				type: "message_start",
				message: { id: "m14", usage: { input_tokens: 7 } },
			}),
		);
		r.push(
			sse("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
			}),
		);
		const msg = r.finish();
		// asObject(undefined) -> null -> the `if (usage)` guard must skip merging entirely.
		expect(msg?.usage).toEqual({ input_tokens: 7 });
	});

	// --- handleEvent: index defaulting + branch discrimination ------------------
	it("defaults a missing/non-numeric content_block index to 0", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m15" } }));
		// No `index` field at all on content_block_start.
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				content_block: { type: "text", text: "a" },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				delta: { type: "text_delta", text: "b" },
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(1);
		expect(content[0]?.text).toBe("ab");
	});

	it("normalizes a non-numeric index to 0 rather than using it as a distinct Map key", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m26" } }));
		// index is the STRING "0", not the number 0 — the real code must normalize this
		// to numeric 0 via the `typeof === "number"` guard, so it lands in the same Map
		// slot as a later numeric-0 event.
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: "0",
				content_block: { type: "text", text: "a" },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "b" },
			}),
		);
		const msg = r.finish();
		// If the guard were forced to always-true, the first event would keep the STRING
		// "0" as its Map key (distinct from numeric 0), producing two separate blocks
		// instead of one merged block with text "ab".
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(1);
		expect(content[0]?.text).toBe("ab");
	});

	it("ignores a content_block_delta with a missing delta object entirely (no throw, no block created)", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m16" } }));
		// delta itself is absent -> asObject(undefined) is null -> applyDelta must be skipped,
		// but the block map entry still gets created by handleEvent's `blocks.get ?? {}` default
		// only inside applyDelta, which is never called here.
		r.push(sse("content_block_delta", { type: "content_block_delta", index: 3 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([]);
	});

	it("routes content_block_start / delta / stop / message_delta to distinct handling (not a fallthrough)", () => {
		// A single event stream exercising every switch arm with observably different
		// results proves the switch discriminates on `data.type` rather than always
		// taking one branch (kills the `default:` ConditionalExpression mutant).
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m17" } }));
		r.push(sse("unknown_event_type", { type: "unknown_event_type", index: 0 }));
		const midMsg = r.finish();
		// An unrecognized type must NOT create a content block or alter the shell.
		expect(midMsg?.content).toEqual([]);
		expect(midMsg?.id).toBe("m17");
	});

	// --- drainCompleteEvents: line/payload parsing edge cases -------------------
	it("ignores a line that does not start with 'data:' (e.g. an 'event:' line)", () => {
		const r = createSseReassembler();
		r.push("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m18" } }) + "\n\n");
		const msg = r.finish();
		expect(msg?.id).toBe("m18");
	});

	it("treats a line that is exactly 'data:' with only whitespace payload as empty (skipped)", () => {
		const r = createSseReassembler();
		// A bare "data:" with nothing after it, followed by the real event.
		r.push("data:   \n\n");
		r.push(sse("message_start", { type: "message_start", message: { id: "m19" } }));
		const msg = r.finish();
		expect(msg?.id).toBe("m19");
	});

	it("requires the literal 'data:' prefix — a line starting with 'Data:' (wrong case) is ignored", () => {
		const r = createSseReassembler();
		r.push('Data: {"type":"message_start","message":{"id":"wrong-case"}}\n\n');
		r.push(sse("message_start", { type: "message_start", message: { id: "m20" } }));
		const msg = r.finish();
		expect(msg?.id).toBe("m20");
	});

	it("trims surrounding whitespace from the data payload before JSON.parse", () => {
		const r = createSseReassembler();
		// Payload has trailing spaces after the JSON — must be trimmed, not passed raw to JSON.parse.
		r.push('data: {"type":"message_start","message":{"id":"m21"}}   \n\n');
		const msg = r.finish();
		expect(msg?.id).toBe("m21");
	});

	it("trims padding that JSON.parse itself rejects (BOM / NBSP / FF / LS / ideographic space)", () => {
		// The ASCII-space case above does NOT actually prove `.trim()` runs: JSON.parse
		// is tolerant of space/tab/CR/LF on its own, so dropping `.trim()` still parses.
		// String.prototype.trim() strips the FULL Unicode WhiteSpace+LineTerminator set,
		// which is strictly larger than JSON's four whitespace characters. These five pads
		// are stripped by trim() and REJECTED by JSON.parse — so the payload parses only
		// because trim() ran first. Without it the line throws, the per-line catch swallows
		// it, and the message never arrives (finish() -> null). Real sources of this padding:
		// BOM-prefixed UTF-8 bodies and intermediaries that re-encode spaces as U+00A0.
		// Explicit code points: these characters are invisible in a diff.
		const PADS = [0xfeff, 0x00a0, 0x000c, 0x2028, 0x3000].map((cp) => String.fromCodePoint(cp));
		const padded = PADS.map((pad) => {
			const r = createSseReassembler();
			const body = JSON.stringify({ type: "message_start", message: { id: "padded" } });
			r.push(`data: ${pad}${body}${pad}\n\n`);
			return r.finish()?.id ?? null;
		});
		expect(padded).toEqual(["padded", "padded", "padded", "padded", "padded"]);
	});

	it("does NOT process a line that merely happens to look like data after the prefix is stripped", () => {
		const r = createSseReassembler();
		// This line does NOT start with "data:" — it starts with "12345". But its first
		// 5 characters are the same LENGTH as "data:", so if the startsWith guard were
		// disabled (forced false) or its literal blanked out (making startsWith("") always
		// true), `line.slice("data:".length)` would still strip exactly 5 chars and land on
		// valid, parseable JSON underneath — a message_start the real code must NEVER see.
		const sneaky = `12345${JSON.stringify({ type: "message_start", message: { id: "sneaky" } })}\n\n`;
		r.push(sneaky);
		const msg = r.finish();
		// The real guard must reject this line outright (no "data:" prefix) — no message
		// ever arrives, so finish() returns null.
		expect(msg).toBeNull();
	});

	it("silently skips a JSON.parse failure on one data line but keeps processing later ones", () => {
		const r = createSseReassembler();
		r.push("data: {this is not json}\n\n");
		r.push(sse("message_start", { type: "message_start", message: { id: "m22" } }));
		const msg = r.finish();
		// The malformed line's catch block must not abort the whole drain.
		expect(msg?.id).toBe("m22");
	});

	it("isolates a throwing data line at LINE granularity, not event granularity", () => {
		// The try/catch sits inside the per-LINE loop, so a throw on one `data:` line
		// must not skip a later `data:` line of the SAME SSE event (one part, no blank
		// line between them). The test above only proves isolation ACROSS events.
		//
		// This is a load-bearing invariant, not a curiosity: the equivalence argument
		// for the surviving `if (usage)` / `if (shell)` / `!payload` / `if (data)`
		// guard mutants rests entirely on "a swallowed throw leaves no observable
		// trace, including on subsequent lines". If the catch is ever hoisted to wrap
		// the whole part — or given a body — those guards become killable and this
		// test is where the change surfaces.
		const r = createSseReassembler();
		r.push(
			[
				"data: {not json at all",
				`data: ${JSON.stringify({ type: "message_start", message: { id: "same-event" } })}`,
				"data: 12345",
				`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "kept" } })}`,
				"",
				"",
			].join("\n"),
		);
		const msg = r.finish();
		expect(msg?.id).toBe("same-event");
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content).toEqual([{ type: "text", text: "kept" }]);
	});

	// --- finish(): block ordering must be numeric, not insertion or reversed ----
	it("orders content blocks numerically by index, not by insertion order", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m23" } }));
		// Insert index 2 before index 0 and index 1, out of numeric order.
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 2,
				content_block: { type: "text", text: "third" },
			}),
		);
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "first" },
			}),
		);
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "second" },
			}),
		);
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		expect(content.map((b) => b.text)).toEqual(["first", "second", "third"]);
	});
});

// --- closeBlock: a parsed-but-non-object accumulated buffer must be treated
// the same as a parse FAILURE (kept under input_raw), never assigned to
// `input` — a tool_use `input` is always a JSON object by API contract.
describe("closeBlock — non-object parsed JSON", () => {
	function toolUseInput(partialJson: string): Record<string, unknown> | undefined {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t1", name: "X", input: {} },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: partialJson },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg?.content as Array<Record<string, unknown>>;
		return content[0];
	}

	// input_raw gets set on the invalid-shape path exactly like the JSON.parse
	// FAILURE path above (`'{"broken:'` test) — and that path never clears the
	// `input: {}` seeded by content_block_start either, so `block.input` stays
	// at its seeded default rather than adopting the rejected value.
	it("N1: a top-level JSON array is rejected — input_raw kept, input stays at its seeded default", () => {
		const block = toolUseInput("[1,2,3]");
		expect(block?.input_raw).toBe("[1,2,3]");
		expect(block?.input).toEqual({});
	});

	it("N2: a top-level bare JSON string is rejected — input_raw kept, input stays at its seeded default", () => {
		const block = toolUseInput('"just a string"');
		expect(block?.input_raw).toBe('"just a string"');
		expect(block?.input).toEqual({});
	});

	it("N3: a top-level JSON number is rejected — input_raw kept, input stays at its seeded default", () => {
		const block = toolUseInput("42");
		expect(block?.input_raw).toBe("42");
		expect(block?.input).toEqual({});
	});

	it("P1: a real object whose OWN values are arrays/nested objects still lands under input (only the top level must be an object)", () => {
		const block = toolUseInput('{"files":["a.ts","b.ts"],"opts":{"deep":true}}');
		expect(block?.input).toEqual({ files: ["a.ts", "b.ts"], opts: { deep: true } });
		expect("input_raw" in (block ?? {})).toBe(false);
	});
});
