import { parseWire, wireRecord, wireUnknown } from "../../lib/value-validation.js";
// G3 event-ordinal regression: the per-session monotonic `seq`
// (docs/design/reproducibility/g3-event-ordinal.md). Pins: monotonicity,
// restart continuation via serialize()/hydrate() (`last_seq`), per-session
// independence, counter cleanup on remove(), and writer stamping (activity +
// collection records carry the daemon-minted ordinal; records without one
// omit the field entirely — the cold-path shape).

import { describe, expect, it } from "vitest";
import { buildCollectionRecord } from "../../lib/collection/builder.js";
import { mapEventToActivityRecord } from "../server/activity-writer.js";
import { mapEventToCollectionInput } from "../server/collection-writer.js";
import { SessionTracker } from "../session-state.js";
import type { HarnessEvent } from "../types.js";

function toolEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-g3",
		agent_source: "claude",
		timestamp: "2026-07-24T12:00:00.000Z",
		tool_name: "Bash",
		tool_input: { command: "ls" },
		cwd: process.cwd(),
		...overrides,
	};
}

function mustSerialize(tracker: SessionTracker, sessionId: string) {
	const snap = tracker.serialize(sessionId);
	if (!snap) throw new Error(`serialize(${sessionId}) returned null`);
	return snap;
}

describe("SessionTracker.nextSeq — G3 event ordinal", () => {
	it("mints strictly increasing ordinals per session", () => {
		const t = new SessionTracker();
		t.recordEvent(toolEvent());
		expect(t.nextSeq("sess-g3")).toBe(1);
		expect(t.nextSeq("sess-g3")).toBe(2);
		expect(t.nextSeq("sess-g3")).toBe(3);
	});

	it("keeps per-session counters independent", () => {
		const t = new SessionTracker();
		expect(t.nextSeq("a")).toBe(1);
		expect(t.nextSeq("b")).toBe(1);
		expect(t.nextSeq("a")).toBe(2);
		expect(t.nextSeq("b")).toBe(2);
	});

	it("serialize carries last_seq and hydrate continues the sequence", () => {
		const t = new SessionTracker();
		t.recordEvent(toolEvent());
		t.nextSeq("sess-g3");
		t.nextSeq("sess-g3");
		const snap = mustSerialize(t, "sess-g3");
		expect(snap.last_seq).toBe(2);

		const restarted = new SessionTracker();
		expect(restarted.hydrate(snap)).not.toBeNull();
		expect(restarted.nextSeq("sess-g3")).toBe(3);
	});

	it("a pre-G3 snapshot (no last_seq) hydrates and starts at 1", () => {
		const t = new SessionTracker();
		t.recordEvent(toolEvent());
		const snap = mustSerialize(t, "sess-g3");
		delete (parseWire(snap, wireRecord(wireUnknown), "test JSON value")).last_seq;
		const restarted = new SessionTracker();
		expect(restarted.hydrate(snap)).not.toBeNull();
		expect(restarted.nextSeq("sess-g3")).toBe(1);
	});

	it("remove() clears the counter (a recreated session starts fresh)", () => {
		const t = new SessionTracker();
		t.nextSeq("gone");
		t.remove("gone");
		expect(t.nextSeq("gone")).toBe(1);
	});
});

describe("writer stamping — seq flows to persisted records", () => {
	it("activity record carries seq and event_id when present", () => {
		const rec = mapEventToActivityRecord(toolEvent({ seq: 7, event_id: "evt-1" }), process.cwd());
		expect(rec?.seq).toBe(7);
		expect(rec?.event_id).toBe("evt-1");
	});

	it("activity record omits seq/event_id when absent (cold path)", () => {
		const rec = mapEventToActivityRecord(toolEvent(), process.cwd());
		expect(rec?.seq).toBeUndefined();
		expect(rec?.event_id).toBeUndefined();
	});

	it("collection record carries seq end-to-end (input mapper → builder)", () => {
		const input = mapEventToCollectionInput(toolEvent({ seq: 42 }), process.cwd());
		expect(input.seq).toBe(42);
		const record = buildCollectionRecord(input);
		expect(record?.seq).toBe(42);
	});

	it("collection record omits seq when the event has none", () => {
		const input = mapEventToCollectionInput(toolEvent(), process.cwd());
		const record = buildCollectionRecord(input);
		if (!record) throw new Error("builder returned null for a pre tool event");
		expect("seq" in record).toBe(false);
	});
});
