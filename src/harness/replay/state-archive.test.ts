// G2 per-step harness-state archive — pins the Tier-2 restore contract
// (docs/design/reproducibility/g2-tree-snapshots.md): the live snapshot +
// the six baseline water-line files are archived PER STEP (live.json alone is
// overwritten every event and deleted at SessionEnd), content-addressed so
// unchanged-state steps dedup to one blob, absent baselines recorded as null.

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BASELINE_FILES,
	loadStateSnapshot,
	parseHarnessStateSnapshot,
	parsePointerRow,
	recordStateSnapshot,
} from "./state-archive.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-g2-state-"));
	cleanups.push(dir);
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "coverage-baseline.json"), '{"cov":1}');
	writeFileSync(join(dir, ".interlinked", "metric-caps.json"), '{"lines":500}');
	return dir;
}

function record(dir: string, seq: number, live: Record<string, unknown>): void {
	recordStateSnapshot({
		cwd: dir,
		sessionId: "sess-state",
		seq,
		liveSnapshot: live,
		log: () => undefined,
	});
}

describe("recordStateSnapshot / loadStateSnapshot", () => {
	it("round-trips the live snapshot and baseline contents for a seq", () => {
		const dir = fixture();
		record(dir, 3, { tool_call_count: 9 });
		const state = loadStateSnapshot(dir, "sess-state", 3);
		expect(state?.live_snapshot).toEqual({ tool_call_count: 9 });
		expect(state?.baselines["coverage-baseline.json"]).toBe('{"cov":1}');
		expect(state?.baselines["metric-caps.json"]).toBe('{"lines":500}');
	});

	it("records absent baseline files as null (never silently missing)", () => {
		const dir = fixture();
		record(dir, 1, {});
		const state = loadStateSnapshot(dir, "sess-state", 1);
		for (const name of BASELINE_FILES) {
			expect(state ? name in state.baselines : false).toBe(true);
		}
		expect(state?.baselines["mutation-baseline.json"]).toBeNull();
	});

	it("dedups unchanged state to one blob across steps", () => {
		const dir = fixture();
		record(dir, 1, { n: 1 });
		record(dir, 2, { n: 1 });
		record(dir, 3, { n: 2 });
		const blobs = readdirSync(join(dir, ".interlinked", "replay", "state", "blobs"));
		expect(blobs).toHaveLength(2);
		expect(loadStateSnapshot(dir, "sess-state", 2)?.live_snapshot).toEqual({ n: 1 });
		expect(loadStateSnapshot(dir, "sess-state", 3)?.live_snapshot).toEqual({ n: 2 });
	});

	it("returns null for an unknown seq or session", () => {
		const dir = fixture();
		record(dir, 1, {});
		expect(loadStateSnapshot(dir, "sess-state", 99)).toBeNull();
		expect(loadStateSnapshot(dir, "other", 1)).toBeNull();
	});

	it("skips a torn pointer line and still resolves the intact rows around it", () => {
		const dir = fixture();
		record(dir, 5, { n: 5 });
		// A partial append (crash mid-write) leaves a truncated JSON line: the
		// reader's contract is to skip it, not to fail the whole restore.
		appendFileSync(
			join(dir, ".interlinked", "replay", "state", "sess-state.jsonl"),
			'{"seq":6,"sha":"dea',
		);
		expect(loadStateSnapshot(dir, "sess-state", 5)?.live_snapshot).toEqual({ n: 5 });
		expect(loadStateSnapshot(dir, "sess-state", 6)).toBeNull();
	});

	it("treats a corrupt blob as absent rather than throwing on a restore probe", () => {
		const dir = fixture();
		record(dir, 7, { n: 7 });
		const blobsDir = join(dir, ".interlinked", "replay", "state", "blobs");
		const blobPath = join(blobsDir, readdirSync(blobsDir)[0] ?? "missing");
		writeFileSync(blobPath, "plain text, not a gzip member");
		expect(existsSync(blobPath)).toBe(true); // past the missing-blob guard
		expect(loadStateSnapshot(dir, "sess-state", 7)).toBeNull();
	});

	it("fails open when the archive dir is unwritable (logs, no throw)", () => {
		const dir = fixture();
		const logs: string[] = [];
		writeFileSync(join(dir, ".interlinked", "replay"), "a file where a dir must go");
		recordStateSnapshot({
			cwd: dir,
			sessionId: "s",
			seq: 1,
			liveSnapshot: {},
			log: (m) => logs.push(m),
		});
		expect(logs.length).toBeGreaterThan(0);
	});
});

describe("parsePointerRow", () => {
	it("P1: accepts a well-formed row with a numeric seq", () => {
		expect(parsePointerRow({ seq: 3, sha: "abc123", ts: "2026-08-10T00:00:00Z" })).toEqual({
			seq: 3,
			sha: "abc123",
			ts: "2026-08-10T00:00:00Z",
		});
	});

	it("P2: accepts a null seq (never-recorded step)", () => {
		expect(parsePointerRow({ seq: null, sha: "abc123", ts: "t" })).toEqual({
			seq: null,
			sha: "abc123",
			ts: "t",
		});
	});

	it("N1: rejects a non-object value (array)", () => {
		expect(parsePointerRow(["abc123", 3])).toBeNull();
	});

	it("N2: rejects a missing sha", () => {
		expect(parsePointerRow({ seq: 1, ts: "t" })).toBeNull();
	});

	it("N3: rejects a non-string ts", () => {
		expect(parsePointerRow({ seq: 1, sha: "abc", ts: 12345 })).toBeNull();
	});

	it("N4: rejects a non-numeric, non-null seq", () => {
		expect(parsePointerRow({ seq: "3", sha: "abc", ts: "t" })).toBeNull();
	});
});

describe("parseHarnessStateSnapshot", () => {
	it("P1: accepts a well-formed snapshot with populated baselines", () => {
		const snapshot = parseHarnessStateSnapshot({
			schema: "state-snapshot.v1",
			live_snapshot: { tool_call_count: 2 },
			baselines: { "metric-caps.json": "{}", "coverage-baseline.json": null },
		});
		expect(snapshot).toEqual({
			schema: "state-snapshot.v1",
			live_snapshot: { tool_call_count: 2 },
			baselines: { "metric-caps.json": "{}", "coverage-baseline.json": null },
		});
	});

	it("P2: accepts a null live_snapshot", () => {
		const snapshot = parseHarnessStateSnapshot({
			schema: "state-snapshot.v1",
			live_snapshot: null,
			baselines: {},
		});
		expect(snapshot?.live_snapshot).toBeNull();
	});

	it("N1: rejects the wrong schema tag", () => {
		expect(
			parseHarnessStateSnapshot({ schema: "other.v1", live_snapshot: null, baselines: {} }),
		).toBeNull();
	});

	it("N2: rejects a non-object top level (string)", () => {
		expect(parseHarnessStateSnapshot("not an object")).toBeNull();
	});

	it("N3: rejects a baselines value that is not string-or-null", () => {
		expect(
			parseHarnessStateSnapshot({
				schema: "state-snapshot.v1",
				live_snapshot: null,
				baselines: { "x.json": 42 },
			}),
		).toBeNull();
	});

	it("N4: rejects an array-shaped live_snapshot (arrays are not JsonObject)", () => {
		expect(
			parseHarnessStateSnapshot({
				schema: "state-snapshot.v1",
				live_snapshot: ["not", "an", "object"],
				baselines: {},
			}),
		).toBeNull();
	});
});
