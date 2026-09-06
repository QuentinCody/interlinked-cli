// Behavioral tests for the collection-stream liveness readout.
//
// These pin the exact thing that silently broke before: a data-collection
// stream that stops advancing must be classifiable as such. Each status is
// driven through real on-disk fixtures with an injected clock so the
// classification is deterministic. The two I/O-failure statuses are the
// exception: `statSync` / `openSync` are passthrough `vi.fn` wrappers so a
// single call can be made to fail without an unportable on-disk fixture.

import { mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAge, getCollectionLiveness } from "./liveness.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, openSync: vi.fn(actual.openSync), statSync: vi.fn(actual.statSync) };
});

const NOW = Date.parse("2026-06-06T12:00:00.000Z");

function tsAgo(ms: number): string {
	return new Date(NOW - ms).toISOString();
}

describe("formatAge", () => {
	it("renders seconds / minutes / hours / days", () => {
		expect(formatAge(5_000)).toBe("5s");
		expect(formatAge(90_000)).toBe("1m");
		expect(formatAge(3 * 3_600_000)).toBe("3h");
		expect(formatAge(2 * 86_400_000)).toBe("2d");
	});

	it("clamps negative ages (future-stamped record / clock skew) to 0s", () => {
		expect(formatAge(-5_000)).toBe("0s");
	});

	it("uses the largest fitting unit at boundaries", () => {
		expect(formatAge(59_000)).toBe("59s");
		expect(formatAge(60_000)).toBe("1m");
		expect(formatAge(59 * 60_000)).toBe("59m");
		expect(formatAge(60 * 60_000)).toBe("1h");
		expect(formatAge(23 * 3_600_000)).toBe("23h");
		expect(formatAge(24 * 3_600_000)).toBe("1d");
	});
});

describe("getCollectionLiveness", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "il-coll-live-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeCollection(lines: string[]): void {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "collection.jsonl"), lines.map((l) => `${l}\n`).join(""));
	}

	function record(ts: string, extra: Record<string, unknown> = {}): string {
		return JSON.stringify({ schema: "collection.v1", kind: "tool_event", ts, ...extra });
	}

	it("reports 'missing' when the file does not exist", () => {
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("missing");
		expect(live.exists).toBe(false);
		expect(live.lastRecordTs).toBeNull();
		expect(live.reason).toContain("does not exist");
	});

	it("reports 'empty' when the file exists but has no records", () => {
		writeCollection([]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("empty");
		expect(live.exists).toBe(true);
		expect(live.sizeBytes).toBe(0);
	});

	it("reports 'live' when the last record is recent", () => {
		writeCollection([record(tsAgo(2_000))]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("live");
		expect(live.lastRecordAgeMs).toBe(2_000);
		expect(live.reason).toContain("2s ago");
		expect(live.sizeBytes).toBeGreaterThan(0);
	});

	it("reports 'idle' between the idle and stale thresholds", () => {
		writeCollection([record(tsAgo(10 * 60_000))]); // 10 min — past 5 min idle, under 24 h
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("idle");
		expect(live.reason).toContain("no recent tool events");
	});

	it("reports 'stale' past the stale threshold — the broken-stream alarm", () => {
		writeCollection([record(tsAgo(48 * 3_600_000))]); // 2 days
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("stale");
		expect(live.reason).toContain("may be broken");
	});

	it("uses the LAST record's ts when several are present", () => {
		writeCollection([
			record(tsAgo(90 * 60_000)),
			record(tsAgo(60 * 60_000)),
			record(tsAgo(3_000)), // newest — should win → live
		]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("live");
		expect(live.lastRecordAgeMs).toBe(3_000);
	});

	it("tolerates a partial first line when the tail window cuts mid-record", () => {
		writeCollection([record(tsAgo(5_000), { pad: "x".repeat(200) }), record(tsAgo(1_000))]);
		// 64-byte window lands inside the last record only; but with a tiny window
		// the cut falls mid-line — the last COMPLETE line must still be found.
		const live = getCollectionLiveness(dir, { now: NOW, tailBytes: 80 });
		expect(live.status).toBe("live");
		expect(live.lastRecordAgeMs).toBe(1_000);
	});

	it("reports 'unreadable' when the last record has no parseable ts", () => {
		writeCollection([record(tsAgo(1_000)), JSON.stringify({ schema: "collection.v1", foo: 1 })]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("unreadable");
	});

	it("reports 'unreadable' when the last record's ts is not a date", () => {
		writeCollection([record("not-a-real-timestamp")]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("unreadable");
		expect(live.lastRecordTs).toBe("not-a-real-timestamp");
	});

	it("honors custom idle/stale thresholds", () => {
		writeCollection([record(tsAgo(30_000))]); // 30s old
		expect(getCollectionLiveness(dir, { now: NOW, idleMs: 10_000 }).status).toBe("idle");
		expect(getCollectionLiveness(dir, { now: NOW, idleMs: 10_000, staleMs: 20_000 }).status).toBe(
			"stale",
		);
	});

	// lastRecordTsFromTail — direct boundary-parser coverage (replaces
	// `JSON.parse(line) as { ts?: unknown }`).
	it("P1: reads ts off the last well-formed record", () => {
		writeCollection([record(tsAgo(4_000))]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("live");
		expect(live.lastRecordTs).toBe(tsAgo(4_000));
	});

	it("N1: a syntactically-valid but non-object last line (bare JSON array) is not a record — walks back to the previous real record instead of giving up", () => {
		writeCollection([record(tsAgo(2_000)), JSON.stringify([1, 2, 3])]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("live");
		expect(live.lastRecordTs).toBe(tsAgo(2_000));
	});

	it("N2: a bare JSON number as the only line yields 'unreadable', not a crash", () => {
		writeCollection(["42"]);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.status).toBe("unreadable");
	});

	it("walks back past a garbled TRAILING line to the last complete record", () => {
		writeCollection([record(tsAgo(1_000)), '{"schema":"collection.v1","ts":"2026-06']);
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.lastRecordTs).toBe(tsAgo(1_000));
		expect(live.status).toBe("live");
	});

	it("reports 'unreadable' when the file exists but cannot be stat'd", () => {
		writeCollection([record(tsAgo(1_000))]);
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, stat");
		});
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.reason).toBe("collection.jsonl could not be stat'd");
		expect(live.status).toBe("unreadable");
		expect(live.exists).toBe(true);
		expect(live.sizeBytes).toBe(0);
	});

	it("reports 'unreadable' when the stream is sized but its tail cannot be opened", () => {
		const line = `${record(tsAgo(1_000))}\n`;
		writeCollection([record(tsAgo(1_000))]);
		vi.mocked(openSync).mockImplementationOnce(() => {
			throw new Error("EACCES: permission denied, open");
		});
		const live = getCollectionLiveness(dir, { now: NOW });
		expect(live.reason).toBe(
			"could not parse a record timestamp from the tail of collection.jsonl",
		);
		expect(live.sizeBytes).toBe(line.length);
		expect(live.lastRecordTs).toBeNull();
	});
});
