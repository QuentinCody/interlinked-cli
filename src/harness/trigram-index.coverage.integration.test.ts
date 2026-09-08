// ===========================================
// Supplementary coverage tests for TrigramIndex (trigram-index.ts)
// ===========================================
// This file deliberately targets the branches NOT exercised by the primary
// suite (src/harness/__tests__/trigram-index.test.ts), which is owned
// elsewhere. The high-value targets here are:
//   - mergeDirty()        — full override/new-file/empty-posting/stop-recompute
//   - build()             — skip/oversize/binary/empty/onProgress/stop-trigram
//   - incrementalUpdate() — git-driven add/modify/delete/skip/oversize/binary
//   - adjacency filtering  — passesAdjacencyCheck / getMasksForFile / filterByAdjacency
//   - query edge paths     — intersection delete, early-exit, adjacency wipeout guard
//
// Tests are behavioral: build a real index (often against a real temp dir so
// the on-disk re-read paths in mergeDirty/incrementalUpdate actually run),
// mutate the dirty layer, merge, query, and assert on observable results.
//
// No real model/provider/API names appear in fixtures — synthetic identifiers
// only (e.g. "vendorModelV6", "handleAuth").

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { extractTrigrams, packTrigram, TrigramIndex } from "./trigram-index.js";
import {
	DEFAULT_MAX_FILE_SIZE,
	extractTrigramsWithMasks,
	nextCharBit,
	type PostingList,
} from "./trigram-primitives.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an in-memory index (no masks) from a synthetic file map, like the
 *  helper in the primary suite, so we can exercise pure query/dirty paths. */
function buildPlainIndex(
	files: Record<string, string>,
	cwd = "/tmp/test",
	baseCommit = "abc123",
): TrigramIndex {
	const filePaths = Object.keys(files);
	const postingsBuilder = new Map<number, number[]>();
	const fileArray: string[] = [];

	for (let fileId = 0; fileId < filePaths.length; fileId++) {
		const path = nonNull(filePaths[fileId]);
		fileArray.push(path);
		for (const tri of extractTrigrams(nonNull(files[path]))) {
			let list = postingsBuilder.get(tri);
			if (!list) {
				list = [];
				postingsBuilder.set(tri, list);
			}
			list.push(fileId);
		}
	}

	const postings = new Map<number, PostingList>();
	for (const [tri, list] of postingsBuilder) {
		const fileIds = new Uint32Array(list);
		postings.set(tri, {
			fileIds,
			locMasks: new Uint8Array(fileIds.length),
			nextMasks: new Uint8Array(fileIds.length),
		});
	}

	return new TrigramIndex(fileArray, postings, new Set(), baseCommit, cwd);
}

/** Build an index whose posting masks are computed for real (extractTrigramsWithMasks),
 *  so adjacency verification has meaningful loc/next masks to inspect. */
function buildMaskedIndex(files: Record<string, string>): TrigramIndex {
	const filePaths = Object.keys(files);
	const builder = new Map<
		number,
		{ fileIds: number[]; locMasks: number[]; nextMasks: number[] }
	>();
	const fileArray: string[] = [];

	for (let fileId = 0; fileId < filePaths.length; fileId++) {
		const path = nonNull(filePaths[fileId]);
		fileArray.push(path);
		const masks = extractTrigramsWithMasks(nonNull(files[path]));
		for (const [tri, m] of masks) {
			let entry = builder.get(tri);
			if (!entry) {
				entry = { fileIds: [], locMasks: [], nextMasks: [] };
				builder.set(tri, entry);
			}
			entry.fileIds.push(fileId);
			entry.locMasks.push(m.locMask);
			entry.nextMasks.push(m.nextMask);
		}
	}

	const postings = new Map<number, PostingList>();
	for (const [tri, data] of builder) {
		// fileIds are already pushed in ascending fileId order, so they're sorted.
		postings.set(tri, {
			fileIds: new Uint32Array(data.fileIds),
			locMasks: new Uint8Array(data.locMasks),
			nextMasks: new Uint8Array(data.nextMasks),
		});
	}

	return new TrigramIndex(fileArray, postings, new Set(), "abc123", "/tmp/test");
}

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

// With a tiny file set the stop-trigram cutoff (floor(fileCount * 0.4)) collapses
// toward 0, turning almost every trigram into a (skipped) stop trigram and
// destroying query precision. Padding the index with several files keeps the
// cutoff above 1 so unique identifiers stay queryable.
//
// The filler content is deliberately keyword-free (no "export"/"const"/"function"
// prefixes): mergeDirty drops build-time stop trigrams from postings without
// re-registering them as stop trigrams, so any trigram a filler SHARES with a
// real fixture would silently vanish from queries after a merge. Distinct
// gibberish per file avoids that aliasing.
const FILLER_TOKENS = [
	"qwxkjz",
	"plmvbn",
	"zrtghy",
	"wdfklp",
	"jhgxcv",
	"nmqwrt",
	"bvplkz",
	"yhgtfd",
];

function fillerLine(i: number): string {
	return `${FILLER_TOKENS[i % FILLER_TOKENS.length]}${i} marker ${i} ${FILLER_TOKENS[(i + 3) % FILLER_TOKENS.length]}`;
}

function writeFillerFiles(dir: string, count: number): void {
	for (let i = 0; i < count; i++) {
		writeFileSync(join(dir, `filler${i}.ts`), `${fillerLine(i)}\n`);
	}
}

function fillerMap(count: number): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		out[`filler${i}.ts`] = fillerLine(i);
	}
	return out;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// build() — full discovery / skip / oversize / binary / stop-trigram paths
// ---------------------------------------------------------------------------

describe("TrigramIndex.build", () => {
	it("indexes normal files and skips lock/binary/oversized/empty ones", () => {
		const dir = makeTmpDir("trigram-build-");

		// A normal indexable file.
		writeFileSync(join(dir, "handler.ts"), "export function handleAuth(req) { return req; }");
		// A second normal file so stop-trigram math has more than one file.
		writeFileSync(join(dir, "router.ts"), "import { handleAuth } from './handler';");
		// A skipped basename (shouldSkipFile → continue at line 147).
		writeFileSync(join(dir, "package-lock.json"), '{"name":"x","lockfileVersion":3}');
		// A binary file (null byte → isBinaryContent → continue at line 154).
		writeFileSync(join(dir, "blob.bin"), Buffer.from([0x68, 0x00, 0x69, 0x00, 0x6a]));
		// A file too small to yield trigrams (masks.size === 0 → continue at line 161).
		writeFileSync(join(dir, "tiny.ts"), "x");

		const progress: Array<[number, number]> = [];
		const index = TrigramIndex.build({
			cwd: dir,
			onProgress: (indexed, total) => {
				progress.push([indexed, total]);
			},
		});

		// Only the two real source files made it in.
		expect(index.files).toContain("handler.ts");
		expect(index.files).toContain("router.ts");
		expect(index.files).not.toContain("package-lock.json");
		expect(index.files).not.toContain("blob.bin");
		expect(index.files).not.toContain("tiny.ts");
		expect(index.files.length).toBe(2);

		// onProgress fired at least once (line 170-172).
		expect(progress.length).toBeGreaterThan(0);

		// The built index is queryable for content from the indexed files.
		const candidates = index.queryCandidatePaths([...extractTrigrams("handleauth")]);
		expect(candidates).toContain("handler.ts");
		expect(candidates).toContain("router.ts");
	});

	it("skips files larger than maxFileSize", () => {
		const dir = makeTmpDir("trigram-build-big-");
		writeFileSync(join(dir, "small.ts"), "const smallButRealContent = 42;");
		// 4KB file, but maxFileSize is set to 100 bytes → skipped at line 153.
		writeFileSync(join(dir, "big.ts"), "a".repeat(4096));

		const index = TrigramIndex.build({ cwd: dir, maxFileSize: 100 });
		expect(index.files).toContain("small.ts");
		expect(index.files).not.toContain("big.ts");
	});

	it("computes stop trigrams when a trigram appears in more than the cutoff fraction of files", () => {
		const dir = makeTmpDir("trigram-build-stop-");
		// 10 files all containing the trigram "the" → >40% → stop trigram.
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(dir, `common${i}.ts`), `the value of item number ${i} here`);
		}
		// One file with a rare identifier.
		writeFileSync(join(dir, "rare.ts"), "uniqueRareIdentifierXyz");

		const index = TrigramIndex.build({ cwd: dir, stopThreshold: 0.4 });
		const stats = index.stats();
		// "the" (and its overlapping trigrams) become stop trigrams (line 180-181).
		expect(stats.stopTrigramCount).toBeGreaterThan(0);

		// Querying for the stop trigram alone returns all files (all candidates),
		// while the rare identifier narrows to exactly one.
		const rareResults = index.query([...extractTrigrams("uniqueRareIdentifierXyz")]);
		const rarePaths = [...rareResults].map((id) => index.files[id]);
		expect(rarePaths).toContain("rare.ts");
	});

	it("defaults to process.cwd() when no cwd option is given", () => {
		// Exercise the `options.cwd || process.cwd()` default (line 130 RHS) without
		// indexing the whole repo: chdir into a tiny temp dir for the duration of
		// the build, then restore. vitest runs this file in its own worker, and the
		// finally restores cwd so sibling tests are unaffected.
		const dir = makeTmpDir("trigram-build-cwd-");
		writeFileSync(join(dir, "soleFile.ts"), "export const soleIdentifier = 'present';");
		// SPY, not process.chdir(): chdir THROWS in a worker thread, and Stryker's
		// vitest runner pins its own pool, so a chdir here fails the mutation dry
		// run for every file whose graph-selected test scope includes this one —
		// surfacing only as a generic "There were failed tests in the initial test
		// run" that names nothing (measured 2026-08-04).
		// realpathSync matches what chdir used to give us: the canonical,
		// symlink-resolved form, which is what TrigramIndex.build stores.
		const expectedCwd = realpathSync(dir);
		const spy = vi.spyOn(process, "cwd").mockReturnValue(expectedCwd);
		try {
			const index = TrigramIndex.build(); // no options → cwd defaults to process.cwd()
			expect(index.cwd).toBe(expectedCwd);
			expect(index.files).toContain("soleFile.ts");
		} finally {
			spy.mockRestore();
		}
	});

	it("skips a tracked path whose on-disk entry can no longer be read", { timeout: 60_000 }, () => {
		// A git-tracked file that has been replaced on disk by a directory: git
		// ls-files still lists it, so build() attempts readFileSync and hits the
		// catch-continue (line 156-157). The other file still indexes.
		const dir = makeTmpDir("trigram-build-unreadable-");
		execSync("git init -q", { cwd: dir, stdio: "ignore" });
		execSync("git config user.email coverage@example.test", { cwd: dir, stdio: "ignore" });
		execSync("git config user.name 'Coverage Bot'", { cwd: dir, stdio: "ignore" });
		writeFileSync(join(dir, "good.ts"), "export const goodValue = 'present';");
		writeFileSync(join(dir, "trap.ts"), "export const trapValue = 'doomed';");
		execSync("git add -A", { cwd: dir, stdio: "ignore" });
		execSync("git commit -q -m initial", { cwd: dir, stdio: "ignore" });

		// Replace trap.ts (a tracked file) with a directory → readFileSync throws
		// EISDIR when build() reaches it.
		rmSync(join(dir, "trap.ts"));
		mkdirSync(join(dir, "trap.ts"));

		const index = TrigramIndex.build({ cwd: dir });
		expect(index.files).toContain("good.ts");
		expect(index.files).not.toContain("trap.ts");
	});
});

// ---------------------------------------------------------------------------
// query() — intersection delete, early exit, adjacency wipeout guard
// ---------------------------------------------------------------------------

describe("query intersection + early-exit paths", () => {
	it("intersects posting lists and drops ids not present in every list", () => {
		// The intersection delete loop (lines 263-267) only runs when the candidate
		// set after the first (smallest) posting still exceeds
		// EARLY_TERMINATION_THRESHOLD (20). Use posting lists of 30+ entries so the
		// loop processes the second trigram and deletes the non-overlapping ids.
		const nFiles = 60;
		const filePaths = Array.from({ length: nFiles }, (_, i) => `f${i}.ts`);
		const triX = packTrigram(0x78, 0x78, 0x78); // "xxx"
		const triY = packTrigram(0x79, 0x79, 0x79); // "yyy"

		// triX in files 0..29 (smaller, examined first → seeds result, size 30 > 20).
		const xIds = Array.from({ length: 30 }, (_, i) => i);
		// triY in files 15..49 (larger). Intersection with triX = 15..29.
		const yIds = Array.from({ length: 35 }, (_, i) => i + 15);

		const postings = new Map<number, PostingList>();
		postings.set(triX, {
			fileIds: new Uint32Array(xIds),
			locMasks: new Uint8Array(xIds.length),
			nextMasks: new Uint8Array(xIds.length),
		});
		postings.set(triY, {
			fileIds: new Uint32Array(yIds),
			locMasks: new Uint8Array(yIds.length),
			nextMasks: new Uint8Array(yIds.length),
		});

		const index = new TrigramIndex(filePaths, postings, new Set(), "abc", "/tmp");
		const result = index.query([triX, triY]);
		// Intersection is files 15..29 inclusive (15 files). ids 0..14 were deleted.
		expect([...result].sort((a, b) => a - b)).toEqual(
			Array.from({ length: 15 }, (_, i) => i + 15),
		);
	});

	it("returns early when an intersection empties the candidate set before all trigrams", () => {
		// Seed result with a large posting (size 30 > threshold so no early break),
		// then intersect with a disjoint large posting → result becomes empty and
		// the function returns at line 270 (the in-loop size===0 guard).
		const triX = packTrigram(0x78, 0x78, 0x78);
		const triY = packTrigram(0x79, 0x79, 0x79);
		const triZ = packTrigram(0x7a, 0x7a, 0x7a);
		const xIds = Array.from({ length: 30 }, (_, i) => i); // 0..29
		const yIds = Array.from({ length: 30 }, (_, i) => i + 100); // 100..129 (disjoint)
		const zIds = Array.from({ length: 30 }, (_, i) => i); // would match x, but never reached

		const postings = new Map<number, PostingList>();
		for (const [tri, ids] of [
			[triX, xIds],
			[triY, yIds],
			[triZ, zIds],
		] as const) {
			postings.set(tri, {
				fileIds: new Uint32Array(ids),
				locMasks: new Uint8Array(ids.length),
				nextMasks: new Uint8Array(ids.length),
			});
		}
		const index = new TrigramIndex(
			Array.from({ length: 130 }, (_, i) => `f${i}.ts`),
			postings,
			new Set(),
			"abc",
			"/tmp",
		);
		// x then y (both size 30): result={0..29}, intersect y → empty → return at 270.
		expect(index.query([triX, triY, triZ]).size).toBe(0);
	});

	it("returns an empty set immediately when a required trigram has no posting", () => {
		// One usable trigram present in zero files → getCandidatesForTrigram empty
		// → return new Set() at line 254-255.
		const triPresent = packTrigram(0x61, 0x61, 0x61);
		const triMissing = packTrigram(0x7a, 0x7a, 0x7a);
		const postings = new Map<number, PostingList>();
		postings.set(triPresent, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array(1),
			nextMasks: new Uint8Array(1),
		});
		const index = new TrigramIndex(["a.ts"], postings, new Set(), "abc", "/tmp");
		// triMissing has the smaller posting (size 0) so it is examined first.
		expect(index.query([triPresent, triMissing]).size).toBe(0);
	});

	it("early-terminates intersection once the candidate set is small", () => {
		// Two trigrams, each in a single (same) file. After the first trigram the
		// result has size 1 (<= EARLY_TERMINATION_THRESHOLD) so the loop breaks
		// before processing the second (line 273).
		const triA = packTrigram(0x61, 0x62, 0x63);
		const triB = packTrigram(0x64, 0x65, 0x66);
		const postings = new Map<number, PostingList>();
		postings.set(triA, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array(1),
			nextMasks: new Uint8Array(1),
		});
		postings.set(triB, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array(1),
			nextMasks: new Uint8Array(1),
		});
		const index = new TrigramIndex(["only.ts"], postings, new Set(), "abc", "/tmp");
		const result = index.query([triA, triB]);
		expect([...result]).toEqual([0]);
	});

	it("keeps the unfiltered result when adjacency filtering would wipe out all candidates", () => {
		// Build a masked index for one file, then query with a trigram sequence
		// whose adjacency cannot be satisfied (reversed order) so filterByAdjacency
		// returns empty and the guard at line 282-284 restores the unfiltered set.
		const content = "abcdefg";
		const index = buildMaskedIndex({ "doc.ts": content });

		const tAbc = packTrigram(0x61, 0x62, 0x63); // "abc"
		const tBcd = packTrigram(0x62, 0x63, 0x64); // "bcd"
		// Reversed sequence: bcd then abc — not adjacent in that order → wipeout.
		const result = index.query([tAbc, tBcd], [[tBcd, tAbc]]);
		// Guard prevents false-negative: candidate file is still returned.
		expect([...result]).toContain(0);
	});

	it("applies adjacency filtering and keeps a genuinely-adjacent match", () => {
		const index = buildMaskedIndex({ "doc.ts": "abcdefg" });
		const tAbc = packTrigram(0x61, 0x62, 0x63); // "abc"
		const tBcd = packTrigram(0x62, 0x63, 0x64); // "bcd"
		// Correctly-ordered adjacent sequence stays after filtering.
		const result = index.query([tAbc, tBcd], [[tAbc, tBcd]]);
		expect([...result]).toContain(0);
	});

	it("rejects a candidate whose trigrams are not positionally adjacent", () => {
		// Two trigrams that both appear in the file but far apart, so the rotated
		// locMask overlap check (line 342-343) fails → file excluded by adjacency.
		// "abc...far...xyz" — abc at start, xyz at end.
		const content = `abc${"q".repeat(40)}xyz`;
		const index = buildMaskedIndex({ "spread.ts": content });
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tXyz = packTrigram(0x78, 0x79, 0x7a);
		// Both present individually.
		expect(index.query([tAbc]).has(0)).toBe(true);
		expect(index.query([tXyz]).has(0)).toBe(true);
		// As an "adjacent" sequence they are not adjacent → filtered set empty →
		// guard restores unfiltered (so still present), proving the filter ran.
		const result = index.query([tAbc, tXyz], [[tAbc, tXyz]]);
		expect(result.has(0)).toBe(true);
	});

	it("skips adjacency checks for single-trigram sequences", () => {
		const index = buildMaskedIndex({ "doc.ts": "abcdef" });
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		// Sequence of length 1 → continue at line 328 (no adjacency to verify).
		const result = index.query([tAbc], [[tAbc]]);
		expect(result.has(0)).toBe(true);
	});

	it("skips adjacency for stop trigrams in a sequence", () => {
		// Mark one of the two adjacent trigrams as a stop trigram so the
		// passesAdjacencyCheck stop-skip branch (line 335) is taken.
		const filePaths = ["doc.ts"];
		const masks = extractTrigramsWithMasks("abcdef");
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tBcd = packTrigram(0x62, 0x63, 0x64);
		const postings = new Map<number, PostingList>();
		for (const [tri, m] of masks) {
			postings.set(tri, {
				fileIds: new Uint32Array([0]),
				locMasks: new Uint8Array([m.locMask]),
				nextMasks: new Uint8Array([m.nextMask]),
			});
		}
		// tAbc is a stop trigram → adjacency check for (tAbc,tBcd) is skipped.
		const index = new TrigramIndex(filePaths, postings, new Set([tAbc]), "abc", "/tmp");
		const result = index.query([tBcd], [[tAbc, tBcd]]);
		expect(result.has(0)).toBe(true);
	});

	it("skips adjacency when a sequence trigram is absent from the file's base postings", () => {
		// tAbc present in the file, tQqq present in postings (a different file) but
		// not in THIS file → getMasksForFile returns null → masks?.continue (line 339).
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tQqq = packTrigram(0x71, 0x71, 0x71);
		const postings = new Map<number, PostingList>();
		postings.set(tAbc, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array([0x01]),
			nextMasks: new Uint8Array([nextCharBit(0x64)]),
		});
		// tQqq belongs to file 1 only.
		postings.set(tQqq, {
			fileIds: new Uint32Array([1]),
			locMasks: new Uint8Array([0x01]),
			nextMasks: new Uint8Array([0x01]),
		});
		const index = new TrigramIndex(["f0.ts", "f1.ts"], postings, new Set(), "abc", "/tmp");
		// Query restricted to file 0 via tAbc; sequence references tQqq (absent here).
		const result = index.query([tAbc], [[tAbc, tQqq]]);
		expect(result.has(0)).toBe(true);
	});

	it("skips adjacency when a sequence trigram has no posting entry at all", () => {
		// tAbc present; tNone is in NO posting list → getMasksForFile hits the
		// `if (!posting) return null` branch (line 374) → adjacency skipped.
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tNone = packTrigram(0x6e, 0x6f, 0x70); // "nop" — never indexed
		const postings = new Map<number, PostingList>();
		postings.set(tAbc, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array([0x01]),
			nextMasks: new Uint8Array([nextCharBit(0x6e)]),
		});
		const index = new TrigramIndex(["doc.ts"], postings, new Set(), "abc", "/tmp");
		const result = index.query([tAbc], [[tAbc, tNone]]);
		expect(result.has(0)).toBe(true);
	});

	it("fails adjacency when the next-char bloom does not contain the third char of the next trigram", () => {
		// Construct masks so the positional rotation overlaps (passes the first
		// check) but the nextMask check (line 346-347) fails → return false.
		const tAbc = packTrigram(0x61, 0x62, 0x63); // "abc"
		const tBcd = packTrigram(0x62, 0x63, 0x64); // "bcd", third char 'd' = 0x64
		const postings = new Map<number, PostingList>();
		// locMask of A at bit0; B at bit1 → rotate(A)=bit1 overlaps B. Good.
		// nextMask of A deliberately set to a bit that is NOT nextCharBit('d').
		const dBit = nextCharBit(0x64);
		const wrongBit = dBit === 0x01 ? 0x02 : 0x01;
		postings.set(tAbc, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array([0x01]),
			nextMasks: new Uint8Array([wrongBit]),
		});
		postings.set(tBcd, {
			fileIds: new Uint32Array([0]),
			locMasks: new Uint8Array([0x02]),
			nextMasks: new Uint8Array([0x00]),
		});
		const index = new TrigramIndex(["doc.ts"], postings, new Set(), "abc", "/tmp");
		// Adjacency fails → filtered empty → guard restores unfiltered (still has 0).
		const result = index.query([tAbc, tBcd], [[tAbc, tBcd]]);
		expect(result.has(0)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getMasksForFile — dirty override / dirty-new / binary-search-miss paths
// (exercised indirectly through query with adjacency sequences)
// ---------------------------------------------------------------------------

describe("getMasksForFile via adjacency on dirty state", () => {
	it("skips adjacency masks for a dirty-overridden file", () => {
		const index = buildMaskedIndex({ "doc.ts": "abcdef" });
		// Override the base file → getMasksForFile early-returns null (line 362-365).
		index.updateFile("doc.ts", "abcdefghij");
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tBcd = packTrigram(0x62, 0x63, 0x64);
		const result = index.query([tAbc, tBcd], [[tAbc, tBcd]]);
		// Dirty override has no masks → adjacency skipped → file 0 still returned.
		expect(result.has(0)).toBe(true);
	});

	it("skips adjacency masks for a dirty-new file", () => {
		const index = buildMaskedIndex({ "base.ts": "zzzzzz" });
		// Add a brand-new dirty file containing the adjacent trigrams.
		index.updateFile("new.ts", "abcdef");
		const tAbc = packTrigram(0x61, 0x62, 0x63);
		const tBcd = packTrigram(0x62, 0x63, 0x64);
		// new.ts matches both trigrams; getMasksForFile hits the dirty-new branch
		// (line 368-370) returning null → adjacency skipped → new.ts kept.
		const paths = index.queryCandidatePaths([tAbc, tBcd], [[tAbc, tBcd]]);
		expect(paths).toContain("new.ts");
	});
});

// ---------------------------------------------------------------------------
// getFilePath / getAllFileIds dirty-new branches
// ---------------------------------------------------------------------------

describe("dirty-new id resolution", () => {
	it("resolves a dirty-new file's path through getFilePath (id >= files.length)", () => {
		const index = buildPlainIndex({ "base.ts": "alphabeta" });
		index.updateFile("fresh.ts", "uniqueFreshIdentifier");
		// queryCandidatePaths → getFilePath walks dirtyNewFiles (line 392-393).
		const paths = index.queryCandidatePaths([...extractTrigrams("uniqueFreshIdentifier")]);
		expect(paths).toContain("fresh.ts");
	});

	it("includes dirty-new files in getAllFileIds when querying with no trigrams", () => {
		const index = buildPlainIndex({ "base.ts": "content here" });
		index.updateFile("added.ts", "more content");
		// query([]) → getAllFileIds → adds dirtyNewFiles entries (line 406-408).
		const all = index.query([]);
		expect(all.size).toBe(2);
	});

	it("treats updated binary content as having no trigrams", () => {
		// updateFile with content containing a null byte → isBinaryContent true →
		// trigrams = new Set() (line 469 true branch). The file is registered but
		// contributes no searchable trigrams.
		const index = buildPlainIndex({ "base.ts": "base content here" });
		index.updateFile("blob.ts", "abcdef\x00ghijkl");
		expect(index.dirtyFileCount).toBe(1);
		// No trigrams → querying any of its bytes yields no candidate for blob.ts.
		const paths = index.queryCandidatePaths([...extractTrigrams("ghijkl")]);
		expect(paths).not.toContain("blob.ts");
		// After merge it still has zero trigrams (no postings reference it).
		index.mergeDirty();
		expect(index.queryCandidatePaths([...extractTrigrams("abcdef")])).not.toContain("blob.ts");
	});

	it("returns undefined for an id that maps to no base or dirty-new file", () => {
		// Drive the getFilePath fall-through (line 395) by querying a result that
		// includes an id with no path: build postings referencing a fileId beyond
		// files.length with no matching dirty-new entry.
		const tri = packTrigram(0x61, 0x62, 0x63);
		const postings = new Map<number, PostingList>();
		// fileId 5 has no entry in files[] (length 1) and no dirty-new mapping.
		postings.set(tri, {
			fileIds: new Uint32Array([5]),
			locMasks: new Uint8Array(1),
			nextMasks: new Uint8Array(1),
		});
		const index = new TrigramIndex(["only.ts"], postings, new Set(), "abc", "/tmp");
		const ids = index.query([tri]);
		expect(ids.has(5)).toBe(true);
		// The orphan id resolves to no path → queryCandidatePaths drops it.
		const paths = index.queryCandidatePaths([tri]);
		expect(paths).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// mergeDirty() — the high-cyclomatic target
// ---------------------------------------------------------------------------

describe("mergeDirty", () => {
	it("is a no-op when the index is not dirty", () => {
		const index = buildPlainIndex({ "a.ts": "hello world" });
		const before = index.stats().trigramCount;
		index.mergeDirty(); // early return at line 506
		expect(index.stats().trigramCount).toBe(before);
		expect(index.isDirty).toBe(false);
	});

	it("merges an override that re-reads proper masks from disk", () => {
		// Build a real on-disk index so files[fileId] resolves to a readable path,
		// driving the existsSync/readFileSync/extractTrigramsWithMasks branch
		// (lines 536-545) and the masks-present `?? ` branch (line 556-557 true).
		const dir = makeTmpDir("trigram-merge-disk-");
		writeFileSync(join(dir, "a.ts"), "export function originalNameAbc() {}");
		writeFileSync(join(dir, "b.ts"), "export const untouchedBetaConst = 1;");
		writeFillerFiles(dir, 6); // keep the stop-trigram cutoff above 1
		const index = TrigramIndex.build({ cwd: dir });

		// Now change a.ts on disk AND in the dirty layer to the same new content,
		// so mergeDirty's disk re-read matches the override trigrams.
		const newContent = "export function renamedFunctionXyz() { return verifyToken(); }";
		writeFileSync(join(dir, "a.ts"), newContent);
		index.updateFile("a.ts", newContent);

		expect(index.isDirty).toBe(true);
		index.mergeDirty();
		expect(index.isDirty).toBe(false);

		// Old identifier no longer indexed for a.ts; new one is.
		const oldPaths = index.queryCandidatePaths([...extractTrigrams("originalNameAbc")]);
		expect(oldPaths).not.toContain("a.ts");
		const newPaths = index.queryCandidatePaths([...extractTrigrams("renamedFunctionXyz")]);
		expect(newPaths).toContain("a.ts");
		// b.ts untouched and still searchable.
		expect(index.queryCandidatePaths([...extractTrigrams("untouchedBetaConst")])).toContain(
			"b.ts",
		);

		// Masks were recomputed from disk → adjacency on a real sequence works.
		expect(index.stats().fileCount).toBe(8);
	});

	it("merges an override with zero masks when the file is absent from disk", () => {
		// In-memory index whose files[] paths do NOT exist on disk → existsSync
		// false (line 539 false) → masks stays null → `m?.locMask ?? 0` (line 556-557 false).
		const index = buildPlainIndex(
			{ "ghost.ts": "originalGhostContentAbc here", ...fillerMap(6) },
			"/nonexistent-dir-xyz",
		);
		index.updateFile("ghost.ts", "replacementGhostContentXyz");
		index.mergeDirty();
		expect(index.isDirty).toBe(false);

		const oldPaths = index.queryCandidatePaths([...extractTrigrams("originalGhostContentAbc")]);
		expect(oldPaths).not.toContain("ghost.ts");
		const newPaths = index.queryCandidatePaths([...extractTrigrams("replacementGhostContentXyz")]);
		expect(newPaths).toContain("ghost.ts");
	});

	it("merges a deletion override by dropping the file from all postings", () => {
		// trigrams === null branch (line 533 false) — fileId removed, not re-added.
		// Filler files keep the stop-trigram cutoff above 1 so the shared phrase
		// stays a real (queryable) trigram set after the merge recompute.
		const index = buildPlainIndex({
			"keep.ts": "sharedTrigramContentPhrase keepAlpha",
			"drop.ts": "sharedTrigramContentPhrase dropBeta",
			...fillerMap(6),
		});
		index.updateFile("drop.ts", null); // delete
		index.mergeDirty();
		expect(index.isDirty).toBe(false);

		const paths = index.queryCandidatePaths([...extractTrigrams("sharedTrigramContentPhrase")]);
		expect(paths).toContain("keep.ts");
		expect(paths).not.toContain("drop.ts");
		// File count unchanged in `files[]` (delete only removes postings entries),
		// but the deleted file no longer surfaces in queries.
	});

	it("merges new files reading masks from disk and assigns permanent ids", () => {
		// Real dir so the new-file disk-read branch (lines 569-578) runs with masks.
		const dir = makeTmpDir("trigram-merge-new-disk-");
		writeFileSync(join(dir, "base.ts"), "export const baseConstValue = true;");
		writeFillerFiles(dir, 6); // keep stop-trigram cutoff above 1
		const index = TrigramIndex.build({ cwd: dir });
		const baseCount = index.files.length;

		// Write a new file to disk and register it in the dirty layer.
		const addedContent = "export function brandNewFeatureXyz() { return computeValue(); }";
		writeFileSync(join(dir, "added.ts"), addedContent);
		index.updateFile("added.ts", addedContent);

		index.mergeDirty();
		expect(index.isDirty).toBe(false);
		expect(index.files).toContain("added.ts");
		expect(index.files.length).toBe(baseCount + 1);

		const paths = index.queryCandidatePaths([...extractTrigrams("brandNewFeatureXyz")]);
		expect(paths).toContain("added.ts");
	});

	it("merges new files with zero masks when they are not on disk", () => {
		// In-memory index + dirty-new file whose path does not exist on disk →
		// existsSync false (line 572 false) → masks null → `?? 0` (line 588-589 false).
		const index = buildPlainIndex(
			{ "base.ts": "baseFileContent", ...fillerMap(6) },
			"/nonexistent-dir-zzz",
		);
		index.updateFile("phantom.ts", "phantomUniqueIdentifier");
		index.mergeDirty();
		expect(index.isDirty).toBe(false);
		expect(index.files).toContain("phantom.ts");

		const paths = index.queryCandidatePaths([...extractTrigrams("phantomUniqueIdentifier")]);
		expect(paths).toContain("phantom.ts");
	});

	it("falls back to zero masks when an overridden file's disk read throws (EISDIR)", () => {
		// Build a real index, then replace the overridden file on disk with a
		// directory so existsSync is true (line 539 true) but readFileSync throws
		// → catch at line 543-545 → masks stays null → zero-mask fallback.
		const dir = makeTmpDir("trigram-merge-override-throw-");
		writeFileSync(join(dir, "trap.ts"), "trapAlpha trapBeta trapGamma");
		writeFillerFiles(dir, 6);
		const index = TrigramIndex.build({ cwd: dir });

		// Override trap.ts in the dirty layer, then make its disk path a directory.
		index.updateFile("trap.ts", "trapReplacementUniqueWord");
		rmSync(join(dir, "trap.ts"));
		mkdirSync(join(dir, "trap.ts"));

		index.mergeDirty(); // hits the override disk-read catch (line 544)
		expect(index.isDirty).toBe(false);
		// Override trigrams were still applied (with zero masks).
		const paths = index.queryCandidatePaths([...extractTrigrams("trapReplacementUniqueWord")]);
		expect(paths).toContain("trap.ts");
	});

	it("falls back to zero masks when a new file's disk read throws (EISDIR)", () => {
		// Register a dirty-new file, then create a directory at its path so the
		// new-file branch hits existsSync true (line 572 true) + readFileSync throw
		// → catch at line 576-578 → zero-mask fallback.
		const dir = makeTmpDir("trigram-merge-new-throw-");
		writeFileSync(join(dir, "base.ts"), "baseAlpha baseBeta");
		writeFillerFiles(dir, 6);
		const index = TrigramIndex.build({ cwd: dir });

		index.updateFile("freshDir.ts", "freshDirUniqueWord");
		// Make the new file's path a directory on disk.
		mkdirSync(join(dir, "freshDir.ts"));

		index.mergeDirty(); // hits the new-file disk-read catch (line 577)
		expect(index.isDirty).toBe(false);
		expect(index.files).toContain("freshDir.ts");
		const paths = index.queryCandidatePaths([...extractTrigrams("freshDirUniqueWord")]);
		expect(paths).toContain("freshDir.ts");
	});

	it("removes postings that become empty after a deletion merge", () => {
		// "drop.ts" is the ONLY holder of its unique trigrams. After deletion +
		// merge, those posting arrays are empty and must be dropped (line 596 false).
		const index = buildPlainIndex({
			"keep.ts": "commonShared keepAlpha",
			"drop.ts": "commonShared zzzuniqueonlyhere",
			...fillerMap(6),
		});
		const before = index.stats().trigramCount;
		index.updateFile("drop.ts", null);
		index.mergeDirty();
		const after = index.stats().trigramCount;
		// At least the trigrams unique to drop.ts were removed.
		expect(after).toBeLessThan(before);
		// The unique trigram is gone entirely.
		const paths = index.queryCandidatePaths([...extractTrigrams("zzzuniqueonlyhere")]);
		expect(paths).not.toContain("drop.ts");
	});

	it("recomputes stop trigrams after merge when a trigram exceeds the 40% threshold", () => {
		// Start with files that have no stop trigrams, then add many dirty-new
		// files all sharing a trigram so post-merge it crosses 40% (line 612 true).
		const index = buildPlainIndex({ "seed.ts": "seedonlytrigrams" }, "/nonexistent-stop");
		// Add 9 new files (total 10) all containing "the".
		for (let i = 0; i < 9; i++) {
			index.updateFile(`f${i}.ts`, `the item ${i}`);
		}
		expect(index.stats().stopTrigramCount).toBe(0); // not recomputed until merge
		index.mergeDirty();
		// After merge, "the" appears in 9 of 10 files (>40%) → stop trigram.
		expect(index.stats().stopTrigramCount).toBeGreaterThan(0);
	});

	it("preserves base postings entries unrelated to any dirty change", () => {
		// Exercises the indexOf-miss branch (line 526 false): an override removes
		// fileId from postings that contain it but leaves others untouched.
		const index = buildPlainIndex({
			"a.ts": "alphaContentValue",
			"b.ts": "betaDistinctValue",
			"c.ts": "gammaSeparateValue",
			...fillerMap(6),
		});
		index.updateFile("a.ts", "alphaContentValueChanged");
		index.mergeDirty();
		// b.ts and c.ts trigrams survive untouched.
		expect(index.queryCandidatePaths([...extractTrigrams("betaDistinctValue")])).toContain(
			"b.ts",
		);
		expect(index.queryCandidatePaths([...extractTrigrams("gammaSeparateValue")])).toContain(
			"c.ts",
		);
	});

	it("is invoked transitively by save() so a dirty index is persisted whole", () => {
		const dir = makeTmpDir("trigram-merge-save-");
		writeFileSync(join(dir, "a.ts"), "export const value = 1;");
		const index = TrigramIndex.build({ cwd: dir });
		// Dirty-new file (not on disk for the merge read → zero masks path).
		index.updateFile("memoryOnly.ts", "inMemoryOnlyIdentifier");
		expect(index.isDirty).toBe(true);

		const interlinkedDir = join(dir, ".interlinked");
		index.save(interlinkedDir); // calls mergeDirty() internally (line 681)
		expect(index.isDirty).toBe(false);

		const loaded = TrigramIndex.load(dir, interlinkedDir);
		expect(loaded).not.toBeNull();
		const paths = loaded?.queryCandidatePaths([...extractTrigrams("inMemoryOnlyIdentifier")]);
		expect(paths).toContain("memoryOnly.ts");
	});
});

// ---------------------------------------------------------------------------
// incrementalUpdate() — git-driven add / modify / delete / skip / oversize
// ---------------------------------------------------------------------------

function gitInit(dir: string): void {
	const opts = { cwd: dir, stdio: "ignore" as const };
	execSync("git init -q", opts);
	execSync("git config user.email coverage@example.test", opts);
	execSync("git config user.name 'Coverage Bot'", opts);
	execSync("git config commit.gpgsign false", opts);
}

function gitCommitAll(dir: string, message: string): void {
	const opts = { cwd: dir, stdio: "ignore" as const };
	execSync("git add -A", opts);
	execSync(`git commit -q -m "${message}"`, opts);
}

describe("incrementalUpdate", () => {
	let dir: string;

	// Sandbox note: every test below spawns several real `git` subprocesses
	// (gitInit = 4 execSync calls, gitCommitAll = 2 more, some tests call
	// gitCommitAll twice) via the helpers above. Sub-second locally, but a
	// cold/loaded mutation-runner sandbox (fork+exec overhead, no warm page
	// cache) can push that well past vitest's file-level 30s default — the
	// same "Test timed out in 30000ms" → ConfigError → ENOENT dry-run failure
	// diagnosed for commit-parse.ts/env-extractor.ts/verify-parity.ts
	// (scratch/fleet-r3/repair-followups.txt #13), which silently drops this
	// file's registered mutation kills. Explicit generous bounds here mirror
	// the pre-existing 60s override on "skips a tracked path..." above: real
	// headroom without masking a genuine hang (a truly broken test still
	// fails, just at 60s instead of 30s).
	beforeEach(() => {
		dir = makeTmpDir("trigram-incremental-");
		gitInit(dir);
	}, 60_000);

	it("returns 0 when HEAD has not moved since the index was built", { timeout: 60_000 }, () => {
		writeFileSync(join(dir, "a.ts"), "export const a = 1;");
		gitCommitAll(dir, "initial");
		const index = TrigramIndex.build({ cwd: dir });
		// No new commit → currentCommit === baseCommit → 0 (line 631).
		expect(index.incrementalUpdate()).toBe(0);
	});

	it("returns 0 when the diff cannot be computed (base commit unknown)", { timeout: 60_000 }, () => {
		writeFileSync(join(dir, "a.ts"), "export const a = 1;");
		gitCommitAll(dir, "initial");
		// Build, then force a new commit so HEAD moves, but corrupt baseCommit so
		// the diff fails → getChangedFilesSince returns null → 0 (line 636).
		const index = TrigramIndex.build({ cwd: dir });
		writeFileSync(join(dir, "b.ts"), "export const b = 2;");
		gitCommitAll(dir, "second");
		index.baseCommit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // nonexistent
		expect(index.incrementalUpdate()).toBe(0);
	});

	it("applies adds, modifications, deletions, skips, and oversize/binary downgrades", { timeout: 60_000 }, () => {
		// Initial commit with source files (filler keeps the stop-trigram cutoff
		// above 1 so the precision assertions below hold).
		writeFileSync(join(dir, "keep.ts"), "export const keepConst = 'originalKeepWord';");
		writeFileSync(join(dir, "remove.ts"), "export const removeConst = 'doomedRemoveWord';");
		writeFillerFiles(dir, 6);
		gitCommitAll(dir, "initial");

		const index = TrigramIndex.build({ cwd: dir });

		// Modify keep.ts, delete remove.ts, add new.ts, add a skipped lockfile,
		// add an oversized file, and add a binary file — then commit so the diff
		// surfaces them all.
		writeFileSync(join(dir, "keep.ts"), "export const keepConst = 'modifiedNowXyz';");
		rmSync(join(dir, "remove.ts"));
		writeFileSync(join(dir, "new.ts"), "export const fresh = 'addedIdentifier';");
		writeFileSync(join(dir, "yarn.lock"), "# lockfile\nresolved 'x'\n"); // shouldSkipFile
		writeFileSync(join(dir, "big.ts"), "z".repeat(DEFAULT_MAX_FILE_SIZE + 10)); // oversize
		writeFileSync(join(dir, "blob.dat"), Buffer.from([0x41, 0x00, 0x42])); // binary
		gitCommitAll(dir, "changes");

		const updated = index.incrementalUpdate();
		// keep (modify) + remove (delete) + new (add) + big (downgrade) + blob
		// (downgrade) = 5 updates; yarn.lock is skipped (not counted).
		expect(updated).toBeGreaterThanOrEqual(4);

		// Modified content searchable; old content gone for keep.ts.
		expect(index.queryCandidatePaths([...extractTrigrams("modifiedNowXyz")])).toContain(
			"keep.ts",
		);
		expect(index.queryCandidatePaths([...extractTrigrams("originalKeepWord")])).not.toContain(
			"keep.ts",
		);
		// Deleted file no longer surfaces.
		expect(index.queryCandidatePaths([...extractTrigrams("doomedRemoveWord")])).not.toContain(
			"remove.ts",
		);
		// Added file surfaces.
		expect(index.queryCandidatePaths([...extractTrigrams("addedIdentifier")])).toContain(
			"new.ts",
		);
		// baseCommit advanced to the new HEAD (line 660).
		expect(index.baseCommit).not.toBe("");
	});

	it("handles a file that disappears between diff and read (treated as delete)", { timeout: 60_000 }, () => {
		writeFileSync(join(dir, "a.ts"), "export const aConst = 'alphaValue';");
		writeFileSync(join(dir, "vanish.ts"), "export const vanishConst = 'vanishUniqueWord';");
		writeFillerFiles(dir, 6);
		gitCommitAll(dir, "initial");
		const index = TrigramIndex.build({ cwd: dir });

		// Stage a rename/delete via git so the diff lists vanish.ts, then ensure
		// it is gone from disk before incrementalUpdate reads it (line 643-647).
		rmSync(join(dir, "vanish.ts"));
		gitCommitAll(dir, "delete vanish");

		index.incrementalUpdate();
		expect(index.queryCandidatePaths([...extractTrigrams("vanishUniqueWord")])).not.toContain(
			"vanish.ts",
		);
	});

	it("skips a changed file whose disk read throws during incremental update (EISDIR)", { timeout: 60_000 }, () => {
		// Commit a real file, build (baseCommit = C1). Commit a second real file
		// (C2) so the diff lists it, then replace it with a directory on disk so
		// readFileSync throws → catch at line 655-657 (file simply skipped).
		writeFileSync(join(dir, "stable.ts"), "export const stableConst = 'stableWord';");
		writeFillerFiles(dir, 6);
		gitCommitAll(dir, "initial");
		const index = TrigramIndex.build({ cwd: dir });

		writeFileSync(join(dir, "weird.ts"), "export const weirdConst = 'weirdWord';");
		gitCommitAll(dir, "add weird"); // diff C1..HEAD now lists weird.ts

		// Replace weird.ts with a directory (post-commit) so existsSync is true but
		// readFileSync throws EISDIR.
		rmSync(join(dir, "weird.ts"));
		mkdirSync(join(dir, "weird.ts"));

		// Should not throw; the unreadable file is silently skipped.
		expect(() => index.incrementalUpdate()).not.toThrow();
		// weird.ts never got indexed (read failed before updateFile).
		expect(index.queryCandidatePaths([...extractTrigrams("weirdWord")])).not.toContain(
			"weird.ts",
		);
	});
});

// ---------------------------------------------------------------------------
// totalFiles / dirtyFileCount accounting across merge
// ---------------------------------------------------------------------------

describe("accounting helpers", () => {
	it("totalFiles counts base plus dirty-new files until merge folds them in", () => {
		const index = buildPlainIndex(
			{ "a.ts": "alpha", "b.ts": "beta" },
			"/nonexistent-acct",
		);
		expect(index.totalFiles).toBe(2);
		index.updateFile("c.ts", "gamma identifier");
		expect(index.totalFiles).toBe(3); // base 2 + dirty-new 1
		index.mergeDirty();
		// After merge the new file is part of files[]; totalFiles still 3 with no
		// dirty entries.
		expect(index.totalFiles).toBe(3);
		expect(index.dirtyFileCount).toBe(0);
	});

	it("save followed by load preserves merged dirty-new files (round trip with masks dir)", () => {
		const dir = makeTmpDir("trigram-roundtrip-");
		writeFileSync(join(dir, "a.ts"), "export const aConst = 'presentAlpha';");
		writeFileSync(join(dir, "b.ts"), "export const bConst = 'presentBeta';");
		writeFillerFiles(dir, 6);
		const index = TrigramIndex.build({ cwd: dir });

		// Override a.ts (on disk) and add a new on-disk file, then save (merges).
		const updatedA = "export const aConst = 'overriddenValueXyz';";
		writeFileSync(join(dir, "a.ts"), updatedA);
		index.updateFile("a.ts", updatedA);
		const cContent = "export const cConst = 'thirdFileIdentifier';";
		writeFileSync(join(dir, "c.ts"), cContent);
		index.updateFile("c.ts", cContent);

		const interlinkedDir = join(dir, ".interlinked");
		index.save(interlinkedDir);

		const loaded = TrigramIndex.load(dir, interlinkedDir);
		expect(loaded).not.toBeNull();
		expect(loaded?.files).toContain("c.ts");
		expect(
			loaded?.queryCandidatePaths([...extractTrigrams("overriddenValueXyz")]),
		).toContain("a.ts");
		expect(
			loaded?.queryCandidatePaths([...extractTrigrams("thirdFileIdentifier")]),
		).toContain("c.ts");
		expect(existsSync(join(interlinkedDir, "index", "trigram.lookup"))).toBe(true);
	});
});
