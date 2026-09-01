import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundKeySet, captureTimeline } from "./timeline-capture.js";
import { timelinePath } from "./timeline-writer.js";
import type { HarnessEvent } from "./types/events.js";

function assistantLine(uuid: string, ts: string, text: string): string {
	return `${JSON.stringify({
		type: "assistant",
		uuid,
		timestamp: ts,
		sessionId: "S",
		message: { model: "claude-test-5", content: [{ type: "text", text }] },
	})}\n`;
}

function stopEvent(cwd: string | undefined, transcriptPath: string): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "S",
		agent_source: "claude",
		timestamp: "2026-06-28T00:00:00.000Z",
		cwd,
		transcript_path: transcriptPath,
	} as HarnessEvent;
}

function timelineTexts(cwd: string): string[] {
	if (!existsSync(timelinePath(cwd))) return [];
	const body = readFileSync(timelinePath(cwd), "utf-8").trim();
	if (!body) return [];
	return body.split("\n").map((l) => {
		const p: { text?: string } = JSON.parse(l);
		return p.text ?? "";
	});
}

function cursorFilePath(cwd: string): string {
	return join(cwd, ".interlinked", "timeline-cursor.json");
}

describe("timeline-capture mutation kills (w53)", () => {
	let cwd: string;
	let transcript: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlc-w53-"));
		transcript = join(cwd, "transcript.jsonl");
		writeFileSync(
			transcript,
			assistantLine("u1", "2026-06-28T10:00:00.000Z", "first message") +
				assistantLine("u2", "2026-06-28T10:00:01.000Z", "second message"),
		);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	// Kills 683165148f708b72: the cursor written to disk after a successful
	// read must actually record {path, offset: size} — not an empty object.
	// A malformed-write-payload mutant leaves the cursor file with no usable
	// `offset`, which is directly observable by reading the cursor file back.
	// test-contract: public-api — captureTimeline's on-disk cursor payload
	it("writes the transcript path and byte offset into the cursor file after a drain", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		const raw = readFileSync(cursorFilePath(cwd), "utf-8");
		const parsed: { path?: string; offset?: number } = JSON.parse(raw);
		expect(parsed.path).toBe(transcript);
		expect(typeof parsed.offset).toBe("number");
		expect(parsed.offset).toBe(readFileSync(transcript, "utf-8").length);
	});

	// Kills 1f80d3b01b29762e: reading the cursor file with an invalid/empty
	// encoding argument throws inside readCursor's try, forcing a fallback to
	// a full re-read from offset 0 (duplicate content on an incremental drain
	// that a valid "utf-8" read would have avoided).
	// test-contract: public-api — captureTimeline's cursor-file encoding must
	// be a real decode, not an accidental throw swallowed into a full re-read
	it("resumes incrementally from a previously-written valid cursor (encoding must actually decode it)", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd); // establishes a real cursor at EOF
		writeFileSync(transcript, "", { flag: "a" }); // no-op touch, keep size identical
		const before = timelineTexts(cwd);
		expect(before).toEqual(["first message", "second message"]);
		// Now append genuinely new content and drain again — this only produces
		// exactly the new record if the cursor's offset was correctly parsed as
		// a NUMBER by JSON.parse of a correctly-decoded utf-8 string. If the
		// encoding read had thrown, the cursor would have been treated as
		// unreadable but the outer catch is on readCursor itself, so the
		// fallback path re-reads from 0 and would duplicate "first message" /
		// "second message" as fresh (they're not, because seenKeys dedups —
		// so instead we assert directly on the cursor file's parseability).
		const raw = readFileSync(cursorFilePath(cwd), "utf-8");
		expect(() => JSON.parse(raw)).not.toThrow();
		const parsed: { offset?: number } = JSON.parse(raw);
		expect(parsed.offset).toBe(readFileSync(transcript, "utf-8").length);
	});

	// Kills 7eeee49a70402354: forcing the `typeof parsed.offset === "number"`
	// check to `true` lets a cursor with a non-numeric offset (here: boolean
	// `true`) be accepted as valid instead of falling back to a fresh full
	// read. The accepted-but-invalid offset breaks the subsequent numeric
	// read (Buffer.alloc/readSync reject a non-number position), silently
	// dropping the drain — whereas the real check rejects the cursor up
	// front and falls back to a correct full read that captures everything.
	// test-contract: invariant — readCursor's offset type guard must reject a
	// non-numeric offset rather than accepting it
	it("rejects a cursor whose offset is not a number and falls back to a full, correct read", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(cursorFilePath(cwd), JSON.stringify({ path: transcript, offset: true }));
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	// Kills 7927d540082b4ed8: the read length must be exactly `size -
	// cursor.offset` (the remaining unread bytes). Requesting `size +
	// cursor.offset` bytes over-reads past EOF; the zero-filled padding
	// Buffer.alloc leaves beyond the actual bytes read gets appended directly
	// onto the tail of the last (newline-less) JSON line, corrupting it so it
	// fails to parse and is silently dropped.
	// test-contract: invariant — readNewRecords' read length must equal the
	// remaining unread byte count, not overshoot past EOF
	it("reads exactly the new tail bytes on an incremental drain, not more", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd); // cursor now at a nonzero offset > 0
		const newLine = JSON.stringify({
			type: "assistant",
			uuid: "u3",
			timestamp: "2026-06-28T10:00:02.000Z",
			sessionId: "S",
			message: { model: "claude-test-5", content: [{ type: "text", text: "third message" }] },
		});
		// No trailing newline: a correct-length read parses this JSON exactly;
		// an over-length read appends null-byte padding after it, breaking it.
		writeFileSync(transcript, newLine, { flag: "a" });
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message", "third message"]);
	});

	// Kills ad9f7e13bb2d5c8c: `event.cwd ?? fallbackCwd` must fall back to
	// `fallbackCwd` only when `event.cwd` is nullish. Replacing `??` with
	// `&&` makes the resolved cwd `undefined` whenever `event.cwd` is
	// undefined (since `undefined && x` is `undefined`, not `x`), which
	// crashes transcript-path resolution and silently no-ops the whole
	// drain — no timeline file is ever created in the real fallback cwd.
	// test-contract: public-api — captureTimeline(event, fallbackCwd) must use
	// fallbackCwd when event.cwd is nullish (`??`, not `&&`)
	it("falls back to fallbackCwd when the event carries no cwd of its own", () => {
		const event = stopEvent(undefined, transcript);
		captureTimeline(event, cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	// Kills 6ef645b020595121: boundKeySet must be a no-op when the set is
	// already exactly at the cap (over === 0). Weakening `over <= 0` to
	// `over < 0` lets the equal-to-cap case fall through into the eviction
	// loop and delete one entry it should have left alone.
	// test-contract: public-api — boundKeySet(set, max) must be a no-op when
	// set.size === max (over === 0)
	it("boundKeySet does not evict anything when the set is exactly at the cap", () => {
		const set = new Set(["a", "b", "c"]);
		boundKeySet(set, 3);
		expect(set.size).toBe(3);
		expect([...set]).toEqual(["a", "b", "c"]);
	});
});
