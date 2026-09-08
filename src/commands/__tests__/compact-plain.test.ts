// Tests for the plain-log compactor (collection.jsonl / timeline.jsonl).
// These logs have no sync cursor and no audit hash chain, so the invariants
// under test are: line-aligned cuts, recent-tail preservation, losslessness
// (archive + live tail reassemble the original bytes), per-log manifests that
// never touch the activity manifest.json, and idempotent re-runs.

import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactPlainLog, loadPlainManifest } from "../compact-plain.js";
import { createRotationClaim, rotationClaimPath } from "../compact-rotation-claim.js";
import { sha256File } from "../../lib/bounded-file-io.js";
import { fileIdentity } from "../../lib/file-suffix-replacement.js";

let cwd: string;
let dataDir: string;

function writeLog(name: string, lines: string[]): string {
	const path = join(dataDir, `${name}.jsonl`);
	writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
	return path;
}

function jsonLine(i: number): string {
	return JSON.stringify({ seq: i, kind: "tool_event", payload: "x".repeat(64) });
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "compact-plain-"));
	dataDir = join(cwd, ".interlinked");
	mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("compactPlainLog — positive (must fire)", () => {
	it("P1: archives the prefix, keeps the recent tail live, and is lossless", () => {
		const lines = Array.from({ length: 100 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);

		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 512 });

		expect(res.compacted).toBe(true);
		expect(res.archived_bytes).toBeGreaterThan(0);
		expect(res.live_after_bytes).toBeGreaterThanOrEqual(512);
		const segPath = join(dataDir, "archive", res.segment ?? "");
		const reassembled = Buffer.concat([gunzipSync(readFileSync(segPath)), readFileSync(logPath)]);
		expect(reassembled.equals(original)).toBe(true);
	});

	it("P2: cut lands on a record boundary (live file starts with a full JSON line)", () => {
		writeLog("collection", Array.from({ length: 50 }, (_, i) => jsonLine(i)));
		compactPlainLog("collection", { cwd, keepRecentBytes: 256 });
		const firstLive = readFileSync(join(dataDir, "collection.jsonl"), "utf-8").split("\n")[0] ?? "";
		expect(() => JSON.parse(firstLive)).not.toThrow();
		// Pins the actual cut point: a no-op (or off-by-one) cut would still
		// parse as valid JSON but would not start at record 47.
		expect(JSON.parse(firstLive)).toHaveProperty(["seq"], 47);
	});

	it("P3: writes a per-log manifest and never creates the activity manifest.json", () => {
		writeLog("timeline", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("timeline", { cwd, keepRecentBytes: 128 });
		expect(res.segment).toMatch(/^timeline-0001\.jsonl\.gz$/);
		const manifest = loadPlainManifest("timeline", cwd);
		expect(manifest.segments).toHaveLength(1);
		expect(manifest.segments[0]?.bytes).toBe(res.archived_bytes);
		expect(existsSync(join(dataDir, "archive", "manifest.json"))).toBe(false);
	});

	it("P4: sequential runs append segments with increasing seq", () => {
		writeLog("collection", Array.from({ length: 80 }, (_, i) => jsonLine(i)));
		const first = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		// regrow the log, then compact again
		const more = Array.from({ length: 80 }, (_, i) => jsonLine(1000 + i));
		writeFileSync(
			join(dataDir, "collection.jsonl"),
			readFileSync(join(dataDir, "collection.jsonl"), "utf-8") + more.map((l) => `${l}\n`).join(""),
		);
		const second = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(first.segment).toBe("collection-0001.jsonl.gz");
		expect(second.segment).toBe("collection-0002.jsonl.gz");
		expect(loadPlainManifest("collection", cwd).segments.map((s) => s.seq)).toEqual([1, 2]);
	});

	it("P5: dry run reports the plan but writes nothing", () => {
		const logPath = writeLog("collection", Array.from({ length: 50 }, (_, i) => jsonLine(i)));
		const before = readFileSync(logPath);
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128, dryRun: true });
		expect(res.compacted).toBe(false);
		expect(res.archived_bytes).toBeGreaterThan(0);
		expect(readFileSync(logPath).equals(before)).toBe(true);
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});

	it("preserves a private log mode on both the archive and live suffix", () => {
		const logPath = writeLog("collection", Array.from({ length: 50 }, (_, i) => jsonLine(i)));
		chmodSync(logPath, 0o600);

		const result = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		if (!result.segment) throw new Error("expected a compacted segment");

		expect(statSync(logPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(dataDir, "archive", result.segment)).mode & 0o777).toBe(0o600);
	});

	it("preserves an append injected after the retained-tail snapshot and before rename", () => {
		const lines = Array.from({ length: 100 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const racing = `${jsonLine(9999)}\n`;
		const original = readFileSync(logPath);

		const res = compactPlainLog("collection", {
			cwd,
			keepRecentBytes: 512,
			afterInitialCopy: () => appendFileSync(logPath, racing),
		});

		const archive = gunzipSync(readFileSync(join(dataDir, "archive", res.segment ?? "")));
		const reassembled = Buffer.concat([archive, readFileSync(logPath)]);
		expect(reassembled.equals(Buffer.concat([original, Buffer.from(racing)]))).toBe(true);
	});

	it("recovers an indexed-but-untruncated prefix without archiving it twice", () => {
		const lines = Array.from({ length: 80 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		const cut = Buffer.byteLength(`${lines.slice(0, 50).join("\n")}\n`);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const segmentFile = "collection-0001.jsonl.gz";
		const gz = gzipSync(original.subarray(0, cut));
		writeFileSync(join(archiveDir, segmentFile), gz);
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, original.subarray(cut));
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: segmentFile,
					bytes: cut,
					gz_bytes: gz.length,
					records: 50,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: cut,
						source: fileIdentity(logPath),
						replacement: fileIdentity(replacementProbe),
					},
				}],
			}),
		);

		const recovered = compactPlainLog("collection", { cwd, keepRecentBytes: 512 });
		expect(recovered.segment).toBe(segmentFile);
		expect(loadPlainManifest("collection", cwd).segments).toHaveLength(1);
		expect(loadPlainManifest("collection", cwd).segments[0]?.pending_live_drop).toBeUndefined();
		const reassembled = Buffer.concat([gunzipSync(readFileSync(join(archiveDir, segmentFile))), readFileSync(logPath)]);
		expect(reassembled.equals(original)).toBe(true);
	});

	it("recovers a final segment published before the manifest and never duplicates its prefix", () => {
		const lines = Array.from({ length: 80 }, (_, i) => jsonLine(i));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(join(archiveDir, "manifest-collection.json.tmp"), { recursive: true });

		expect(() => compactPlainLog("collection", { cwd, keepRecentBytes: 128 })).toThrow();
		const segmentPath = join(archiveDir, "collection-0001.jsonl.gz");
		expect(existsSync(segmentPath)).toBe(true);
		expect(existsSync(join(archiveDir, "manifest-collection.json"))).toBe(false);
		expect(readFileSync(logPath).equals(original)).toBe(true);

		const late = Buffer.from(`${jsonLine(9999)}\n`);
		appendFileSync(logPath, late);
		rmSync(join(archiveDir, "manifest-collection.json.tmp"), { recursive: true });
		const recovered = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(recovered.segment).toBe("collection-0001.jsonl.gz");
		const gzipFiles = readdirSync(archiveDir).filter((name) => /^collection-\d{4}\.jsonl\.gz$/.test(name));
		expect(gzipFiles).toEqual(["collection-0001.jsonl.gz"]);
		expect(loadPlainManifest("collection", cwd).segments.map((entry) => entry.file)).toEqual(gzipFiles);
		const reassembled = Buffer.concat([gunzipSync(readFileSync(segmentPath)), readFileSync(logPath)]);
		expect(reassembled.equals(Buffer.concat([original, late]))).toBe(true);

		compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 });
		expect(readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl.gz"))).toEqual(gzipFiles);
		expect(loadPlainManifest("collection", cwd).segments.map((entry) => entry.file)).toEqual(gzipFiles);
	});
});

describe("compactCommand integration — positive (must fire)", () => {
	it("P6: `interlinked compact` rotates collection.jsonl and timeline.jsonl alongside activity", async () => {
		const { compactCommand } = await import("../compact.js");
		writeLog("collection", Array.from({ length: 80 }, (_, i) => jsonLine(i)));
		writeLog("timeline", Array.from({ length: 80 }, (_, i) => jsonLine(i)));
		await compactCommand({ cwd, json: true, keepRecentBytes: 256 });
		expect(loadPlainManifest("collection", cwd).segments).toHaveLength(1);
		expect(loadPlainManifest("timeline", cwd).segments).toHaveLength(1);
		expect(existsSync(join(dataDir, "archive", "collection-0001.jsonl.gz"))).toBe(true);
		expect(existsSync(join(dataDir, "archive", "timeline-0001.jsonl.gz"))).toBe(true);
	});

	it("P7: command dry run reports the would-archive plan for plain logs, not 'nothing compactable'", async () => {
		const { compactCommand } = await import("../compact.js");
		writeLog("collection", Array.from({ length: 80 }, (_, i) => jsonLine(i)));
		const out: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void out.push(String(m)));
		try {
			await compactCommand({ cwd, dryRun: true, keepRecentBytes: 256 });
		} finally {
			spy.mockRestore();
		}
		const plainLines = out.filter((l) => l.includes("collection.jsonl"));
		expect(plainLines.join("\n")).toContain("would archive");
		expect(plainLines.join("\n")).not.toContain("nothing compactable");
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});
});

describe("compactPlainLog — negative (must not fire)", () => {
	it("N1: missing log file → skipped with reason, nothing written", () => {
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(res.compacted).toBe(false);
		expect(res.reason).toContain("no collection.jsonl");
		expect(existsSync(join(dataDir, "archive"))).toBe(false);
	});

	it("N2: log smaller than the recent-tail floor → untouched", () => {
		const logPath = writeLog("collection", [jsonLine(1), jsonLine(2)]);
		const before = readFileSync(logPath);
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 });
		expect(res.compacted).toBe(false);
		expect(res.reason).toContain("recent-tail");
		expect(readFileSync(logPath).equals(before)).toBe(true);
	});

	it("N3: re-run after compaction with no new growth → nothing further archived", () => {
		writeLog("collection", Array.from({ length: 80 }, (_, i) => jsonLine(i)));
		compactPlainLog("collection", { cwd, keepRecentBytes: 256 });
		const liveAfterFirst = readFileSync(join(dataDir, "collection.jsonl"));
		const second = compactPlainLog("collection", { cwd, keepRecentBytes: 256 });
		expect(second.compacted).toBe(false);
		expect(readFileSync(join(dataDir, "collection.jsonl")).equals(liveAfterFirst)).toBe(true);
		expect(loadPlainManifest("collection", cwd).segments).toHaveLength(1);
	});

	it("refuses a pending segment whose gzip does not contain the live prefix", () => {
		const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i }));
		const logPath = writeLog("collection", lines);
		const original = readFileSync(logPath);
		const cut = Buffer.byteLength(`${lines.slice(0, 4).join("\n")}\n`);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const badGzip = gzipSync("not-the-live-prefix\n");
		writeFileSync(join(archiveDir, "collection-0001.jsonl.gz"), badGzip);
		const replacementProbe = join(dataDir, ".replacement-probe");
		writeFileSync(replacementProbe, original.subarray(cut));
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "collection-0001.jsonl.gz",
					bytes: cut,
					gz_bytes: badGzip.length,
					records: 4,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: cut,
						source: fileIdentity(logPath),
						replacement: fileIdentity(replacementProbe),
					},
				}],
			}),
		);

		expect(() =>
			compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 }),
		).toThrow(/does not match the live prefix/);
		expect(readFileSync(logPath).equals(original)).toBe(true);
		expect(loadPlainManifest("collection", cwd).segments[0]?.pending_live_drop).toBeDefined();
	});

	it("does not finalize a claim-less pending row after the live prefix is already gone", () => {
		const logPath = writeLog("collection", [jsonLine(9)]);
		const liveTail = readFileSync(logPath);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const archived = gzipSync(`${jsonLine(1)}\n`);
		writeFileSync(join(archiveDir, "collection-0001.jsonl.gz"), archived);
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "collection-0001.jsonl.gz",
					bytes: 10,
					gz_bytes: archived.length,
					records: 1,
					created_at: "2026-08-31T00:00:00.000Z",
					pending_live_drop: {
						cut_bytes: 10,
						source: { dev: "0", ino: "0" },
						replacement: fileIdentity(logPath),
					},
				}],
			}),
		);

		expect(() =>
			compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 }),
		).toThrow(/has no durable claim/);
		expect(readFileSync(logPath).equals(liveTail)).toBe(true);
		expect(loadPlainManifest("collection", cwd).segments[0]?.pending_live_drop).toBeDefined();
	});

	it("does not remove a claim when a complete manifest row contradicts it", () => {
		const logPath = writeLog("collection", [jsonLine(9)]);
		const liveTail = readFileSync(logPath);
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const segmentPath = join(archiveDir, "collection-0001.jsonl.gz");
		const prefix = `${jsonLine(1)}\n`;
		writeFileSync(segmentPath, gzipSync(prefix));
		const createdAt = "2026-08-31T00:00:00.000Z";
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [{
					seq: 1,
					file: "collection-0001.jsonl.gz",
					bytes: Buffer.byteLength(prefix),
					gz_bytes: readFileSync(segmentPath).length,
					records: 999,
					created_at: createdAt,
				}],
			}),
		);
		createRotationClaim(archiveDir, {
			version: 1,
			log: "collection",
			seq: 1,
			file: "collection-0001.jsonl.gz",
			cut_bytes: Buffer.byteLength(prefix),
			records: 1,
			gz_bytes: readFileSync(segmentPath).length,
			gzip_sha256: sha256File(segmentPath),
			created_at: createdAt,
			source: { dev: "0", ino: "0" },
			replacement: fileIdentity(logPath),
		});

		expect(() =>
			compactPlainLog("collection", { cwd, keepRecentBytes: 1024 * 1024 }),
		).toThrow(/does not match its durable rotation claim/);
		expect(readFileSync(logPath).equals(liveTail)).toBe(true);
		expect(existsSync(rotationClaimPath(archiveDir, "collection"))).toBe(true);
		expect(loadPlainManifest("collection", cwd).segments[0]?.records).toBe(999);
	});

	it("N4: corrupt per-log manifest with an EMPTY archive dir still starts at seq 1", () => {
		mkdirSync(join(dataDir, "archive"), { recursive: true });
		writeFileSync(join(dataDir, "archive", "manifest-collection.json"), "{not json");
		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(res.compacted).toBe(true);
		// Nothing on disk to collide with, so 1 is correct here — the hazard is
		// the case below, where segment 1 already holds archived records.
		expect(res.segment).toBe("collection-0001.jsonl.gz");
	});

	// The data-loss case. A corrupt manifest degrades to "no segments", so
	// numbering restarted at 1 and the write CLOBBERED an existing
	// `collection-0001.jsonl.gz` that still held archived records. The
	// sequence is now derived from the manifest AND the filenames on disk,
	// which are self-describing even when the index is not.
	it("P: a corrupt manifest does NOT overwrite an existing segment on disk", () => {
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const existing = join(archiveDir, "collection-0001.jsonl.gz");
		const priorBytes = gzipSync(Buffer.from(`${jsonLine(999)}\n`));
		writeFileSync(existing, priorBytes);
		writeFileSync(join(archiveDir, "manifest-collection.json"), "{not json");

		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });

		expect(res.compacted).toBe(true);
		expect(res.segment).toBe("collection-0002.jsonl.gz");
		// The prior archive is byte-for-byte intact.
		expect(readFileSync(existing).equals(priorBytes)).toBe(true);
	});

	// The regression plan 28 §7 names explicitly: "start with segment 1 + corrupt
	// manifest, run compaction, and prove the repaired manifest indexes BOTH
	// segment 1 and the new segment."
	//
	// The earlier fix stopped the OVERWRITE but not the ORPHANING: a corrupt
	// manifest still loaded as an empty segment list, so the manifest written
	// after compaction contained only the new segment and segment 1 vanished
	// from the index while its bytes sat on disk.
	it("P: a corrupt manifest is REBUILT from disk — the old segment stays indexed", () => {
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		const existing = join(archiveDir, "collection-0001.jsonl.gz");
		writeFileSync(existing, gzipSync(Buffer.from(`${jsonLine(999)}\n`)));
		writeFileSync(join(archiveDir, "manifest-collection.json"), "{not json");

		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(res.compacted).toBe(true);
		expect(res.segment).toBe("collection-0002.jsonl.gz");

		const repaired = loadPlainManifest("collection", cwd);
		expect(repaired.segments.map((s) => s.seq)).toEqual([1, 2]);
		expect(repaired.segments.map((s) => s.file)).toEqual([
			"collection-0001.jsonl.gz",
			"collection-0002.jsonl.gz",
		]);
		// The recovered row is MARKED, so nobody reads its zeroed byte/record
		// counts as measured values — the segment is intact, its metadata is not.
		expect(repaired.segments[0]?.recovered).toBe(true);
		expect(repaired.segments[1]?.recovered).toBeUndefined();
		// And the recovered row still points at real bytes.
		expect(repaired.segments[0]?.gz_bytes).toBeGreaterThan(0);
	});

	// Concurrency has TWO layers and this pins the one a single process can
	// actually observe: the sequence is derived from the directory, so a
	// segment another compactor already wrote is seen and skipped past — the
	// run takes the next number and the existing bytes are untouched.
	//
	// The `wx` (exclusive-create) flag in the writer guards the REMAINING
	// window: two processes that both scan before either writes still derive
	// the same number, and there `wx` turns a silent overwrite into a refusal.
	// That race cannot be staged in-process — pre-creating the file is exactly
	// what the directory scan detects — so it is deliberately NOT asserted here
	// rather than being faked with a stubbed `fs`.
	it("P: a segment another compactor already wrote is skipped past, never replaced", () => {
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({ version: 1, segments: [] }),
		);
		const claimed = join(archiveDir, "collection-0001.jsonl.gz");
		const winnerBytes = gzipSync(Buffer.from(`${jsonLine(1)}\n`));
		writeFileSync(claimed, winnerBytes);

		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });

		expect(res.compacted).toBe(true);
		expect(res.segment).toBe("collection-0002.jsonl.gz");
		expect(readFileSync(claimed).equals(winnerBytes)).toBe(true);
	});

	// The index is durable BEFORE the live prefix is dropped, so the worst crash
	// outcome is duplicate records rather than missing ones.
	it("P: the manifest lists the new segment once the live log has been truncated", () => {
		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const before = readFileSync(join(dataDir, "collection.jsonl")).length;
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(res.compacted).toBe(true);
		const after = readFileSync(join(dataDir, "collection.jsonl")).length;
		expect(after).toBeLessThan(before);
		const listed = loadPlainManifest("collection", cwd).segments.map((s) => s.file);
		expect(listed).toContain(res.segment);
	});

	it("P: the sequence follows the HIGHEST used number, not the last manifest entry", () => {
		const archiveDir = join(dataDir, "archive");
		mkdirSync(archiveDir, { recursive: true });
		// Out-of-order manifest: `.at(-1)` would read seq 1 and produce 2,
		// overwriting the existing segment 7.
		writeFileSync(
			join(archiveDir, "manifest-collection.json"),
			JSON.stringify({
				version: 1,
				segments: [
					{ seq: 7, file: "collection-0007.jsonl.gz", bytes: 1, records: 1, gz_bytes: 1, created_at: "2026-01-01T00:00:00Z" },
					{ seq: 1, file: "collection-0001.jsonl.gz", bytes: 1, records: 1, gz_bytes: 1, created_at: "2026-01-01T00:00:00Z" },
				],
			}),
		);
		writeLog("collection", Array.from({ length: 60 }, (_, i) => jsonLine(i)));
		const res = compactPlainLog("collection", { cwd, keepRecentBytes: 128 });
		expect(res.segment).toBe("collection-0008.jsonl.gz");
	});
});
