import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstUserMessage, lastStructuredReturn, readTranscriptHead, readTranscriptTail } from "./transcript.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "transcript-kill-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("readTranscriptTail — positive (must fire correctly)", () => {
	// test-contract: public-api — readTranscriptTail returns null for a path that does not exist (mutant 8dd5099f)
	it("returns null for a nonexistent path", () => {
		expect(readTranscriptTail(join(dir, "nope.jsonl"), 100)).toBeNull();
	});

	// test-contract: boundary — readTranscriptTail returns null for a zero-length file (mutant 62d913a5)
	it("returns null for an empty file", () => {
		const p = join(dir, "empty.jsonl");
		writeFileSync(p, "");
		expect(readTranscriptTail(p, 100)).toBeNull();
	});

	// test-contract: public-api — when tailBytes exceeds the file, the full text is returned unsliced (mutants 1ac8ca66, 2c59775d)
	it("returns the exact full text unsliced when tailBytes exceeds file size", () => {
		const p = join(dir, "full.jsonl");
		const content = "AAAA\nBBBB\nCCCC\n";
		writeFileSync(p, content);
		expect(readTranscriptTail(p, 1000)).toBe(content);
	});

	// test-contract: public-api — a bounded tail read drops the partial first line and returns the exact suffix (mutants b1fe2cce, 4debd1bb, 82e25d2f)
	it("drops the partial first line for a bounded tail read", () => {
		const p = join(dir, "tail.jsonl");
		writeFileSync(p, "AAAA\nBBBB\nCCCC\n");
		expect(readTranscriptTail(p, 7)).toBe("CCCC\n");
	});
});

describe("readTranscriptHead — positive (must fire correctly)", () => {
	// test-contract: public-api — readTranscriptHead returns null for a path that does not exist (mutant 0be84f7e)
	it("returns null for a nonexistent path", () => {
		expect(readTranscriptHead(join(dir, "nope.jsonl"), 100)).toBeNull();
	});

	// test-contract: boundary — readTranscriptHead returns null for a zero-length file (mutant ce2924d5)
	it("returns null for an empty file", () => {
		const p = join(dir, "empty.jsonl");
		writeFileSync(p, "");
		expect(readTranscriptHead(p, 100)).toBeNull();
	});

	// test-contract: public-api — when headBytes covers the whole file, the exact unmodified text is returned (mutants 3b84ed9b, 3a0d6602, fd4ed599, ca680e7e)
	it("returns the exact full text unmodified when headBytes covers the whole file", () => {
		const p = join(dir, "small.jsonl");
		const content = "hello\nworld";
		writeFileSync(p, content);
		expect(readTranscriptHead(p, 1000)).toBe(content);
	});

	// test-contract: public-api — when headBytes is smaller than the file, the read is truncated to the last complete line (mutant 0bdfa619, reinforces 3b84ed9b)
	it("truncates to the last complete line when headBytes is smaller than the file", () => {
		const p = join(dir, "big.jsonl");
		writeFileSync(p, "AAAA\nBBBB\nCCCC\n");
		expect(readTranscriptHead(p, 7)).toBe("AAAA");
	});
});

describe("firstUserMessage / messageText — positive (must fire correctly)", () => {
	// test-contract: public-api — firstUserMessage joins array content blocks when content is not a plain string (mutant 6a79748e)
	it("joins array content blocks when content is not a plain string", () => {
		const line = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "array-text" }] } });
		expect(firstUserMessage(line)).toBe("array-text");
	});

	// test-contract: boundary — a user entry whose message is not an object is skipped without throwing (mutant 8362eecc)
	it("skips a user entry whose message is not an object without throwing", () => {
		const lines = [
			JSON.stringify({ type: "user", message: null }),
			JSON.stringify({ type: "user", message: { content: "final2" } }),
		].join("\n");
		expect(firstUserMessage(lines)).toBe("final2");
	});

	// test-contract: boundary — whitespace-only string content is treated as absent, not a value (mutant f04f05d3)
	it("treats whitespace-only string content as absent", () => {
		const lines = [
			JSON.stringify({ type: "user", message: { content: "   " } }),
			JSON.stringify({ type: "user", message: { content: "final3" } }),
		].join("\n");
		expect(firstUserMessage(lines)).toBe("final3");
	});
});

describe("firstUserMessage — positive (must fire correctly)", () => {
	// test-contract: invariant — a blank or whitespace-only line is skipped before it ever reaches JSON.parse (mutants 4780836c, ec7066e5)
	it("never attempts to JSON.parse a blank or whitespace-only line", () => {
		const spy = vi.spyOn(JSON, "parse");
		const validLine = JSON.stringify({ type: "user", message: { content: "hello" } });
		const text = `   \n${validLine}`;
		expect(firstUserMessage(text)).toBe("hello");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(validLine);
	});

	// test-contract: boundary — a line that parses to a non-object JSON value is skipped without throwing (mutant 9cf0906c)
	it("skips a line that parses to a non-object JSON value without throwing", () => {
		const lines = ["null", JSON.stringify({ type: "user", message: { content: "second" } })].join("\n");
		expect(firstUserMessage(lines)).toBe("second");
	});

	// test-contract: public-api — a non-user entry's message text is never returned as the first user message (mutant 870cbbc0)
	it("ignores a non-user entry's message text", () => {
		const lines = [
			JSON.stringify({ type: "assistant", message: { content: "hi" } }),
			JSON.stringify({ type: "user", message: { content: "second" } }),
		].join("\n");
		expect(firstUserMessage(lines)).toBe("second");
	});

	// test-contract: public-api — a user entry with no usable text does not short-circuit the scan (mutant 22ae653b)
	it("keeps scanning past a user entry with no usable text", () => {
		const lines = [
			JSON.stringify({ type: "user", message: { content: "" } }),
			JSON.stringify({ type: "user", message: { content: "final" } }),
		].join("\n");
		expect(firstUserMessage(lines)).toBe("final");
	});
});

describe("lastStructuredReturn / entryStructuredReturn — positive (must fire correctly)", () => {
	// test-contract: public-api — a tool_use return block on a non-assistant entry is never returned (mutant b773335e)
	it("ignores a tool_use return block on a non-assistant entry", () => {
		const line = JSON.stringify({
			type: "user",
			message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { foo: 1 } }] },
		});
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: boundary — an assistant entry whose message is not an object is skipped without throwing (mutant 753f6c25)
	it("skips an assistant entry whose message is not an object without throwing", () => {
		const line = JSON.stringify({ type: "assistant", message: "not an object" });
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: boundary — an assistant message whose content is object-shaped but not a real array is rejected (mutant 80f34e94)
	it("rejects an assistant message whose content is object-shaped but not a real array", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: { length: 1, "0": { type: "tool_use", name: "StructuredOutput", input: { x: 1 } } } },
		});
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: boundary — an empty assistant content array has no structured return.
	it("returns null for an empty assistant content array", () => {
		const line = JSON.stringify({ type: "assistant", message: { content: [] } });
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: boundary — a null content block is skipped without throwing (mutant df725e83)
	it("skips a null content block without throwing", () => {
		const line = JSON.stringify({ type: "assistant", message: { content: [null] } });
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: public-api — a return-verb name on a block that is not literally tool_use is rejected (mutants 24eac77f, d62294ae, 58ce09b6)
	it("rejects a return-verb name on a block that is not literally tool_use", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "not_tool_use", name: "StructuredOutput", input: { z: 1 } }] },
		});
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: public-api — a tool_use whose name is not a known return verb is rejected (mutant 6da9f713)
	it("rejects a tool_use whose name is not a known return verb", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "SomeRandomTool", input: { v: 1 } }] },
		});
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// test-contract: boundary — a return-verb tool_use with no input is rejected (mutant ce84fff6)
	it("rejects a return-verb tool_use with no input", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "StructuredOutput" }] },
		});
		expect(lastStructuredReturn(line)).toBeNull();
	});

	// c42b4c230123d111 (typeof raw.name !== "string" -> false): the downstream
	// RETURN_VERB_TOOLS.has(raw.name) Set lookup re-validates name membership with
	// no type coercion, so no reachable JSON-derived raw.name value could pass this
	// guard while failing that lookup. Suspected redundant/equivalent — not verified.
});

describe("lastStructuredReturn — positive (must fire correctly)", () => {
	// test-contract: boundary — a single-line transcript's only entry is still reached (mutant a81523be)
	it("finds a structured return on a single-line transcript", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { k: 1 } }] },
		});
		expect(lastStructuredReturn(line)).toEqual({ tool: "StructuredOutput", json: '{"k":1}' });
	});

	// test-contract: invariant — a trailing blank line is skipped before it ever reaches JSON.parse (mutants 3cde8511, 9a0a1947)
	it("never attempts to JSON.parse a trailing blank line", () => {
		const spy = vi.spyOn(JSON, "parse");
		const validLine = JSON.stringify({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "StructuredOutput", input: { k: 2 } }] },
		});
		const text = `${validLine}\n   `;
		expect(lastStructuredReturn(text)).toEqual({ tool: "StructuredOutput", json: '{"k":2}' });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith(validLine);
	});

	// test-contract: boundary — a line that parses to a non-object JSON value is skipped without throwing (mutant 2bb68e47)
	it("skips a structured-return line that parses to a non-object JSON value without throwing", () => {
		expect(lastStructuredReturn("null")).toBeNull();
	});

	// 0678af41dffb31e7 (lines.length-1 -> +1) and 224c2a2aaf13a75c (lines[i]?.trim ->
	// lines[i].trim): the out-of-range starting indices these mutants introduce are
	// absorbed by `lines[i]?.trim()` short-circuiting to undefined / `!line` skipping,
	// with no call reaching JSON.parse or any other observable — no distinguishing
	// input found. Suspected equivalent — not verified.
});
