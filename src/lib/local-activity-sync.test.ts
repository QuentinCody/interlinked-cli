import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendSyncError,
	assertActivitySyncCursor,
	captureActivitySyncBasis,
	checkpointSyncState,
	getUnsyncedEvents,
	readSyncState,
	updateSyncState,
} from "./local-activity-sync.js";

const INTERLINKED = ".interlinked";

function writeRaw(dataDir: string, name: string, lines: string[]): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, name), lines.length ? `${lines.join("\n")}\n` : "");
}

describe("local-activity-sync", () => {
	let root: string;
	let dataDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "interlinked-sync-unit-"));
		dataDir = join(root, INTERLINKED);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("drops a summary whose top_tools entry fails validation but keeps a valid cursor", () => {
		writeRaw(dataDir, "sync-state.json", [
			JSON.stringify({
				synced_through_bytes: 7,
				last_sync_at: "t",
				last_summary: {
					server_url: "https://sync.test",
					workspace_id: null,
					events_total: 1,
					accepted: 1,
					skipped: 0,
					scrubbed: 0,
					batches: 1,
					by_type: { edit: 1 },
					by_agent: { codex: 1 },
					// second tuple's count is not a safe integer -> parseTopTools
					// rejects the whole array, which drops the summary.
					top_tools: [
						["Edit", 1],
						["Read", "nine"],
					],
					sessions: 1,
					time_range: { earliest: "a", latest: "b" },
				},
			}),
		]);

		const state = readSyncState(root);
		expect(state.synced_through_bytes).toBe(7);
		expect(state.last_summary).toBeUndefined();
	});

	it("throws when a non-safe-integer or negative cursor is asserted directly", () => {
		expect(() => assertActivitySyncCursor(-1, 100)).toThrow(
			"cursor -1 is not a non-negative safe integer",
		);
		expect(() => assertActivitySyncCursor(1.5, 100)).toThrow(
			"cursor 1.5 is not a non-negative safe integer",
		);
	});

	it("rejects a snapshot basis when the activity log has not been created yet", () => {
		mkdirSync(dataDir, { recursive: true });
		expect(() => captureActivitySyncBasis(0, root)).toThrow(
			"activity sync cursor basis changed: activity log disappeared before sync started",
		);
	});

	it("rejects a snapshot basis when the persisted cursor moved since it was expected", () => {
		writeRaw(dataDir, "activity.jsonl", [JSON.stringify({ ts: "t1", agent: "a", type: "x" })]);
		updateSyncState(5, undefined, root);

		expect(() => captureActivitySyncBasis(0, root)).toThrow(
			"activity sync cursor basis changed: persisted cursor moved from 0 to 5",
		);
	});

	it("rejects a checkpoint once the activity log has been deleted after the basis was captured", () => {
		writeRaw(dataDir, "activity.jsonl", [JSON.stringify({ ts: "t1", agent: "a", type: "x" })]);
		const basis = captureActivitySyncBasis(0, root);
		unlinkSync(join(dataDir, "activity.jsonl"));

		expect(() =>
			checkpointSyncState({ basis, expectedCursor: 0, nextCursor: basis.endExclusive, cwd: root }),
		).toThrow("activity sync cursor basis changed: activity log disappeared before checkpoint");
		// The failed checkpoint must not have advanced the cursor.
		expect(readSyncState(root).synced_through_bytes).toBe(0);
	});

	it("rejects a frozen read window whose endExclusive is not a non-negative safe integer", () => {
		writeRaw(dataDir, "activity.jsonl", [JSON.stringify({ ts: "t1", agent: "a", type: "x" })]);

		expect(() => getUnsyncedEvents(undefined, root, { endExclusive: -1 })).toThrow(
			"activity sync cursor basis changed: snapshot EOF -1 is invalid",
		);
	});

	it("rejects a frozen read window whose endExclusive is beyond the current file size", () => {
		writeRaw(dataDir, "activity.jsonl", [JSON.stringify({ ts: "t1", agent: "a", type: "x" })]);
		const size = statSync(join(dataDir, "activity.jsonl")).size;

		expect(() => getUnsyncedEvents(undefined, root, { endExclusive: size + 100 })).toThrow(
			`activity sync cursor basis changed: snapshot EOF ${size + 100} exceeds the current ${size}-byte activity log`,
		);
	});

	it("rejects a start offset that lands past a frozen snapshot's own end", () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			JSON.stringify({ ts: `t${i}`, agent: "a", type: "x", summary: "pad".repeat(20) }),
		);
		writeRaw(dataDir, "activity.jsonl", rows);
		const path = join(dataDir, "activity.jsonl");
		const size = statSync(path).size;
		// endExclusive freezes the window well before the true EOF; startOffset
		// is valid against the file but not against that frozen window.
		const endExclusive = 10;
		const startOffset = Math.min(50, size);
		expect(startOffset).toBeGreaterThan(endExclusive);

		expect(() => getUnsyncedEvents(undefined, root, { startOffset, endExclusive })).toThrow(
			`activity sync cursor basis changed: cursor ${startOffset} exceeds snapshot EOF ${endExclusive}`,
		);
	});

	it("skips a blank line between two records without emitting an event for it", () => {
		const e1 = { ts: "t1", agent: "a", type: "x" };
		const e2 = { ts: "t2", agent: "b", type: "y" };
		mkdirSync(dataDir, { recursive: true });
		const path = join(dataDir, "activity.jsonl");
		writeFileSync(path, `${JSON.stringify(e1)}\n\n${JSON.stringify(e2)}\n`);

		const res = getUnsyncedEvents(undefined, root);
		expect(res.events.map((e) => e.agent)).toEqual(["a", "b"]);
		expect(res.newOffset).toBe(statSync(path).size);
	});

	it("drops a syntactically valid row that fails the event schema and advances past it", () => {
		writeRaw(dataDir, "activity.jsonl", [
			JSON.stringify({ ts: 12345, agent: "a", type: "x" }), // ts must be a string
			JSON.stringify({ ts: "t2", agent: "b", type: "y" }),
		]);

		const res = getUnsyncedEvents(undefined, root);
		expect(res.events.map((e) => e.agent)).toEqual(["b"]);
		expect(res.newOffset).toBe(statSync(join(dataDir, "activity.jsonl")).size);
	});

	it("rejects a page read whose expected identity no longer matches the activity log on disk", () => {
		const path = join(dataDir, "activity.jsonl");
		writeRaw(dataDir, "activity.jsonl", [JSON.stringify({ ts: "t1", agent: "a", type: "x" })]);
		const stale = captureActivitySyncBasis(0, root);

		// Replace the file via rename so it gets a fresh inode, simulating a
		// compaction that ran between capturing the basis and reading the page.
		const replacement = `${path}.replacement`;
		writeFileSync(replacement, `${JSON.stringify({ ts: "t2", agent: "b", type: "x" })}\n`);
		renameSync(replacement, path);

		expect(() =>
			getUnsyncedEvents(undefined, root, {
				startOffset: 0,
				endExclusive: stale.endExclusive,
				expectedIdentity: stale.identity,
			}),
		).toThrow("activity sync cursor basis changed: activity log was replaced during page read");
	});

	it("persists sync-error diagnostics for a transient failure", () => {
		appendSyncError({ stage: "manual_sync_network", message: "boom", transient: true }, root);
		const raw = readFileSync(join(dataDir, "sync-errors.jsonl"), "utf8").trim();
		const record = JSON.parse(raw);
		expect(record.stage).toBe("manual_sync_network");
		expect(record.message).toBe("boom");
		expect(record.transient).toBe(true);
	});
});
