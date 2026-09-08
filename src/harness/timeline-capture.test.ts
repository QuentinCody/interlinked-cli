import { wireAbsentOptional, parseWire, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	boundKeySet,
	captureAgentTranscript,
	captureTimeline,
	MAX_LIVE_TRANSCRIPT_BYTES,
	MAX_SEEN_KEYS_PER_CWD,
} from "./timeline-capture.js";
import { timelinePath, writeTimeline } from "./timeline-writer.js";
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

function stopEvent(cwd: string, transcriptPath: string): HarnessEvent {
	return {
		hook_event: "Stop",
		session_id: "S",
		agent_source: "claude",
		timestamp: "2026-06-28T00:00:00.000Z",
		cwd,
		transcript_path: transcriptPath,
	};
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

describe("captureTimeline (live drain)", () => {
	let cwd: string;
	let transcript: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlc-"));
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

	it("captures assistant messages from the transcript on first drain", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	it("appends nothing on a second drain with no new transcript content (cursor at EOF)", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	it("captures only the NEW records on an incremental drain", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		appendFileSync(transcript, assistantLine("u3", "2026-06-28T10:00:02.000Z", "third message"));
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message", "third message"]);
	});

	it("waits for a split JSONL write to finish before advancing the cursor", () => {
		captureTimeline(stopEvent(cwd, transcript), cwd);
		const cursorPath = join(cwd, ".interlinked", "timeline-cursor.json");
		const completeOffset = readFileSync(transcript).byteLength;
		const third = assistantLine("u3", "2026-06-28T10:00:02.000Z", "split message");
		const splitAt = third.length - 2;
		appendFileSync(transcript, third.slice(0, splitAt));

		captureTimeline(stopEvent(cwd, transcript), cwd);
		const partialCursor: { offset?: number } = JSON.parse(readFileSync(cursorPath, "utf-8"));
		expect(partialCursor.offset).toBe(completeOffset);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);

		appendFileSync(transcript, third.slice(splitAt));
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message", "split message"]);
	});

	it("retries the same records after a timeline append failure", () => {
		mkdirSync(timelinePath(cwd), { recursive: true });
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(existsSync(join(cwd, ".interlinked", "timeline-cursor.json"))).toBe(false);

		rmSync(timelinePath(cwd), { recursive: true, force: true });
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	it("keeps independent persisted offsets when parallel agents alternate transcripts", () => {
		const other = join(cwd, "other.jsonl");
		writeFileSync(other, assistantLine("other-1", "2026-06-28T10:00:03.000Z", "other"));
		captureTimeline(stopEvent(cwd, transcript), cwd);
		captureTimeline(stopEvent(cwd, other), cwd);
		appendFileSync(transcript, assistantLine("u3", "2026-06-28T10:00:04.000Z", "third"));
		captureTimeline(stopEvent(cwd, transcript), cwd);

		const cursor: { offsets?: Record<string, number> } = JSON.parse(
			readFileSync(join(cwd, ".interlinked", "timeline-cursor.json"), "utf-8"),
		);
		expect(cursor.offsets).toMatchObject({
			[transcript]: readFileSync(transcript).byteLength,
			[other]: readFileSync(other).byteLength,
		});
		expect(timelineTexts(cwd)).toEqual(["first message", "second message", "other", "third"]);
	});

	it("reads only a bounded tail from a sparse 1 GiB transcript", () => {
		writeFileSync(transcript, "");
		truncateSync(transcript, 1024 * 1024 * 1024);
		appendFileSync(
			transcript,
			`\n${assistantLine("tail", "2026-06-28T10:00:05.000Z", "bounded tail")}`,
		);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["bounded tail"]);
		expect(MAX_LIVE_TRANSCRIPT_BYTES).toBe(8 * 1024 * 1024);
	});

	it("dedups against a pre-existing timeline (backfill overlap)", () => {
		// Pre-seed the timeline as if a backfill already captured u1, then let the
		// live drain re-read the whole transcript (fresh cursor) — u1 must not dup.
		writeTimeline(
			[
				{
					schema: "timeline.v1",
					ts: "2026-06-28T10:00:00.000Z",
					session: "S",
					uuid: "u1",
					seq: 0,
					category: "agent_message",
					role: "assistant",
					text: "first message",
				},
			],
			cwd,
		);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		const texts = timelineTexts(cwd);
		expect(texts.filter((t) => t === "first message")).toHaveLength(1);
		expect(texts).toContain("second message");
	});

	it("is a no-op when the transcript can't be resolved", () => {
		const bare = mkdtempSync(join(tmpdir(), "tlc-bare-"));
		const event: HarnessEvent = {
			hook_event: "Stop",
			session_id: "no-such-session",
			agent_source: "claude",
			timestamp: "2026-06-28T00:00:00.000Z",
			cwd: bare,
		};
		captureTimeline(event, bare);
		expect(existsSync(timelinePath(bare))).toBe(false);
		rmSync(bare, { recursive: true, force: true });
	});

	it("skips Codex rollouts that use a different transcript schema", () => {
		captureTimeline(
			{ ...stopEvent(cwd, transcript), agent_source: "codex" },
			cwd,
		);
		expect(existsSync(timelinePath(cwd))).toBe(false);
		expect(existsSync(join(cwd, ".interlinked", "timeline-cursor.json"))).toBe(false);
	});

	// test-contract: invariant — best-effort capture must never break the
	// daemon pipeline (module header). A directory can't be read as a JSONL
	// transcript (openSync succeeds, the subsequent readSync throws EISDIR),
	// so if the catch swallowing that were removed the exception would
	// propagate out of this FIRST call, uncaught, and this test would never
	// reach the second call or its literal assertion below.
	it("swallows an unreadable transcript (a directory) and still drains the next real one", () => {
		const dirAsTranscript = join(cwd, "not-a-file");
		mkdirSync(dirAsTranscript);
		captureTimeline(stopEvent(cwd, dirAsTranscript), cwd);
		captureTimeline(stopEvent(cwd, transcript), cwd);
		expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
	});

	describe("readCursor (via captureTimeline) — malformed cursor file", () => {
		function cursorPath(): string {
			return join(cwd, ".interlinked", "timeline-cursor.json");
		}
		function seedCursor(raw: string): void {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			writeFileSync(cursorPath(), raw);
		}

		it("P1: a valid matching cursor resumes from its recorded offset (incremental drain)", () => {
			captureTimeline(stopEvent(cwd, transcript), cwd); // writes a real cursor
			appendFileSync(transcript, assistantLine("u3", "2026-06-28T10:00:02.000Z", "third message"));
			captureTimeline(stopEvent(cwd, transcript), cwd);
			expect(timelineTexts(cwd)).toEqual(["first message", "second message", "third message"]);
		});

		it("migrates a valid legacy cursor into the per-transcript offset map", () => {
			const firstLineOffset = Buffer.byteLength(assistantLine("u1", "2026-06-28T10:00:00.000Z", "first message"));
			seedCursor(JSON.stringify({ path: transcript, offset: firstLineOffset }));
			captureTimeline(stopEvent(cwd, transcript), cwd);

			const migrated: { path?: string; offset?: number; offsets?: Record<string, number> } = JSON.parse(
				readFileSync(cursorPath(), "utf-8"),
			);
			expect(migrated).toMatchObject({
				path: transcript,
				offset: readFileSync(transcript).byteLength,
				offsets: { [transcript]: readFileSync(transcript).byteLength },
			});
			expect(timelineTexts(cwd)).toEqual(["second message"]);
		});

		it("rejects negative, fractional, and unsafe offsets before resuming", () => {
			const fractionalPath = join(cwd, "fractional.jsonl");
			seedCursor(
				JSON.stringify({
					path: transcript,
					offset: Number.MAX_SAFE_INTEGER + 1,
					offsets: { [transcript]: -1, [fractionalPath]: 1.5 },
				}),
			);
			captureTimeline(stopEvent(cwd, transcript), cwd);

			const repaired: { offsets?: Record<string, number> } = JSON.parse(readFileSync(cursorPath(), "utf-8"));
			expect(repaired.offsets).toEqual({ [transcript]: readFileSync(transcript).byteLength });
			expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
		});

		it("N1: a cursor whose fields carry the wrong type degrades to a fresh full read (no throw)", () => {
			seedCursor(JSON.stringify({ path: 123, offset: "not-a-number" }));
			captureTimeline(stopEvent(cwd, transcript), cwd);
			expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
		});

		it("N2: a cursor that parses to a non-object JSON value degrades the same way", () => {
			seedCursor("null");
			captureTimeline(stopEvent(cwd, transcript), cwd);
			expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
		});

		it("N3: unparseable cursor JSON degrades the same way", () => {
			seedCursor("{ not json");
			captureTimeline(stopEvent(cwd, transcript), cwd);
			expect(timelineTexts(cwd)).toEqual(["first message", "second message"]);
		});

		// test-contract: invariant — the per-cursor offset map is capped at 32
		// transcripts (MAX_CURSOR_TRANSCRIPTS, not exported); the oldest entry
		// is evicted, not the newest or an arbitrary one. Seeding exactly 32
		// pre-existing offsets plus this drain's own (real) transcript pushes
		// the map to 33, so the module must drop precisely one — the first
		// one written — to land back at 32.
		it("evicts only the oldest transcript offset once the per-cursor cap is exceeded", () => {
			const fakeOffsets: Record<string, number> = {};
			for (let i = 0; i < 32; i++) fakeOffsets[`fake-${i}`] = i;
			seedCursor(JSON.stringify({ path: "fake-0", offset: 0, offsets: fakeOffsets }));
			captureTimeline(stopEvent(cwd, transcript), cwd);
			const written: { offsets?: Record<string, number> } = JSON.parse(readFileSync(cursorPath(), "utf-8"));
			const offsets = written.offsets ?? {};
			expect(Object.keys(offsets)).toHaveLength(32);
			expect("fake-0" in offsets).toBe(false);
			expect(offsets[transcript]).toBe(readFileSync(transcript).byteLength);
		});
	});
});

describe("captureAgentTranscript (one-shot subagent drain)", () => {
	let cwd: string;

	function agentLine(uuid: string, text: string, agentId: string): string {
		return `${JSON.stringify({
			type: "assistant",
			uuid,
			timestamp: "2026-07-09T10:00:00.000Z",
			sessionId: "S",
			agentId,
			message: { model: "claude-test-5", content: [{ type: "text", text }] },
		})}\n`;
	}

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlc-agent-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("drains an agent transcript with agent_id attribution, without touching the main cursor", () => {
		const agentTranscript = join(cwd, "agent-z9.jsonl");
		writeFileSync(agentTranscript, agentLine("az1", "agent result", "z9"));
		const drained = captureAgentTranscript(agentTranscript, cwd);
		expect(drained).toBe(1);
		expect(existsSync(join(cwd, ".interlinked", "timeline-cursor.json"))).toBe(false);
		const rows = readFileSync(timelinePath(cwd), "utf-8")
			.trim()
			.split("\n")
			// SAFETY: our own timeline JSONL, written one line above.
			.map((l) => parseWire(JSON.parse(l), wireObject({ "text": wireAbsentOptional(wireOptional(wireString)), "agent_id": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value"));
		expect(rows).toEqual([expect.objectContaining({ text: "agent result", agent_id: "z9" })]);
	});

	it("is idempotent — a second drain appends nothing", () => {
		const agentTranscript = join(cwd, "agent-z9.jsonl");
		writeFileSync(agentTranscript, agentLine("az1", "agent result", "z9"));
		expect(captureAgentTranscript(agentTranscript, cwd)).toBe(1);
		expect(captureAgentTranscript(agentTranscript, cwd)).toBe(0);
		expect(timelineTexts(cwd)).toEqual(["agent result"]);
	});

	it("returns 0 for a missing or undefined path", () => {
		expect(captureAgentTranscript(undefined, cwd)).toBe(0);
		expect(captureAgentTranscript(join(cwd, "nope.jsonl"), cwd)).toBe(0);
		expect(existsSync(timelinePath(cwd))).toBe(false);
	});

	// test-contract: invariant — same fail-open contract as captureTimeline's
	// live drain. A directory can't be opened as a JSONL transcript for
	// reading (readSync throws EISDIR after openSync succeeds); if the catch
	// swallowing that were removed, this first call would throw uncaught and
	// the test would never reach the second (real) drain below.
	it("returns 0 for an unreadable transcript (a directory) and still drains a later real one", () => {
		const dirAsTranscript = join(cwd, "agent-dir");
		mkdirSync(dirAsTranscript);
		expect(captureAgentTranscript(dirAsTranscript, cwd)).toBe(0);
		const agentTranscript = join(cwd, "agent-z9.jsonl");
		writeFileSync(agentTranscript, agentLine("az1", "agent result", "z9"));
		expect(captureAgentTranscript(agentTranscript, cwd)).toBe(1);
	});
});

describe("boundKeySet (daemon dedup memory bound)", () => {
	it("evicts the oldest keys to hold the set at the cap, retaining the most recent", () => {
		const set = new Set<string>();
		for (let i = 0; i < 100; i++) set.add(`k${i}`);
		boundKeySet(set, 50);
		expect(set.size).toBe(50);
		expect(set.has("k99")).toBe(true); // newest retained
		expect(set.has("k50")).toBe(true); // boundary retained
		expect(set.has("k49")).toBe(false); // oldest evicted
		expect(set.has("k0")).toBe(false);
	});

	it("is a no-op when the set is at or under the cap", () => {
		const set = new Set(["a", "b", "c"]);
		boundKeySet(set, 10);
		expect([...set]).toEqual(["a", "b", "c"]);
	});

	it("ships a positive default bound", () => {
		expect(MAX_SEEN_KEYS_PER_CWD).toBeGreaterThan(0);
	});
});
