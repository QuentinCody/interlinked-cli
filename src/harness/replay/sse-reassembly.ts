// ===========================================
// G1 SSE reassembly — Messages streaming → final message
// ===========================================
// Rebuilds the final Anthropic message from a Server-Sent-Events stream, per
// the current Messages streaming contract (verified 2026-07-24):
//   message_start          → message shell + input-side usage
//   content_block_start    → open block at `index`
//   content_block_delta    → text_delta / thinking_delta / signature_delta
//                            append strings; input_json_delta appends
//                            PARTIAL-JSON fragments per index
//   content_block_stop     → parse the accumulated partial JSON into `input`
//   message_delta          → stop_reason + output-side usage (merge — the
//                            terminator message_stop carries neither)
//   message_stop           → terminator only
// Never throws on malformed input: the reassembler is on the proxy's capture
// path, and capture must never break forwarding. Unknown events are ignored;
// unparseable tool input is kept raw under `input_raw`.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

export interface SseReassembler {
	push(chunk: string): void;
	/** The reassembled message, or null when no message_start ever arrived. */
	finish(): JsonObject | null;
}

// Rule 3 (scratch/fleet-r2/CONTRACT.md): route the local narrower through the
// one canonical predicate instead of hand-rolling the object/array check.
function asObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

/** Append one string delta onto a block field (text/thinking/signature). */
function appendString(block: JsonObject, field: string, piece: unknown): void {
	if (typeof piece !== "string") return;
	const prev = typeof block[field] === "string" ? block[field] : "";
	block[field] = prev + piece;
}

function applyDelta(
	blocks: Map<number, JsonObject>,
	jsonBuf: Map<number, string>,
	index: number,
	delta: JsonObject,
): void {
	const block = blocks.get(index) ?? {};
	blocks.set(index, block);
	switch (delta.type) {
		case "text_delta":
			appendString(block, "text", delta.text);
			return;
		case "thinking_delta":
			appendString(block, "thinking", delta.thinking);
			return;
		case "signature_delta":
			appendString(block, "signature", delta.signature);
			return;
		case "input_json_delta": {
			const piece = typeof delta.partial_json === "string" ? delta.partial_json : "";
			jsonBuf.set(index, (jsonBuf.get(index) ?? "") + piece);
			return;
		}
		default:
			return;
	}
}

function closeBlock(
	blocks: Map<number, JsonObject>,
	jsonBuf: Map<number, string>,
	index: number,
): void {
	const buf = jsonBuf.get(index);
	if (buf === undefined) return;
	const block = blocks.get(index) ?? {};
	blocks.set(index, block);
	if (buf.trim() === "") {
		block.input = {};
		jsonBuf.delete(index);
		return;
	}
	try {
		const parsed = JSON.parse(buf);
		// A tool_use `input` is always a JSON object by API contract; a
		// same-shaped-but-wrong value (string/array/number) is treated the
		// same as a parse failure — keep the raw fragment, don't fake an object.
		if (isJsonObject(parsed)) block.input = parsed;
		else block.input_raw = buf;
	} catch (err) {
		void err; // keep the raw fragment — capture must not lose data on bad JSON
		block.input_raw = buf;
	}
	jsonBuf.delete(index);
}

/** Merge a message_delta event: stop_reason/stop_sequence on the shell,
 *  output-side usage folded into the usage object from message_start. */
function applyMessageDelta(shell: JsonObject, data: JsonObject): void {
	const delta = asObject(data.delta);
	if (delta) {
		if (delta.stop_reason !== undefined) shell.stop_reason = delta.stop_reason;
		if (delta.stop_sequence !== undefined) shell.stop_sequence = delta.stop_sequence;
	}
	const usage = asObject(data.usage);
	if (usage) {
		const merged = asObject(shell.usage) ?? {};
		for (const [k, v] of Object.entries(usage)) merged[k] = v;
		shell.usage = merged;
	}
}

/** Create a reassembler for ONE streamed message. Feed raw SSE text chunks in
 *  arrival order; chunk boundaries need not align with event boundaries. */
export function createSseReassembler(): SseReassembler {
	let buffer = "";
	let shell: JsonObject | null = null;
	const blocks = new Map<number, JsonObject>();
	const jsonBuf = new Map<number, string>();

	function handleEvent(data: JsonObject): void {
		const index = typeof data.index === "number" ? data.index : 0;
		switch (data.type) {
			case "message_start": {
				const msg = asObject(data.message);
				shell = msg ? { ...msg } : {};
				return;
			}
			case "content_block_start": {
				const cb = asObject(data.content_block);
				blocks.set(index, cb ? { ...cb } : {});
				return;
			}
			case "content_block_delta": {
				const delta = asObject(data.delta);
				if (delta) applyDelta(blocks, jsonBuf, index, delta);
				return;
			}
			case "content_block_stop":
				closeBlock(blocks, jsonBuf, index);
				return;
			case "message_delta":
				if (shell) applyMessageDelta(shell, data);
				return;
			default:
				// ping / message_stop / error / unknown — nothing to accumulate.
				return;
		}
	}

	// Process one complete SSE event block (lines between blank-line
	// separators): find its `data:` line(s) and dispatch each parsed
	// payload to handleEvent. Extracted from drainCompleteEvents to keep
	// the outer loop flat.
	function processPart(part: string): void {
		for (const line of part.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const payload = line.slice("data:".length).trim();
			if (!payload) continue;
			try {
				const data = asObject(JSON.parse(payload));
				if (data) handleEvent(data);
			} catch (err) {
				void err; // non-JSON data line (comments/pings) — ignored by contract
			}
		}
	}

	function drainCompleteEvents(): void {
		// SSE events are separated by a blank line. Process every complete
		// event; keep the trailing partial in the buffer.
		const parts = buffer.split(/\r?\n\r?\n/);
		buffer = parts.pop() ?? "";
		for (const part of parts) processPart(part);
	}

	return {
		push(chunk: string): void {
			buffer += chunk;
			drainCompleteEvents();
		},
		finish(): JsonObject | null {
			// Flush any final event that arrived without a trailing blank line.
			buffer += "\n\n";
			drainCompleteEvents();
			if (!shell) return null;
			const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
			shell.content = ordered;
			return shell;
		},
	};
}
