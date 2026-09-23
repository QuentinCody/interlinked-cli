// Tests for the Stop-digest durable state: the per-session last-Stop snapshot
// and the detail spool. Labeled per the Check Evidence Contract convention —
// "positive (must fire)" = the state/spool changes, "negative (must not fire)"
// = the write is correctly withheld or degrades to a safe default.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	appendStopDigestSpool,
	diffAgainstLastStop,
	fingerprintFinding,
	loadStopDigestState,
	MAX_SPOOL_ROWS_PER_SESSION,
	MAX_TRACKED_SESSIONS,
	priorSnapshot,
	recordStopDigestState,
	STOP_DIGEST_SPOOL_FILE,
	STOP_DIGEST_STATE_FILE,
	wasTagReported,
} from "./stop-digest-state.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-digest-state-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("fingerprintFinding — positive (must fire)", () => {
    it("keeps repeated implementation identity across location shifts, but not changed differences", () => {
        const row = { file: "q.py", checkId: "repeated_implementation", text: "ack@L10 retry@L22 done pending" };
        expect(fingerprintFinding({ ...row, text: "ack@L20 retry@L32 done pending" })).toBe(fingerprintFinding(row));
        expect(fingerprintFinding({ ...row, text: "ack@L20 retry@L32 done failed" })).not.toBe(fingerprintFinding(row));
    });
	it("P1: gives two findings differing only in whitespace the same identity", () => {
		const a = fingerprintFinding({ file: "a.ts", checkId: "eval_usage", text: "eval( x )" });
		const b = fingerprintFinding({ file: "a.ts", checkId: "eval_usage", text: "eval(  x  )" });
		expect(a).toBe(b);
	});

	it("P2: is line-number-free, so a shifted line keeps its identity", () => {
		const id = fingerprintFinding({ file: "a.ts", checkId: "c", text: "boom" });
		expect(id).not.toMatch(/\d+/);
	});
});

describe("fingerprintFinding — negative (must not fire)", () => {
	it("N1: distinguishes the same text under a different check id", () => {
		const a = fingerprintFinding({ file: "a.ts", checkId: "c1", text: "boom" });
		const b = fingerprintFinding({ file: "a.ts", checkId: "c2", text: "boom" });
		expect(a).not.toBe(b);
	});

	it("N2: distinguishes the same finding in a different file", () => {
		const a = fingerprintFinding({ file: "a.ts", checkId: "c", text: "boom" });
		const b = fingerprintFinding({ file: "b.ts", checkId: "c", text: "boom" });
		expect(a).not.toBe(b);
	});
});

describe("loadStopDigestState — negative (must not fire)", () => {
	it("N3: returns an empty state when the file is absent", () => {
		expect(loadStopDigestState(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("N4: returns an empty state on malformed JSON rather than throwing", () => {
		writeFileSync(join(dir, STOP_DIGEST_STATE_FILE), "{not json");
		expect(loadStopDigestState(dir).sessions).toEqual({});
	});

	it("N5: drops a session entry whose snapshot has no last_stop", () => {
		writeFileSync(
			join(dir, STOP_DIGEST_STATE_FILE),
			JSON.stringify({ version: 1, sessions: { s1: { open: ["x"] } } }),
		);
		expect(loadStopDigestState(dir).sessions.s1).toBeUndefined();
	});
});

describe("recordStopDigestState — positive (must fire)", () => {
	it("P3: writes a snapshot that a later load reads back", () => {
		recordStopDigestState({ interlinkedDir: dir, sessionId: "s1", openIds: ["a", "b"], tags: ["t"] });
		expect(priorSnapshot(loadStopDigestState(dir), "s1")?.open).toEqual(["a", "b"]);
	});

	it("P4: unions this Stop's tags with tags recorded at a prior Stop", () => {
		recordStopDigestState({ interlinkedDir: dir, sessionId: "s1", openIds: [], tags: ["one"] });
		recordStopDigestState({ interlinkedDir: dir, sessionId: "s1", openIds: [], tags: ["two"] });
		const tags = priorSnapshot(loadStopDigestState(dir), "s1")?.reported_tags ?? [];
		expect([...tags].sort()).toEqual(["one", "two"]);
	});

	it("P5: accumulates the spooled-row count across Stops", () => {
		recordStopDigestState({
			interlinkedDir: dir,
			sessionId: "s1",
			openIds: [],
			tags: [],
			spooledDelta: 3,
		});
		recordStopDigestState({
			interlinkedDir: dir,
			sessionId: "s1",
			openIds: [],
			tags: [],
			spooledDelta: 4,
		});
		expect(priorSnapshot(loadStopDigestState(dir), "s1")?.spooled).toBe(7);
	});

	it("P6: evicts the oldest sessions past the tracked-session cap", () => {
		const total = MAX_TRACKED_SESSIONS + 5;
		const ids = Array.from({ length: total }, (_v, i) => `s${i}`);
		ids.forEach((id, i) => {
			recordStopDigestState({
				interlinkedDir: dir,
				sessionId: id,
				openIds: [],
				tags: [],
				now: new Date(1_700_000_000_000 + i * 1000),
			});
		});
		const kept = Object.keys(loadStopDigestState(dir).sessions);
		expect(kept).toHaveLength(MAX_TRACKED_SESSIONS);
		expect(kept).not.toContain("s0");
	});
});

describe("recordStopDigestState — negative (must not fire)", () => {
	it("N6: writes nothing under dryRun (a probe must not move the gate)", () => {
		recordStopDigestState({
			interlinkedDir: dir,
			sessionId: "s1",
			openIds: ["a"],
			tags: [],
			dryRun: true,
		});
		expect(loadStopDigestState(dir).sessions).toEqual({});
	});
});

describe("diffAgainstLastStop — positive (must fire)", () => {
	it("P7: reports every finding as new on the first Stop of a session", () => {
		const d = diffAgainstLastStop(null, ["a", "b"]);
		expect(d).toEqual({ newIds: ["a", "b"], resolved: 0, unchanged: 0, firstStop: true });
	});

	it("P8: splits new / resolved / unchanged against the prior snapshot", () => {
		const prior = { last_stop: "2026-08-16T00:00:00.000Z", open: ["a", "b"], spooled: 0 };
		const d = diffAgainstLastStop(prior, ["b", "c"]);
		expect(d).toEqual({ newIds: ["c"], resolved: 1, unchanged: 1, firstStop: false });
	});
});

describe("diffAgainstLastStop — negative (must not fire)", () => {
	it("N7: reports no new ids when the identical set is still open", () => {
		const prior = { last_stop: "2026-08-16T00:00:00.000Z", open: ["a", "b"], spooled: 0 };
		expect(diffAgainstLastStop(prior, ["a", "b"]).newIds).toEqual([]);
	});
});

describe("wasTagReported", () => {
	it("P9: is true for a tag recorded at a prior Stop", () => {
		const prior = { last_stop: "x", open: [], spooled: 0, reported_tags: ["mutation-kill"] };
		expect(wasTagReported(prior, "mutation-kill")).toBe(true);
	});

	it("N8: is false when there is no prior snapshot at all", () => {
		expect(wasTagReported(null, "mutation-kill")).toBe(false);
	});
});

describe("appendStopDigestSpool — positive (must fire)", () => {
	it("P10: appends one JSON line per row, stamped with session and ts", () => {
		const written = appendStopDigestSpool({
			interlinkedDir: dir,
			sessionId: "s1",
			rows: [{ session: "s1", kind: "rescan", file: "a.ts" }],
		});
		expect(written).toBe(1);
		const line = readFileSync(join(dir, STOP_DIGEST_SPOOL_FILE), "utf-8").trim();
		expect(JSON.parse(line)).toMatchObject({ session: "s1", kind: "rescan", file: "a.ts" });
	});

	it("P11: truncates the batch to the remaining per-session budget", () => {
		const rows = Array.from({ length: 5 }, (_v, i) => ({ session: "s1", kind: `k${i}` }));
		const written = appendStopDigestSpool({
			interlinkedDir: dir,
			sessionId: "s1",
			rows,
			alreadySpooled: MAX_SPOOL_ROWS_PER_SESSION - 2,
		});
		expect(written).toBe(2);
	});
});

describe("appendStopDigestSpool — negative (must not fire)", () => {
	it("N9: writes nothing under dryRun", () => {
		const written = appendStopDigestSpool({
			interlinkedDir: dir,
			sessionId: "s1",
			rows: [{ session: "s1", kind: "rescan" }],
			dryRun: true,
		});
		expect(written).toBe(0);
	});

	it("N10: writes nothing when the per-session cap is already spent", () => {
		const written = appendStopDigestSpool({
			interlinkedDir: dir,
			sessionId: "s1",
			rows: [{ session: "s1", kind: "rescan" }],
			alreadySpooled: MAX_SPOOL_ROWS_PER_SESSION,
		});
		expect(written).toBe(0);
	});

	it("N11: writes nothing for an empty row batch", () => {
		expect(
			appendStopDigestSpool({ interlinkedDir: dir, sessionId: "s1", rows: [] }),
		).toBe(0);
	});
});
