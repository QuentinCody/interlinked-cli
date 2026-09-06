import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A CONCURRENT compactor, simulated at the one instant that matters: between
 * our sequence scan and our segment claim. `race.segment` names the segment
 * basename the rival claims; the first hard-link publication whose path matches
 * finds the rival's bytes already there.
 *
 * `vi.mock` + `vi.hoisted` rather than `vi.spyOn(fs, …)`: spying on node:fs
 * throws "Module namespace is not configurable in ESM" (same workaround as
 * src/lib/__tests__/local-activity.mutation-kill-w34.test.ts). Every other call
 * passes straight through to the real fs.
 */
const race = vi.hoisted(() => ({
	segment: null as string | null,
	content: Buffer.from("rival-compactor-segment-bytes"),
	/** Basenames of every write/link/rename destination, in call order. */
	writes: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const writeFileSyncPassthrough = (...args: Parameters<typeof actual.writeFileSync>): void => {
		const [file, data, options] = args;
		const path = String(file);
		race.writes.push(path.slice(path.lastIndexOf("/") + 1));
		actual.writeFileSync(file, data, options);
	};
	const linkSyncPassthrough = (...args: Parameters<typeof actual.linkSync>): void => {
		const [, destination] = args;
		const path = String(destination);
		const name = path.slice(path.lastIndexOf("/") + 1);
		race.writes.push(name);
		if (race.segment !== null && name === race.segment) {
			race.segment = null; // the rival wins the race exactly once
			actual.writeFileSync(path, race.content);
		}
		actual.linkSync(...args);
	};
	const renameSyncPassthrough = (...args: Parameters<typeof actual.renameSync>): void => {
		const [, destination] = args;
		const path = String(destination);
		race.writes.push(path.slice(path.lastIndexOf("/") + 1));
		actual.renameSync(...args);
	};
	return {
		...actual,
		linkSync: linkSyncPassthrough,
		renameSync: renameSyncPassthrough,
		writeFileSync: writeFileSyncPassthrough,
	};
});

import { computeEntryHash, GENESIS_HASH, verifyAuditChain } from "../../lib/audit-chain.js";
import { MAX_SYNC_STATE_BYTES } from "../../lib/local-activity-sync.js";
import { nonNull } from "../../lib/non-null.js";
import {
	MAX_ARCHIVE_MANIFEST_BYTES,
	readArchiveManifestJson,
} from "../compact-plain.js";
import {
	compactCommand,
	loadArchiveManifest,
	loadOrRebuildArchiveManifest,
	registerCompactCommand,
} from "../compact.js";

afterEach(() => {
	race.segment = null;
	race.writes.length = 0;
});

/** Run a compaction with console.log captured, so fixtures stay quiet. */
async function quiet(run: () => Promise<void>): Promise<string[]> {
	const out: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
	try {
		await run();
	} finally {
		log.mockRestore();
	}
	return out;
}

function writeLog(records: object[]): { tempDir: string; dataDir: string; content: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
	const dataDir = join(tempDir, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
	const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	writeFileSync(join(dataDir, "activity.jsonl"), content);
	return { tempDir, dataDir, content };
}

function setSync(dataDir: string, bytes: number): void {
	writeFileSync(
		join(dataDir, "sync-state.json"),
		JSON.stringify({ synced_through_bytes: bytes, last_sync_at: "" }),
	);
}

describe("interlinked compact", () => {
	it("archives the synced prefix, keeps unsynced + audit tail live, and is lossless", async () => {
		const records = [
			...Array.from({ length: 20 }, (_, i) => ({ schema_version: 5, type: "tool_use", i })),
			{ schema_version: 5, type: "guard_allow", hash: "a".repeat(64), previousHash: "0".repeat(64) },
			...Array.from({ length: 5 }, (_, i) => ({ schema_version: 5, type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total); // everything synced

		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 50 });

		const manifest = loadArchiveManifest(tempDir);
		expect(manifest.segments.length).toBe(1);
		const seg = nonNull(manifest.segments[0]);
		const gzPath = join(dataDir, "archive", seg.file);
		expect(existsSync(gzPath)).toBe(true);

		// Lossless: gunzip(segment) + live === original, byte-for-byte.
		const archived = gunzipSync(readFileSync(gzPath)).toString("utf-8");
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(archived + live).toBe(content);

		// Audit tail stays live: the last chained record must remain in the live file.
		expect(live).toContain("guard_allow");

		// Cursor decremented by exactly the archived byte count.
		const sync = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf-8"));
		expect(sync.synced_through_bytes).toBe(total - seg.bytes);
	});

	it("does nothing when no data is synced", async () => {
		const { tempDir, dataDir } = writeLog([
			{ type: "tool_use", i: 1 },
			{ type: "tool_use", i: 2 },
		]);
		setSync(dataDir, 0);
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 10 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});

	it("refuses a stale sync cursor beyond the live EOF without archiving current bytes", async () => {
		const { tempDir, dataDir, content } = writeLog(
			Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", i })),
		);
		setSync(dataDir, Buffer.byteLength(content) + 1);
		const out = await quiet(() =>
			compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 }),
		);

		const result = JSON.parse(nonNull(out[0]));
		expect(result.reason).toContain("cursor invalidated");
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf8")).toBe(content);
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});

	it("dry-run makes no changes", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toBe(content);
	});

	it("never archives past the last chained record (write-time chain continuity)", async () => {
		const records = [
			...Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "b".repeat(64), previousHash: "0".repeat(64), last: true },
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).toContain('"last":true');
	});

	it("audit chain still verifies across the compaction boundary", async () => {
		// Build a valid 2-link chain (real hashes) with plain records around it.
		const c1 = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
		const c1full = { ...c1, hash: computeEntryHash(c1) };
		const c2 = { type: "guard_allow", previousHash: c1full.hash, n: 2, last: true };
		const c2full = { ...c2, hash: computeEntryHash(c2) };
		const records = [
			...Array.from({ length: 8 }, (_, i) => ({ type: "tool_use", i })),
			c1full,
			...Array.from({ length: 4 }, (_, i) => ({ type: "tool_use", i: 50 + i })),
			c2full,
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));

		// Valid before compaction.
		expect(verifyAuditChain(tempDir).valid).toBe(true);

		// Compact: c1 lands in the archive, c2 (last chained) stays live.
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain('"last":true');
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);

		// Still valid — verify reads archive(c1) then live(c2) across the boundary.
		const result = verifyAuditChain(tempDir);
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(2);
	});

	it("--all archives un-synced data (local-only / disk recovery), still audit-tail-safe", async () => {
		const records = [
			...Array.from({ length: 15 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "c".repeat(64), previousHash: "0".repeat(64), last: true },
		];
		const { tempDir, dataDir } = writeLog(records);
		// No sync-state at all — the real local-only case (nothing ever synced).
		await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: 1 });
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
		// The last chained record still stays live (audit-tail-safe) even with --all.
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain('"last":true');
	});

	it("does nothing (with a message) when activity.jsonl does not exist at all", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true });
		} finally {
			log.mockRestore();
		}
		expect(JSON.parse(nonNull(out[0]))).toEqual({ compacted: false, reason: "no activity.jsonl" });
	});

	it("prints human-readable output (not JSON) when --json is not passed, with the exact mb/percentage figures", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));

		// Probe run: identical fixture, --json, to derive the exact expected figures
		// independently of the human-message template under test.
		const probeFixture = writeLog(records);
		setSync(probeFixture.dataDir, Buffer.byteLength(probeFixture.content));
		const probeOut: string[] = [];
		const probeLog = vi.spyOn(console, "log").mockImplementation((m) => void probeOut.push(String(m)));
		let probe: { archived_bytes: number; archived_records: number; gz_bytes: number; live_after_bytes: number; segment: string };
		try {
			await compactCommand({ cwd: probeFixture.tempDir, json: true, keepRecentBytes: 20 });
			probe = JSON.parse(nonNull(probeOut[0]));
		} finally {
			probeLog.mockRestore();
		}

		// Real run: identical fixture, human-readable mode.
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		const msg = nonNull(out[0]);
		// Human output is not parseable JSON — it's the "✓ Compacted" narrative line.
		expect(() => JSON.parse(msg)).toThrow();
		expect(msg).toContain("Compacted");
		expect(msg).toContain(`${(probe.archived_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`(${probe.archived_records} records)`);
		expect(msg).toContain(`archive/${probe.segment}`);
		expect(msg).toContain(`gzipped to ${(probe.gz_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`${Math.round((1 - probe.gz_bytes / probe.archived_bytes) * 100)}% smaller, lossless`);
		// Whole contiguous phrase (label + before-size + arrow + after-size), not just
		// the after-size figure in isolation — a small fixture's mb() values can all
		// format to the same "0.0MB" text, so a lone-number check can't tell "this
		// exact labeled line is present" from "some other line's number matches".
		const totalBytes = Buffer.byteLength(content);
		expect(msg).toContain(
			`live activity.jsonl: ${(totalBytes / 1024 / 1024).toFixed(1)}MB → ${(probe.live_after_bytes / 1024 / 1024).toFixed(1)}MB`,
		);
		expect(msg).toContain(`recover: gunzip -c .interlinked/archive/${probe.segment}`);
	});

	it("reports 'first record exceeds the archivable region' for a single-record file with nothing to cut before it", async () => {
		const { tempDir, dataDir, content } = writeLog([{ type: "tool_use", i: 1 }]);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 0 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("first record exceeds the archivable region");
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
	});

	it("reports the recent-tail reason when keepRecentBytes exceeds the whole (synced) file", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all so syncedBytes is irrelevant (ignoreSync=true); keepRecentBytes bigger
			// than the whole file forces `fileSize - keepRecentBytes <= 0`.
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: fileBytes + 10_000 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe(
			`log is within the ${((fileBytes + 10_000) / 1024 / 1024).toFixed(1)}MB recent-tail kept live`,
		);
	});

	it("reports the pre-audit-tail-empty reason when the chained record is the very first line", async () => {
		const records = [
			{ type: "guard_allow", hash: "d".repeat(64), previousHash: "0".repeat(64), first: true },
			...Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		setSync(dataDir, fileBytes); // everything synced (first cond of the reason ternary: false)
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// Small keepRecentBytes so fileSize - keepRecentBytes > 0 (second cond: false too) —
			// only the chained-record-at-offset-0 constraint drives limit to 0.
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("the pre-audit-tail region is empty");
	});

	it("treats a missing/non-numeric synced_through_bytes as nothing synced (fail safe)", async () => {
		const { tempDir, dataDir } = writeLog(Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })));
		// sync-state.json exists but its field is the wrong type — not the number branch.
		writeFileSync(join(dataDir, "sync-state.json"), JSON.stringify({ synced_through_bytes: "not-a-number" }));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.synced_bytes).toBe(0);
		expect(parsed.reason).toBe("no synced data yet — pass --all to compact a local-only log");
	});

	it("refuses an oversized sync-state document before trusting its cursor", async () => {
		const { tempDir, dataDir } = writeLog(
			Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })),
		);
		const oversized = JSON.stringify({ synced_through_bytes: 123 }).padEnd(
			MAX_SYNC_STATE_BYTES + 1,
			" ",
		);
		writeFileSync(join(dataDir, "sync-state.json"), oversized);

		const [line] = await quiet(() =>
			compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 }),
		);
		const parsed = JSON.parse(nonNull(line));
		expect(parsed.compacted).toBe(false);
		expect(parsed.synced_bytes).toBe(0);
		expect(parsed.reason).toBe("no synced data yet — pass --all to compact a local-only log");
	});

	it("a non-string cwd option is ignored in favor of process.cwd() (never passed straight through)", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			// opts.cwd is a NUMBER, not a string. If it were used directly, getDataDir's
			// internal path.join would throw (join() rejects non-string arguments); the
			// typeof guard exists precisely to fall back to process.cwd() instead.
			await compactCommand({ cwd: 42, json: true, keepRecentBytes: 20 });
		} finally {
			cwdSpy.mockRestore();
		}
		// Compacted the MOCKED process.cwd() dir, proving the numeric opts.cwd was ignored.
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
	});

	it("omitting keepRecentBytes falls back to the DEFAULT_KEEP_RECENT_BYTES (2MB) constant, not undefined/NaN", async () => {
		const { tempDir, dataDir, content } = writeLog([{ type: "tool_use", i: 1 }]);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// No keepRecentBytes at all — exercises the typeof guard's fallback branch
			// directly (the CLI layer always computes a numeric value itself, so this
			// path is otherwise only reachable by a direct caller).
			await compactCommand({ cwd: tempDir, json: true });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe("log is within the 2.0MB recent-tail kept live");
	});

	it("fileSize - keepRecentBytes landing exactly at zero reports the recent-tail reason (inclusive boundary)", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all so syncedBytes is irrelevant; keepRecentBytes === fileBytes forces
			// `fileSize - keepRecentBytes` to exactly 0, the <=0 / <0 boundary itself.
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes: fileBytes });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.reason).toBe(`log is within the ${(fileBytes / 1024 / 1024).toFixed(1)}MB recent-tail kept live`);
	});

	it("archives exactly up to a record boundary that lands precisely at the keep-recent limit (off-by-one safe)", async () => {
		const records = Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const totalBytes = Buffer.byteLength(content);
		// Independently compute (not via planCut) the byte offset where record #6 begins.
		const cutIndex = 6;
		const prefix = `${records
			.slice(0, cutIndex)
			.map((r) => JSON.stringify(r))
			.join("\n")}\n`;
		const cutOffset = Buffer.byteLength(prefix);
		// keepRecentBytes chosen so `fileSize - keepRecentBytes === cutOffset` EXACTLY —
		// the record-boundary offset lands precisely on the computed limit.
		const keepRecentBytes = totalBytes - cutOffset;

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, all: true, keepRecentBytes });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(true);
		// A boundary offset exactly AT the limit is included (`start <= limit`), so the
		// cut lands exactly at cutOffset — not one record short.
		expect(parsed.archived_bytes).toBe(cutOffset);
		expect(parsed.archived_records).toBe(cutIndex);
		expect(parsed.live_after_bytes).toBe(totalBytes - cutOffset);

		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).toBe(content.slice(cutOffset));
	});

	it("sequential compactions increment the segment seq and reuse the existing archive dir", async () => {
		const records = Array.from({ length: 100 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));

		// First compaction: keep a generous tail live so plenty remains for a 2nd cut.
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 200 });
		const manifestAfter1 = loadArchiveManifest(tempDir);
		expect(manifestAfter1.segments.length).toBe(1);
		expect(manifestAfter1.segments[0]?.seq).toBe(1);
		expect(manifestAfter1.segments[0]?.file).toBe("activity-0001.jsonl.gz");

		// Second compaction on the SAME (now-shrunk) live file + the EXISTING archive dir
		// (mkdirSync must tolerate an already-existing directory — recursive:true).
		const liveAfter1 = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		setSync(dataDir, Buffer.byteLength(liveAfter1));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 10 });
		const manifestAfter2 = loadArchiveManifest(tempDir);
		expect(manifestAfter2.segments.length).toBe(2);
		expect(manifestAfter2.segments[1]?.seq).toBe(2);
		expect(manifestAfter2.segments[1]?.file).toBe("activity-0002.jsonl.gz");
	});

	it("dry-run JSON payload reports exact would_archive_bytes/records, gz_bytes, live_after_bytes, and flags", async () => {
		const records = Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const totalBytes = Buffer.byteLength(content);
		setSync(dataDir, totalBytes);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.dry_run).toBe(true);
		expect(typeof parsed.would_archive_bytes).toBe("number");
		expect(parsed.would_archive_bytes).toBeGreaterThan(0);
		expect(parsed.would_archive_bytes).toBeLessThan(totalBytes);
		expect(parsed.live_after_bytes).toBe(totalBytes - parsed.would_archive_bytes);
		expect(parsed.gz_bytes).toBeGreaterThan(0);
		expect(parsed.gz_bytes).toBeLessThan(parsed.would_archive_bytes);
		expect(parsed.segment).toBe("activity-0001.jsonl.gz");
		// Dry-run truly makes no changes.
		expect(loadArchiveManifest(tempDir).segments.length).toBe(0);
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toBe(content);
	});

	it("dry-run human-readable message shows the exact mb figures and shrink percentage", async () => {
		const records = Array.from({ length: 20 }, (_, i) => ({ type: "tool_use", i }));

		// Probe run: identical fixture, --json, to derive the exact expected figures
		// independently of the human-message template under test.
		const probeFixture = writeLog(records);
		setSync(probeFixture.dataDir, Buffer.byteLength(probeFixture.content));
		const probeOut: string[] = [];
		const probeLog = vi.spyOn(console, "log").mockImplementation((m) => void probeOut.push(String(m)));
		let probe: { would_archive_bytes: number; would_archive_records: number; gz_bytes: number; live_after_bytes: number; segment: string };
		try {
			await compactCommand({ cwd: probeFixture.tempDir, json: true, dryRun: true, keepRecentBytes: 20 });
			probe = JSON.parse(nonNull(probeOut[0]));
		} finally {
			probeLog.mockRestore();
		}

		// Real run: identical fixture, human-readable mode.
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir, dryRun: true, keepRecentBytes: 20 });
		} finally {
			log.mockRestore();
		}
		const msg = nonNull(out[0]);
		expect(msg).toContain("Dry run");
		expect(msg).toContain(`would archive ${(probe.would_archive_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`(${probe.would_archive_records} records)`);
		expect(msg).toContain(probe.segment);
		expect(msg).toContain(`gzipped: ${(probe.gz_bytes / 1024 / 1024).toFixed(1)}MB`);
		expect(msg).toContain(`${Math.round((1 - probe.gz_bytes / probe.would_archive_bytes) * 100)}% smaller`);
		expect(msg).toContain(`live activity.jsonl after: ${(probe.live_after_bytes / 1024 / 1024).toFixed(1)}MB`);
	});

	it("prints a human-readable 'nothing to compact' message (not JSON) when activity.jsonl is absent", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-"));
		mkdirSync(join(tempDir, ".interlinked"), { recursive: true });
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			await compactCommand({ cwd: tempDir });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		expect(() => JSON.parse(nonNull(out[0]))).toThrow();
		expect(out[0]).toContain("Nothing to compact");
		expect(out[0]).toContain("no activity.jsonl");
	});

	it("prints a human-readable 'nothing safely compactable' message with mb-formatted file/synced sizes", async () => {
		const records = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, content } = writeLog(records);
		const fileBytes = Buffer.byteLength(content);
		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		try {
			// --all + a huge keepRecentBytes so nothing is archivable; no sync-state
			// written at all, so synced_bytes stays 0.
			await compactCommand({ cwd: tempDir, all: true, keepRecentBytes: fileBytes + 10_000 });
		} finally {
			log.mockRestore();
		}
		expect(out).toHaveLength(1);
		expect(() => JSON.parse(nonNull(out[0]))).toThrow();
		expect(out[0]).toContain("Nothing safely compactable");
		expect(out[0]).toContain(`log ${(fileBytes / 1024 / 1024).toFixed(1)}MB, synced 0.0MB`);
	});
});

describe("loadArchiveManifest — malformed manifest handling", () => {
	function withManifest(raw: string): string {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-manifest-"));
		const archiveDir = join(tempDir, ".interlinked", "archive");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "manifest.json"), raw);
		return tempDir;
	}

	it("falls back to an empty manifest when manifest.json is not valid JSON (parse error)", () => {
		const tempDir = withManifest("{not valid json");
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("falls back to an empty manifest when manifest.json parses but has no segments array", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1 }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("falls back to an empty manifest when manifest.json is valid JSON `null`", () => {
		const tempDir = withManifest("null");
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("refuses to materialize an archive manifest beyond the bounded reader limit", () => {
		const tempDir = withManifest("{}");
		const path = join(tempDir, ".interlinked", "archive", "manifest.json");
		truncateSync(path, MAX_ARCHIVE_MANIFEST_BYTES + 1);
		expect(() => readArchiveManifestJson(path)).toThrow(
			`limit ${MAX_ARCHIVE_MANIFEST_BYTES}`,
		);
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	// --- parseArchiveManifest / parseArchiveSegment boundary parser ---

	const VALID_SEGMENT = {
		seq: 1,
		file: "activity-0001.jsonl.gz",
		bytes: 1000,
		gz_bytes: 200,
		records: 30,
		created_at: "2026-08-01T00:00:00Z",
	};

	it("P1: accepts a well-formed manifest with a fully-shaped segment", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [VALID_SEGMENT] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [VALID_SEGMENT] });
	});

	it("N1: a single malformed segment (wrong-typed field) invalidates the whole manifest", () => {
		// manifest.json has exactly one in-repo writer (compactCommand itself),
		// unlike the multi-writer activity/collection logs — a shape mismatch
		// here is corruption, not a legitimately-optional legacy field, so it
		// falls back to empty rather than silently serving a partial segment
		// list to `audit verify` (which reads segments in manifest order).
		const badSegment = { ...VALID_SEGMENT, bytes: "not-a-number" };
		const tempDir = withManifest(
			JSON.stringify({ version: 1, segments: [VALID_SEGMENT, badSegment] }),
		);
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N2: a segments array containing a non-object entry invalidates the whole manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: ["not-an-object"] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N3: segments being a non-array (a plain object) still yields an empty manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: {} }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N4: a segments array containing null still yields an empty manifest", () => {
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [null] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("rejects an unknown manifest version instead of interpreting it as v1", () => {
		const tempDir = withManifest(JSON.stringify({ version: 2, segments: [VALID_SEGMENT] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("rejects segment paths and prefixes outside the activity archive namespace", () => {
		for (const file of ["../activity-0001.jsonl.gz", "collection-0001.jsonl.gz"]) {
			const tempDir = withManifest(
				JSON.stringify({ version: 1, segments: [{ ...VALID_SEGMENT, file }] }),
			);
			expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
		}
	});

	it("rejects a segment whose filename sequence contradicts its row", () => {
		const bad = { ...VALID_SEGMENT, file: "activity-0002.jsonl.gz" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("rejects negative or fractional segment counters", () => {
		for (const bad of [
			{ ...VALID_SEGMENT, bytes: -1 },
			{ ...VALID_SEGMENT, records: 1.5 },
		]) {
			const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
			expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
		}
	});

	// --- per-field type-guard MC/DC: each field wrong in isolation, all others valid,
	// so a disabled/weakened check on ONE field can't hide behind another field's check
	// catching the same malformed segment for a different reason. ---

	it("N5: seq wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, seq: "1" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N6: file wrong type (not a string) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, file: 123 };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N7: bytes wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, bytes: "1000" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N8: gz_bytes wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, gz_bytes: "200" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N9: records wrong type (not a number) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, records: "30" };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});

	it("N10: created_at wrong type (not a string) alone invalidates the segment", () => {
		const bad = { ...VALID_SEGMENT, created_at: 20260801 };
		const tempDir = withManifest(JSON.stringify({ version: 1, segments: [bad] }));
		expect(loadArchiveManifest(tempDir)).toEqual({ version: 1, segments: [] });
	});
});

describe("planCut — hash-chain line classification boundary parser", () => {
	it("P1: a well-formed chained record (string type + string hash) blocks archiving past it", async () => {
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: "a".repeat(64), previousHash: "0".repeat(64) },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toContain("guard_allow");
	});

	it("N1: a line with hash present but NOT a string is not treated as chained", async () => {
		// A malformed "type": "guard_allow" line whose hash is a number rather
		// than a string must not pin lastChainedStart — the isJsonObject +
		// typeof guards must keep behaving exactly like the pre-fix
		// `as { type?: unknown; hash?: unknown }` cast's own typeof checks did.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "guard_allow", hash: 12345 }, // hash is a number, not a string
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		// Nothing pins lastChainedStart, so the malformed line itself can be
		// archived away — it does not survive as the mid-log chain anchor.
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain('"hash":12345');
	});

	it("N2: a numeric 'type' field is not treated as chained even with a valid-looking hash", async () => {
		// isJsonObject(rec) is true and hash is a real string — only the
		// `typeof rec.type === "string"` clause should be what rejects this line.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: 999, hash: "e".repeat(64), marker: "weird-numeric-type" },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain("weird-numeric-type");
	});

	it("N3: a valid string 'type' outside CHAINED_TYPES is not treated as chained even with a valid hash", async () => {
		// isJsonObject(rec), typeof rec.type === "string", and typeof rec.hash ===
		// "string" are ALL true here — only `CHAINED_TYPES.has(rec.type)` rejects it.
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			{ type: "custom_event", hash: "f".repeat(64), marker: "weird-custom-type" },
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(live).not.toContain("weird-custom-type");
	});

	it("P2: each of the other three CHAINED_TYPES members (guard_block, guard_warn, session_end) blocks archiving past it", async () => {
		for (const chainedType of ["guard_block", "guard_warn", "session_end"]) {
			const records = [
				...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
				{ type: chainedType, hash: "a".repeat(64) },
				...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
			];
			const { tempDir, dataDir, content } = writeLog(records);
			setSync(dataDir, Buffer.byteLength(content));
			await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
			const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
			expect(live).toContain(`"type":"${chainedType}"`);
		}
	});
});

describe("registerCompactCommand — CLI wiring", () => {
	it("parses --keep-recent-mb and --json and drives a real compaction through the commander action", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-cli-"));
		const dataDir = join(tempDir, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const content = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
		writeFileSync(join(dataDir, "activity.jsonl"), content);
		writeFileSync(
			join(dataDir, "sync-state.json"),
			JSON.stringify({ synced_through_bytes: Buffer.byteLength(content) }),
		);

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		// SPY, not process.chdir(): chdir THROWS in a worker thread
		// ("process.chdir() is not supported in workers"), and Stryker's vitest
		// runner pins a worker-thread pool.
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			const program = new Command();
			program.exitOverride();
			registerCompactCommand(program);
			// A tiny --keep-recent-mb (in MB) converts to a small byte count, so the
			// 30-record fixture is comfortably archivable.
			await program.parseAsync(["node", "interlinked", "compact", "--keep-recent-mb", "0.00001", "--json"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}

		expect(out).toHaveLength(1);
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(true);
		expect(loadArchiveManifest(tempDir).segments.length).toBe(1);
	});

	it("runs with the default 2MB keep-recent-mb and reports nothing-to-compact for a tiny file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-cli-default-"));
		const dataDir = join(tempDir, ".interlinked");
		mkdirSync(dataDir, { recursive: true });
		const content = '{"type":"tool_use","i":1}\n';
		writeFileSync(join(dataDir, "activity.jsonl"), content);
		writeFileSync(
			join(dataDir, "sync-state.json"),
			JSON.stringify({ synced_through_bytes: Buffer.byteLength(content) }),
		);

		const out: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
		const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tempDir));
		try {
			const program = new Command();
			program.exitOverride();
			registerCompactCommand(program);
			await program.parseAsync(["node", "interlinked", "compact", "--json"]);
		} finally {
			cwdSpy.mockRestore();
			log.mockRestore();
		}

		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		// Default 2MB keep-recent-mb dwarfs this tiny fixture.
		expect(parsed.reason).toBe("log is within the 2.0MB recent-tail kept live");
	});

	it("registers --dry-run, --keep-recent-mb, --all, --json with their documented descriptions", () => {
		const program = new Command();
		registerCompactCommand(program);
		const cmd = nonNull(program.commands.find((command) => command.name() === "compact"));
		expect(cmd.description()).toBe(
			"Gzip + archive the synced prefix of activity.jsonl plus the collection/timeline logs (lossless), reclaiming disk",
		);
		const flags = new Map(cmd.options.map((o) => [o.long, o.description]));
		expect(flags.get("--dry-run")).toBe("Show what would be archived without changing anything");
		expect(flags.get("--keep-recent-mb")).toBe("Keep at least this many MB of recent log live");
		expect(flags.get("--all")).toBe(
			"Archive past the recent tail even when un-synced (local-only / disk recovery; archived events won't be sent to the server)",
		);
		expect(flags.get("--json")).toBe("Machine-readable output");
	});
});

// ---------------------------------------------------------------------------
// Corrupt-index recovery for the ACTIVITY archive.
//
// This archive is the one with a real product reader: `interlinked audit
// verify` walks manifest.json to find the segments the hash chain spans
// (src/lib/audit-chain.ts::iterateArchivedAuditLines). A segment missing from
// the index is therefore evidence the verifier never reads.
//
// The two halves of that story are deliberately opposite, and BOTH are pinned
// below: the WRITER rebuilds a lost index from the segment filenames so the
// next compaction cannot orphan older segments, while the VERIFIER keeps
// failing closed on a manifest it cannot read (ManifestReadError) — it is never
// allowed to reconstruct its own evidence list. Recovery restores the pointers
// so the verifier can read the segments again; it never asserts they are
// intact. `P4` below verifies AFTER a successful recovery-write, when the
// manifest on disk is valid again.
// ---------------------------------------------------------------------------

const plainRecords = (from: number, n: number): object[] =>
	Array.from({ length: n }, (_, i) => ({ type: "tool_use", i: from + i }));

/** A log holding three real hash-chain links separated by plain records, plus
 *  the byte offset just past the FIRST link (where compaction #1 cuts). */
function chainedLog(): { tempDir: string; dataDir: string; content: string; afterLink1: number } {
	const l1 = { type: "guard_allow", previousHash: GENESIS_HASH, n: 1 };
	const link1 = { ...l1, hash: computeEntryHash(l1) };
	const l2 = { type: "guard_allow", previousHash: link1.hash, n: 2 };
	const link2 = { ...l2, hash: computeEntryHash(l2) };
	const l3 = { type: "guard_allow", previousHash: link2.hash, n: 3, last: true };
	const link3 = { ...l3, hash: computeEntryHash(l3) };
	const records = [
		...plainRecords(0, 6),
		link1,
		...plainRecords(10, 6),
		link2,
		...plainRecords(20, 6),
		link3,
		...plainRecords(30, 2),
	];
	const { tempDir, dataDir, content } = writeLog(records);
	const throughLink1 = `${records
		.slice(0, 7)
		.map((r) => JSON.stringify(r))
		.join("\n")}\n`;
	return { tempDir, dataDir, content, afterLink1: Buffer.byteLength(throughLink1) };
}

interface LostIndexFixture {
	tempDir: string;
	dataDir: string;
	content: string;
	seg1Path: string;
	seg1Before: Buffer;
}

/**
 * The reviewer's reproduction: compact once (segment 1 = through link1), lose
 * the index while every segment survives on disk, compact again.
 */
async function compactWithLostIndex(): Promise<LostIndexFixture> {
	const { tempDir, dataDir, content, afterLink1 } = chainedLog();
	const total = Buffer.byteLength(content);
	setSync(dataDir, total);
	// keepRecentBytes chosen so the cut lands exactly on the boundary after link1.
	await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: total - afterLink1 }));

	const seg1Path = join(dataDir, "archive", "activity-0001.jsonl.gz");
	const seg1Before = readFileSync(seg1Path);
	expect(gunzipSync(seg1Before).toString("utf-8")).toBe(content.slice(0, afterLink1));

	// The INDEX is destroyed (a truncated write, a crashed writer, disk
	// corruption) while every segment file survives untouched.
	writeFileSync(join(dataDir, "archive", "manifest.json"), "{not valid json");

	const liveAfter1 = readFileSync(join(dataDir, "activity.jsonl"));
	setSync(dataDir, liveAfter1.length);
	await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 }));
	return { tempDir, dataDir, content, seg1Path, seg1Before };
}

describe("activity archive — corrupt-index recovery (writer side)", () => {
	it("P1: rebuilds the lost index — the manifest ends up indexing BOTH the old and the new segment", async () => {
		const { tempDir } = await compactWithLostIndex();
		const manifest = loadArchiveManifest(tempDir);
		// Pre-fix this was [2]: the corrupt manifest degraded to an EMPTY segment
		// list, so the manifest written after the second compaction listed only
		// the segment that compaction had just created. activity-0001.jsonl.gz
		// stayed on disk with no pointer to it.
		expect(manifest.segments.map((s) => s.seq)).toEqual([1, 2]);
		expect(manifest.segments.map((s) => s.file)).toEqual([
			"activity-0001.jsonl.gz",
			"activity-0002.jsonl.gz",
		]);
	});

	it("P2: flags the reconstructed row `recovered` with zeroed counts, never fabricated ones", async () => {
		const { tempDir, seg1Path } = await compactWithLostIndex();
		const manifest = loadArchiveManifest(tempDir);
		const recovered = nonNull(manifest.segments[0]);
		expect(recovered.recovered).toBe(true);
		// bytes / records / created_at lived ONLY in the lost index — a reader must
		// be able to tell a placeholder from a measurement.
		expect(recovered.bytes).toBe(0);
		expect(recovered.records).toBe(0);
		expect(recovered.created_at).toBe("");
		// gz_bytes is the one figure the disk still holds, so it is measured.
		expect(recovered.gz_bytes).toBe(statSync(seg1Path).size);

		const fresh = nonNull(manifest.segments[1]);
		expect(fresh.recovered).toBeUndefined();
		expect(fresh.bytes).toBeGreaterThan(0);
		expect(fresh.records).toBeGreaterThan(0);
	});

	it("P3: leaves the pre-existing segment byte-identical and the whole archive lossless in index order", async () => {
		const { tempDir, dataDir, content, seg1Path, seg1Before } = await compactWithLostIndex();
		expect(readFileSync(seg1Path).equals(seg1Before)).toBe(true);

		// Reading the segments in MANIFEST order plus the live tail must reproduce
		// the original log byte-for-byte — the recovered row is in the right place,
		// and nothing between the two segments went missing.
		const manifest = loadArchiveManifest(tempDir);
		const archived = manifest.segments
			.map((s) => gunzipSync(readFileSync(join(dataDir, "archive", s.file))).toString("utf-8"))
			.join("");
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		expect(archived + live).toBe(content);
	});

	it("P4: `audit verify` still walks the full hash chain across the recovered segment", async () => {
		const { tempDir } = await compactWithLostIndex();
		// Pre-fix: the manifest listed only segment 2, so verification started at
		// link2, whose previousHash is neither GENESIS nor the (never-read) link1
		// hash — a previousHash mismatch. The archive's first link had become
		// invisible evidence.
		const result = verifyAuditChain(tempDir);
		expect(result.first_bad_reason).toBeUndefined();
		expect(result.valid).toBe(true);
		expect(result.chained_events).toBe(3);
	});

	it("N1: an ABSENT manifest still means 'never compacted' — a stray segment is not recovered", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content));
		mkdirSync(join(dataDir, "archive"), { recursive: true });
		writeFileSync(join(dataDir, "archive", "activity-0007.jsonl.gz"), Buffer.from("stray"));
		// No manifest.json at all: nothing was ever indexed, so nothing is recovered.
		expect(loadOrRebuildArchiveManifest(tempDir).segments).toEqual([]);

		await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 }));

		const manifest = loadArchiveManifest(tempDir);
		expect(manifest.segments.map((s) => s.seq)).toEqual([8]);
		expect(manifest.segments.some((s) => s.recovered === true)).toBe(false);
	});

	it("N2: rebuilds only from ACTIVITY segment filenames — foreign files in the archive dir are ignored", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "interlinked-compact-rebuild-"));
		const archiveDir = join(tempDir, ".interlinked", "archive");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(join(archiveDir, "manifest.json"), "{not valid json");
		writeFileSync(join(archiveDir, "activity-0002.jsonl.gz"), Buffer.from("two"));
		writeFileSync(join(archiveDir, "activity-0001.jsonl.gz"), Buffer.from("one"));
		// The plain-log namespace must NOT be pulled in: audit verify gunzips every
		// segment manifest.json lists, so a collection segment there would make it
		// read the whole tool-event history as if it were chain evidence.
		writeFileSync(join(archiveDir, "collection-0001.jsonl.gz"), Buffer.from("nope"));
		writeFileSync(join(archiveDir, "activity-12.jsonl.gz"), Buffer.from("nope"));
		writeFileSync(join(archiveDir, "notes.txt"), Buffer.from("nope"));

		const manifest = loadOrRebuildArchiveManifest(tempDir);
		// Sorted by sequence, which is the order the verifier reads them in.
		expect(manifest.segments.map((s) => s.file)).toEqual([
			"activity-0001.jsonl.gz",
			"activity-0002.jsonl.gz",
		]);
		expect(manifest.segments.every((s) => s.recovered === true)).toBe(true);
	});
});

describe("activity archive — exclusive segment claim + write order", () => {
	interface RacedFixture {
		dataDir: string;
		content: string;
		total: number;
		out: string[];
	}

	/** Compact while a concurrent compactor claims activity-0001.jsonl.gz first. */
	async function racedCompaction(): Promise<RacedFixture> {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total);
		race.segment = "activity-0001.jsonl.gz";
		const out = await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 }));
		return { dataDir, content, total, out };
	}

	it("P1: refuses the claim and reports it, instead of replacing the rival's segment", async () => {
		const { dataDir, out } = await racedCompaction();
		const parsed = JSON.parse(nonNull(out[0]));
		expect(parsed.compacted).toBe(false);
		expect(parsed.segment).toBe("activity-0001.jsonl.gz");
		expect(parsed.reason).toContain("does not match its durable rotation claim");
		// Pre-fix the write was tmp → rename, which overwrites: the rival's
		// archived records were destroyed and the run reported success.
		const onDisk = readFileSync(join(dataDir, "archive", "activity-0001.jsonl.gz"));
		expect(onDisk.equals(race.content)).toBe(true);
	});

	it("P2: leaves the live log, the sync cursor and the index untouched when the claim is refused", async () => {
		const { dataDir, content, total } = await racedCompaction();
		// Destruction must never outrun a durable pointer to the archived bytes.
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf-8")).toBe(content);
		const sync = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf-8"));
		expect(sync.synced_through_bytes).toBe(total);
		expect(existsSync(join(dataDir, "archive", "manifest.json"))).toBe(false);
	});

	it("P3: claims the segment and publishes the index BEFORE the live prefix is dropped", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total);

		race.writes.length = 0;
		await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 }));

		// Observed call order, not a reading of the source.
		const segmentAt = race.writes.indexOf("activity-0001.jsonl.gz");
		const manifestAt = race.writes.findIndex((w) => w.startsWith("manifest.json"));
		const liveAt = race.writes.findIndex((w) => w === "activity.jsonl");
		expect(segmentAt).toBeGreaterThanOrEqual(0); // hard-linked only after gzip completion
		expect(manifestAt).toBeGreaterThanOrEqual(0);
		expect(liveAt).toBeGreaterThanOrEqual(0);
		// Pre-fix the order was segment.tmp → live → cursor → manifest, so a crash
		// after the truncate lost the live bytes while the segment was unindexed.
		expect(segmentAt).toBeLessThan(manifestAt);
		expect(manifestAt).toBeLessThan(liveAt);

		// End state is still a correct, lossless compaction.
		const manifest = loadArchiveManifest(tempDir);
		expect(manifest.segments.map((s) => s.file)).toEqual(["activity-0001.jsonl.gz"]);
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		const archived = gunzipSync(readFileSync(join(dataDir, "archive", "activity-0001.jsonl.gz"))).toString("utf-8");
		expect(archived + live).toBe(content);
		expect(Buffer.byteLength(live)).toBeLessThan(total);
	});

	it("P: retry adopts a final segment published before a manifest-write crash", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(join(archiveDir, "manifest.json.tmp"), { recursive: true });

		await expect(
			quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 })),
		).rejects.toThrow();
		const segmentPath = join(archiveDir, "activity-0001.jsonl.gz");
		expect(existsSync(segmentPath)).toBe(true);
		expect(existsSync(join(archiveDir, "manifest.json"))).toBe(false);
		expect(readFileSync(join(dataDir, "activity.jsonl"), "utf8")).toBe(content);

		const late = `${JSON.stringify({ type: "tool_use", late: true })}\n`;
		appendFileSync(join(dataDir, "activity.jsonl"), late);
		rmSync(join(archiveDir, "manifest.json.tmp"), { recursive: true });
		await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 }));

		const gzipFiles = readdirSync(archiveDir).filter((name) => /^activity-\d{4}\.jsonl\.gz$/.test(name));
		expect(gzipFiles).toEqual(["activity-0001.jsonl.gz"]);
		expect(loadArchiveManifest(tempDir).segments.map((entry) => entry.file)).toEqual(gzipFiles);
		const reassembled = Buffer.concat([
			gunzipSync(readFileSync(segmentPath)),
			readFileSync(join(dataDir, "activity.jsonl")),
		]);
		expect(reassembled.toString("utf8")).toBe(content + late);

		await quiet(() =>
			compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1024 * 1024 }),
		);
		expect(readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl.gz"))).toEqual(gzipFiles);
		expect(loadArchiveManifest(tempDir).segments.map((entry) => entry.file)).toEqual(gzipFiles);
	});

	it("P4: the sync cursor is lowered before the truncate, so a crash re-sends rather than skips", async () => {
		const records = Array.from({ length: 30 }, (_, i) => ({ type: "tool_use", i }));
		const { tempDir, dataDir, content } = writeLog(records);
		const total = Buffer.byteLength(content);
		setSync(dataDir, total);

		race.writes.length = 0;
		const out = await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 20 }));

		const cursorAt = race.writes.findIndex((w) => w.startsWith("sync-state.json"));
		const liveAt = race.writes.findIndex((w) => w === "activity.jsonl");
		expect(cursorAt).toBeGreaterThanOrEqual(0);
		// A cursor left too HIGH over an already-shortened live file skips unsent
		// records; too low only re-sends. So it must move first.
		expect(cursorAt).toBeLessThan(liveAt);

		const parsed = JSON.parse(nonNull(out[0]));
		const sync = JSON.parse(readFileSync(join(dataDir, "sync-state.json"), "utf-8"));
		expect(sync.synced_through_bytes).toBe(total - parsed.archived_bytes);
	});
});

describe("readActivitySyncState — malformed sync-state.json handling", () => {
	it("a sync-state.json that fails JSON.parse is treated as nothing synced (fail safe), not an uncaught throw", async () => {
		// Size is well under MAX_SYNC_STATE_BYTES, so this exercises the
		// try/catch around JSON.parse itself, not the oversized-file guard
		// (already covered separately) or the isJsonObject/typeof branches
		// (also covered separately, both of which need VALID JSON).
		const { tempDir, dataDir } = writeLog(Array.from({ length: 10 }, (_, i) => ({ type: "tool_use", i })));
		writeFileSync(join(dataDir, "sync-state.json"), "{not valid json");

		const [line] = await quiet(() => compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 }));
		const parsed = JSON.parse(nonNull(line));
		expect(parsed.compacted).toBe(false);
		expect(parsed.synced_bytes).toBe(0);
		expect(parsed.reason).toBe("no synced data yet — pass --all to compact a local-only log");
	});
});

describe("planCut — an oversized line pins the chain anchor without needing to parse it", () => {
	it("an over-4MB single line is treated as a possible chain link, so archiving cannot pass its start", async () => {
		// A row this large can't be safely parsed for its `type`/`hash` fields,
		// so `line.oversized` (not `CHAINED_TYPES`) is what pins lastChainedStart
		// here — the JSON.parse branch below it never runs for this line.
		const oversizedRecord = {
			type: "tool_use",
			marker: "oversize-anchor",
			pad: "x".repeat(4 * 1024 * 1024 + 1024),
		};
		const records = [
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i })),
			oversizedRecord,
			...Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", i: 100 + i })),
		];
		const { tempDir, dataDir, content } = writeLog(records);
		setSync(dataDir, Buffer.byteLength(content)); // everything synced
		await compactCommand({ cwd: tempDir, json: true, keepRecentBytes: 1 });
		const live = readFileSync(join(dataDir, "activity.jsonl"), "utf-8");
		// The oversized record itself, and everything after it, stayed live —
		// the cut could not advance past its start byte.
		expect(live).toContain("oversize-anchor");
		expect(live).toContain('"i":104');
	});
});

describe("emitPlainResult — human-readable output for a plain log with nothing to compact", () => {
	it("prints a dim 'nothing compactable' line naming the actual reason, not the silent 'no <log>.jsonl' path", async () => {
		const { tempDir, dataDir } = writeLog([{ type: "tool_use", i: 1 }]);
		// collection.jsonl exists but is far smaller than DEFAULT_KEEP_RECENT_BYTES
		// (2MB), so compactPlainLog returns compacted:false, archived_bytes:0,
		// reason "log is within the ...MB recent-tail kept live" — NOT the
		// "no collection.jsonl" reason emitPlainResult filters out up front.
		writeFileSync(join(dataDir, "collection.jsonl"), `${JSON.stringify({ type: "tool_result" })}\n`);

		const out = await quiet(() => compactCommand({ cwd: tempDir, json: false }));
		const line = out.find((l) => l.includes("collection.jsonl"));
		expect(line).toBeDefined();
		expect(nonNull(line)).toContain("collection.jsonl: nothing compactable — log is within the 2.0MB recent-tail kept live");
	});
});
