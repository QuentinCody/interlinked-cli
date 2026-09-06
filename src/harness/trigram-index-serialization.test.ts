import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	INDEX_DIR_NAME,
	LEGACY_INDEX_FILE_NAME,
	LOOKUP_FILE_NAME,
	META_FILE_NAME,
	packTrigram,
	POSTINGS_FILE_NAME,
	type PostingList,
} from "./trigram-primitives.js";
import {
	computeIndexStats,
	loadIndex,
	loadIndexMeta,
	saveIndex,
} from "./trigram-index-serialization.js";

function posting(fileIds: number[]): PostingList {
	return {
		fileIds: Uint32Array.from(fileIds),
		locMasks: Uint8Array.from(fileIds.map(() => 0b0000_0011)),
		nextMasks: Uint8Array.from(fileIds.map(() => 0b0000_0101)),
	};
}

describe("saveIndex / loadIndex round trip", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "trigram-ser-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("round-trips files, postings, and stop trigrams with nonzero mask stats", () => {
		const packed = packTrigram(97, 98, 99); // "abc"
		const postings = new Map<number, PostingList>([[packed, posting([0])]]);
		const stopTrigrams = new Set<number>([packTrigram(120, 121, 122)]); // "xyz"
		saveIndex(["a.ts"], postings, stopTrigrams, "abc123", "2026-01-01T00:00:00.000Z", tmp);

		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect(loaded?.files).toEqual(["a.ts"]);
		expect(loaded?.baseCommit).toBe("abc123");
		expect(loaded?.builtAt).toBe("2026-01-01T00:00:00.000Z");
		expect([...(loaded?.stopTrigrams ?? [])]).toEqual([packTrigram(120, 121, 122)]);
		expect(loaded?.postings.get(packed)?.fileIds).toEqual(Uint32Array.from([0]));
	});

	it("sorts >=2 postings and >=2 stop trigrams by invoking both comparator branches", () => {
		// A single-element array never invokes .sort()'s comparator (V8 short-circuits),
		// so the hash-ordering (a<b / a>b) and stop-trigram numeric-sort branches need
		// at least two distinct entries to actually run.
		const packedA = packTrigram(97, 98, 99); // "abc" — lower fnv1a hash
		const packedB = packTrigram(120, 121, 122); // "xyz" — higher fnv1a hash
		// Insert the HIGHER-hash entry first: for a 2-element array V8's sort
		// calls the comparator once as (el[1], el[0]) = (packedA, packedB), which
		// is the only shape that exercises the `a.hash < b.hash` branch (line 76)
		// — inserting in hash order only ever exercises the `a.hash > b.hash` arm.
		const postings = new Map<number, PostingList>([
			[packedB, posting([1])],
			[packedA, posting([0])],
		]);
		const stopTrigrams = new Set<number>([
			packTrigram(100, 101, 102), // "def"
			packTrigram(112, 113, 114), // "pqr"
		]);
		saveIndex(["a.ts", "b.ts"], postings, stopTrigrams, "c1", "2026", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect(loaded?.postings.size).toBe(2);
		expect(loaded?.postings.get(packedA)?.fileIds).toEqual(Uint32Array.from([0]));
		expect(loaded?.postings.get(packedB)?.fileIds).toEqual(Uint32Array.from([1]));
		expect([...(loaded?.stopTrigrams ?? [])].sort((a, b) => a - b)).toEqual(
			[packTrigram(100, 101, 102), packTrigram(112, 113, 114)].sort((a, b) => a - b),
		);
	});

	it("also exercises the `a.hash > b.hash` comparator arm (ascending insertion order)", () => {
		// Mirror of the test above with insertion order un-reversed: for a
		// 2-element array the comparator is called once as (el[0], el[1]) here,
		// which is the shape that hits `a.hash > b.hash` (line 77) instead.
		const packedA = packTrigram(97, 98, 99); // "abc" — lower fnv1a hash
		const packedB = packTrigram(120, 121, 122); // "xyz" — higher fnv1a hash
		const postings = new Map<number, PostingList>([
			[packedA, posting([0])],
			[packedB, posting([1])],
		]);
		saveIndex(["a.ts", "b.ts"], postings, new Set(), "c1", "2026", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded?.postings.size).toBe(2);
	});

	it("keeps insertion order when two distinct trigram keys tie on fnv1a hash (comparator's equal arm)", () => {
		// fnv1a only reads bits 0-23 of its argument (three 8-bit shift+mask
		// stages), so a key that differs only above bit 23 hashes identically to
		// its low-24-bit sibling — the one way to force the sort comparator's
		// `return 0` tie arm (line 90) without brute-forcing a genuine 24-bit
		// fnv1a collision (there is none: fnv1a is injective over that domain).
		const packedLow = packTrigram(97, 98, 99); // "abc"
		const packedHigh = packedLow + 0x1000000; // same fnv1a hash, distinct Map key
		const postings = new Map<number, PostingList>([
			[packedLow, posting([7])],
			[packedHigh, posting([13])],
		]);
		saveIndex(["a.ts"], postings, new Set(), "c1", "2026", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		// A stable sort's tie arm must not reorder equal-hash entries: the
		// postings file is written in sortedEntries order and read back in that
		// same order, so a `return 0` tie preserves the original Map insertion
		// order. Verified by direct probe: for this exact 2-element array, V8
		// calls the comparator as (packedHigh, packedLow); a tie arm that
		// answers -1 there (claims packedHigh sorts first) swaps the pair and
		// this key order comes back reversed — 0 (and +1) both leave it intact.
		expect([...(loaded?.postings.keys() ?? [])]).toEqual([packedLow, packedHigh]);
		expect(loaded?.postings.get(packedLow)?.fileIds).toEqual(Uint32Array.from([7]));
		expect(loaded?.postings.get(packedHigh)?.fileIds).toEqual(Uint32Array.from([13]));
	});

	it("round-trips an empty index (0 files, 0 postings, 0 stop trigrams)", () => {
		saveIndex([], new Map(), new Set(), "", "2026-01-01T00:00:00.000Z", tmp);
		const loaded = loadIndex(tmp);
		expect(loaded).toEqual({ files: [], postings: new Map(), stopTrigrams: new Set(), baseCommit: "", builtAt: "2026-01-01T00:00:00.000Z" });
	});

	it("honors an explicit interlinkedDir override distinct from cwd/.interlinked", () => {
		const altDir = join(tmp, "alt-dir");
		saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp, altDir);
		// Nothing written under the default cwd/.interlinked location.
		expect(existsSync(join(tmp, ".interlinked", INDEX_DIR_NAME, LOOKUP_FILE_NAME))).toBe(false);
		expect(existsSync(join(altDir, INDEX_DIR_NAME, LOOKUP_FILE_NAME))).toBe(true);
		expect(loadIndex(tmp, altDir)?.files).toEqual(["a.ts"]);
	});

	it("falls back to cwd/.interlinked when no interlinkedDir override is passed", () => {
		saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp);
		expect(existsSync(join(tmp, ".interlinked", INDEX_DIR_NAME, LOOKUP_FILE_NAME))).toBe(true);
	});

	it("removes a legacy v1 index file on save", () => {
		const indexDir = join(tmp, ".interlinked", INDEX_DIR_NAME);
		mkdirSync(indexDir, { recursive: true });
		const legacyPath = join(indexDir, LEGACY_INDEX_FILE_NAME);
		writeFileSync(legacyPath, "legacy-v1-bytes");
		expect(existsSync(legacyPath)).toBe(true);

		saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp);
		expect(existsSync(legacyPath)).toBe(false);
	});

	it("swallows a legacy-cleanup failure (unlinkSync on a directory) without throwing", () => {
		const indexDir = join(tmp, ".interlinked", INDEX_DIR_NAME);
		mkdirSync(indexDir, { recursive: true });
		const legacyPath = join(indexDir, LEGACY_INDEX_FILE_NAME);
		// A directory at the legacy path: existsSync is true, but unlinkSync throws
		// (EISDIR/EPERM) — the catch swallows it, save must still succeed.
		mkdirSync(legacyPath, { recursive: true });

		expect(() =>
			saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp),
		).not.toThrow();
		expect(existsSync(join(indexDir, LOOKUP_FILE_NAME))).toBe(true);
	});

	it("returns null when either file is missing", () => {
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when postings file read fails (e.g. it's a directory)", () => {
		saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp);
		const indexDir = join(tmp, ".interlinked", INDEX_DIR_NAME);
		const postingsPath = join(indexDir, POSTINGS_FILE_NAME);
		rmSync(postingsPath, { force: true });
		mkdirSync(postingsPath, { recursive: true });
		expect(loadIndex(tmp)).toBeNull();
	});
});

describe("loadIndex — corrupted/truncated lookup buffer", () => {
	let tmp: string;
	let indexDir: string;
	let lookupPath: string;
	let postingsPath: string;
	let goodBuf: Buffer;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "trigram-corrupt-"));
		indexDir = join(tmp, ".interlinked", INDEX_DIR_NAME);
		lookupPath = join(indexDir, LOOKUP_FILE_NAME);
		postingsPath = join(indexDir, POSTINGS_FILE_NAME);
		const packed = packTrigram(97, 98, 99); // "abc"
		const postings = new Map<number, PostingList>([[packed, posting([0])]]);
		const stopTrigrams = new Set<number>([packTrigram(120, 121, 122)]);
		saveIndex(["a.ts"], postings, stopTrigrams, "abc", "2026", tmp);
		goodBuf = readFileSync(lookupPath);
		// Sanity: the happy path must actually load before we start corrupting it.
		expect(loadIndex(tmp)).not.toBeNull();
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function withLookup(buf: Buffer): void {
		writeFileSync(lookupPath, buf);
	}

	it("returns null when the lookup buffer is shorter than the 28-byte header", () => {
		withLookup(goodBuf.subarray(0, 20));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null on a bad magic number", () => {
		const buf = Buffer.from(goodBuf);
		buf.writeUInt32LE(0xdeadbeef, 0);
		withLookup(buf);
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null on an unsupported version", () => {
		const buf = Buffer.from(goodBuf);
		buf.writeUInt32LE(99, 4);
		withLookup(buf);
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when truncated exactly at the 28-byte header boundary", () => {
		withLookup(goodBuf.subarray(0, 28));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when the commit-length field claims more bytes than remain", () => {
		// 28-byte header + 1-byte commitLen + 1 (of 3) commit bytes.
		withLookup(goodBuf.subarray(0, 30));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("defaults builtAt when the buffer ends exactly after the commit bytes", () => {
		// A separate 0-files/0-postings/0-stop-trigrams save so nothing downstream
		// of the meta section needs bytes: header(28) + commitLen(1) + "abc"(3) = 32,
		// no builtAt byte at all.
		saveIndex([], new Map(), new Set(), "abc", "2026", tmp);
		const emptyGoodBuf = readFileSync(lookupPath);
		withLookup(emptyGoodBuf.subarray(0, 32));
		const loaded = loadIndex(tmp);
		expect(loaded).not.toBeNull();
		expect(loaded?.baseCommit).toBe("abc");
		expect(loaded?.builtAt).not.toBe("2026");
		expect(() => new Date(loaded?.builtAt ?? "").toISOString()).not.toThrow();
	});

	it("leaves builtAt at its default when the builtAtLen byte overruns the buffer", () => {
		// header(28) + commitLen(1) + "abc"(3) = 32; builtAtLen byte present at 32
		// (claims 4 bytes) but only 1 byte of buffer remains after it (33+4=37 > 34).
		withLookup(goodBuf.subarray(0, 34));
		// The resulting misalignment trips further truncation checks downstream,
		// so this still returns null — the assertion here is purely that the
		// builtAtLen-overrun branch itself doesn't throw.
		expect(() => loadIndex(tmp)).not.toThrow();
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when the file table's path-length field is truncated", () => {
		// header(28) + commitLen(1) + "abc"(3) + builtAtLen(1) + "2026"(4) = 37,
		// then only 1 of the file table's 2 path-length bytes.
		withLookup(goodBuf.subarray(0, 38));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when a file path in the table is truncated", () => {
		// File table starts at 37: pathLen(2) then "a.ts"(4). Keep the length field,
		// drop the path bytes.
		withLookup(goodBuf.subarray(0, 40));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when the stop-trigrams section is truncated", () => {
		// File table ends at 37 + 2 + 4 = 43; stop trigrams need 4 more bytes.
		withLookup(goodBuf.subarray(0, 45));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when a lookup-table entry (16 bytes) is truncated", () => {
		// Stop trigrams end at 43 + 4 = 47; one lookup entry needs 16 more bytes.
		withLookup(goodBuf.subarray(0, 50));
		expect(loadIndex(tmp)).toBeNull();
	});

	it("returns null when the posting offset+count exceeds the postings file", () => {
		writeFileSync(postingsPath, Buffer.alloc(0));
		expect(loadIndex(tmp)).toBeNull();
	});
});

describe("loadIndexMeta", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "trigram-meta-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns the parsed meta.json after a save", () => {
		saveIndex(["a.ts"], new Map(), new Set(), "c1", "2026-01-01T00:00:00.000Z", tmp);
		const meta = loadIndexMeta(tmp);
		expect(meta?.fileCount).toBe(1);
		expect(meta?.baseCommit).toBe("c1");
	});

	it("returns null when meta.json is missing", () => {
		expect(loadIndexMeta(tmp)).toBeNull();
	});

	it("returns null when meta.json is malformed", () => {
		const indexDir = join(tmp, ".interlinked", INDEX_DIR_NAME);
		mkdirSync(indexDir, { recursive: true });
		writeFileSync(join(indexDir, META_FILE_NAME), "{ not json", "utf-8");
		expect(loadIndexMeta(tmp)).toBeNull();
	});
});

describe("computeIndexStats", () => {
	it("reports zero average mask bits when there are no postings", () => {
		const stats = computeIndexStats([], new Map(), new Set(), "c1", "2026");
		expect(stats.avgLocMaskBits).toBe(0);
		expect(stats.avgNextMaskBits).toBe(0);
	});

	it("computes nonzero average mask bits across postings", () => {
		const packed = packTrigram(97, 98, 99);
		const postings = new Map<number, PostingList>([[packed, posting([0, 1])]]);
		const stats = computeIndexStats(["a.ts", "b.ts"], postings, new Set(), "c1", "2026");
		expect(stats.avgLocMaskBits).toBeCloseTo(2); // 0b0000_0011 -> 2 bits, per entry
		expect(stats.avgNextMaskBits).toBeCloseTo(2); // 0b0000_0101 -> 2 bits, per entry
		expect(stats.fileCount).toBe(2);
		expect(stats.trigramCount).toBe(1);
	});
});
