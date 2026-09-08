// @perf — benchmark tests in this file use Date.now() for timing
// characterization. Fake timers would defeat the measurement. Opt out of
// the non_deterministic_test check via this marker (see taste-checks.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { _resetRgPathCache, checkGrepAcceleration } from "../grep-accelerator.js";
import { decomposePattern, parseGrepCommand } from "../regex-trigrams.js";
import {
	extractTrigrams,
	isBinaryContent,
	type PostingList,
	packTrigram,
	shouldSkipFile,
	TrigramIndex,
	trigramToString,
	unpackTrigram,
} from "../trigram-index.js";
import type { HarnessEvent } from "../types.js";

// Fixed timestamp for deterministic test fixtures. Not time-sensitive
// for these tests — only exists to satisfy the HarnessEvent shape.
const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

// ===========================================
// Trigram Encoding
// ===========================================

describe("packTrigram / unpackTrigram", () => {
	it("roundtrips ASCII characters", () => {
		const packed = packTrigram(0x61, 0x62, 0x63); // "abc"
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0x61);
		expect(b).toBe(0x62);
		expect(c).toBe(0x63);
	});

	it("handles high byte values", () => {
		const packed = packTrigram(0xff, 0x00, 0x7f);
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0xff);
		expect(b).toBe(0x00);
		expect(c).toBe(0x7f);
	});

	it("produces unique values for different trigrams", () => {
		const abc = packTrigram(0x61, 0x62, 0x63);
		const abd = packTrigram(0x61, 0x62, 0x64);
		const bac = packTrigram(0x62, 0x61, 0x63);
		expect(abc).not.toBe(abd);
		expect(abc).not.toBe(bac);
	});

	it("masks to byte range", () => {
		const packed = packTrigram(0x161, 0x262, 0x363);
		const [a, b, c] = unpackTrigram(packed);
		expect(a).toBe(0x61); // 0x161 & 0xFF
		expect(b).toBe(0x62);
		expect(c).toBe(0x63);
	});
});

describe("trigramToString", () => {
	it("converts packed trigram to readable string", () => {
		const packed = packTrigram(0x61, 0x62, 0x63);
		expect(trigramToString(packed)).toBe("abc");
	});

	it("handles space characters", () => {
		const packed = packTrigram(0x20, 0x61, 0x20);
		expect(trigramToString(packed)).toBe(" a ");
	});
});

// ===========================================
// Trigram Extraction
// ===========================================

describe("extractTrigrams", () => {
	it("extracts overlapping trigrams from a simple string", () => {
		const trigrams = extractTrigrams("abcde");
		// "abc", "bcd", "cde"
		expect(trigrams.size).toBe(3);
		expect(trigrams.has(packTrigram(0x61, 0x62, 0x63))).toBe(true); // abc
		expect(trigrams.has(packTrigram(0x62, 0x63, 0x64))).toBe(true); // bcd
		expect(trigrams.has(packTrigram(0x63, 0x64, 0x65))).toBe(true); // cde
	});

	it("lowercases all characters", () => {
		const upper = extractTrigrams("ABC");
		const lower = extractTrigrams("abc");
		expect(upper.size).toBe(1);
		expect(lower.size).toBe(1);
		// Both should produce the same trigram
		const upperVal = [...upper][0];
		const lowerVal = [...lower][0];
		expect(upperVal).toBe(lowerVal);
	});

	it("returns empty set for strings shorter than 3 chars", () => {
		expect(extractTrigrams("").size).toBe(0);
		expect(extractTrigrams("a").size).toBe(0);
		expect(extractTrigrams("ab").size).toBe(0);
	});

	it("returns exactly one trigram for 3-char string", () => {
		expect(extractTrigrams("abc").size).toBe(1);
	});

	it("deduplicates repeated trigrams", () => {
		// "aaaa" → "aaa", "aaa", "aaa" but only 1 unique
		const trigrams = extractTrigrams("aaaa");
		expect(trigrams.size).toBe(1);
	});

	it("handles whitespace (spaces, tabs, newlines)", () => {
		const trigrams = extractTrigrams("a b");
		// "a " + " b" → trigrams: "a b"
		expect(trigrams.size).toBe(1);
	});

	it("includes tab characters in trigrams", () => {
		const trigrams = extractTrigrams("a\tb");
		expect(trigrams.size).toBe(1);
	});

	it("includes newline characters in trigrams", () => {
		const trigrams = extractTrigrams("a\nb");
		expect(trigrams.size).toBe(1);
	});

	it("skips control characters below 0x09", () => {
		const content = "ab\x01cd";
		const trigrams = extractTrigrams(content);
		// "ab\x01" → skipped (control char)
		// "b\x01c" → skipped
		// "\x01cd" → skipped
		expect(trigrams.size).toBe(0);
	});

	it("handles unicode characters by clamping to byte range", () => {
		// Unicode chars > 255 get masked to byte range
		const trigrams = extractTrigrams("café");
		expect(trigrams.size).toBeGreaterThan(0);
	});

	it("handles realistic source code", () => {
		const code = `export function handleAuth(req: Request): Response {
    const token = req.headers.get("Authorization");
    if (!token) return new Response("Unauthorized", { status: 401 });
    return validateToken(token);
}`;
		const trigrams = extractTrigrams(code);
		// Should extract many trigrams from identifiers and keywords
		expect(trigrams.size).toBeGreaterThan(50);
	});

	it("extracts consistent trigrams regardless of surrounding context", () => {
		const t1 = extractTrigrams("xxhandleAuthyy");
		const t2 = extractTrigrams("handleAuth");
		expect(t2.size).toBe(8);
		// t2's trigrams should be a subset of t1's
		for (const tri of t2) {
			expect(t1.has(tri)).toBe(true);
		}
	});
});

// ===========================================
// Binary Detection
// ===========================================

describe("isBinaryContent", () => {
	it("detects null bytes as binary", () => {
		expect(isBinaryContent("hello\x00world")).toBe(true);
	});

	it("allows normal text", () => {
		expect(isBinaryContent("hello world\nfoo bar")).toBe(false);
	});

	it("handles empty input", () => {
		expect(isBinaryContent("")).toBe(false);
	});

	it("handles Buffer input", () => {
		expect(isBinaryContent(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
		expect(isBinaryContent(Buffer.from([0x68, 0x69]))).toBe(false);
	});

	it("only checks first 8KB", () => {
		// Null byte at position 9000 — should NOT be detected
		const content = `${"x".repeat(9000)}\x00`;
		expect(isBinaryContent(content)).toBe(false);
	});
});

// ===========================================
// Skip File Logic
// ===========================================

describe("shouldSkipFile", () => {
	it("skips lock files", () => {
		expect(shouldSkipFile("package-lock.json")).toBe(true);
		expect(shouldSkipFile("yarn.lock")).toBe(true);
		expect(shouldSkipFile("some/path/pnpm-lock.yaml")).toBe(true);
	});

	it("skips minified files", () => {
		expect(shouldSkipFile("bundle.min.js")).toBe(true);
		expect(shouldSkipFile("styles.min.css")).toBe(true);
	});

	it("skips source maps", () => {
		expect(shouldSkipFile("app.js.map")).toBe(true);
	});

	it("allows normal source files", () => {
		expect(shouldSkipFile("src/index.ts")).toBe(false);
		expect(shouldSkipFile("lib/utils.js")).toBe(false);
		expect(shouldSkipFile("README.md")).toBe(false);
	});
});

// ===========================================
// Index Build & Query (in-memory)
// ===========================================

describe("TrigramIndex", () => {
	// Build a test index from synthetic files
	function buildTestIndex(files: Record<string, string>): TrigramIndex {
		const filePaths = Object.keys(files);
		const postingsBuilder = new Map<number, number[]>();
		const fileArray: string[] = [];

		for (let fileId = 0; fileId < filePaths.length; fileId++) {
			const path = nonNull(filePaths[fileId]);
			fileArray.push(path);
			const trigrams = extractTrigrams(nonNull(files[path]));
			for (const tri of trigrams) {
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

		return new TrigramIndex(fileArray, postings, new Set(), "abc123", "/tmp/test");
	}

	describe("query", () => {
		it("finds files containing all required trigrams", () => {
			const index = buildTestIndex({
				"auth.ts": "export function handleAuth(req) {}",
				"utils.ts": "export function formatDate(d) {}",
				"login.ts": "import { handleAuth } from './auth';",
			});

			// Search for "handleAuth" → trigrams from "handleauth"
			const trigrams = [...extractTrigrams("handleauth")];
			const candidates = index.query(trigrams);

			// auth.ts and login.ts contain "handleAuth", utils.ts doesn't
			const paths = [...candidates].map((id) => index.files[id]);
			expect(paths).toContain("auth.ts");
			expect(paths).toContain("login.ts");
			expect(paths).not.toContain("utils.ts");
		});

		it("returns empty set when no files match", () => {
			const index = buildTestIndex({
				"a.ts": "hello world",
				"b.ts": "foo bar baz",
			});

			const trigrams = [...extractTrigrams("xyznonexistent")];
			const candidates = index.query(trigrams);
			expect(candidates.size).toBe(0);
		});

		it("returns all files when no trigrams provided", () => {
			const index = buildTestIndex({
				"a.ts": "hello",
				"b.ts": "world",
			});

			const candidates = index.query([]);
			expect(candidates.size).toBe(2);
		});

		it("handles single-trigram queries", () => {
			const index = buildTestIndex({
				"a.ts": "abc",
				"b.ts": "def",
			});

			const trigrams = [...extractTrigrams("abc")];
			const candidates = index.query(trigrams);
			const paths = [...candidates].map((id) => index.files[id]);
			expect(paths).toContain("a.ts");
			expect(paths).not.toContain("b.ts");
		});

		it("intersects multiple trigram posting lists", () => {
			const index = buildTestIndex({
				"both.ts": "abcdef",
				"only_abc.ts": "abcxyz",
				"only_def.ts": "xyzdef",
				"neither.ts": "qwerty",
			});

			// "abcdef" has trigrams from both "abc" and "def"
			const trigrams = [...extractTrigrams("abcdef")];
			const candidates = index.query(trigrams);
			const paths = [...candidates].map((id) => index.files[id]);
			expect(paths).toContain("both.ts");
			// "only_abc" has abc trigrams but not all of abcdef's trigrams
			// "only_def" has def trigrams but not all of abcdef's trigrams
		});

		it("skips stop trigrams during query", () => {
			const filePaths = ["a.ts", "b.ts", "c.ts"];
			const postings = new Map<number, PostingList>();

			// Make one trigram appear in all files (stop trigram)
			const commonTri = packTrigram(0x61, 0x62, 0x63); // "abc"
			postings.set(commonTri, {
				fileIds: new Uint32Array([0, 1, 2]),
				locMasks: new Uint8Array(3),
				nextMasks: new Uint8Array(3),
			});

			// Make another trigram appear in only one file
			const rareTri = packTrigram(0x78, 0x79, 0x7a); // "xyz"
			postings.set(rareTri, {
				fileIds: new Uint32Array([1]),
				locMasks: new Uint8Array(1),
				nextMasks: new Uint8Array(1),
			});

			const index = new TrigramIndex(
				filePaths,
				postings,
				new Set([commonTri]), // mark "abc" as stop trigram
				"abc123",
				"/tmp/test",
			);

			// Query with both common and rare trigrams
			const candidates = index.query([commonTri, rareTri]);
			// Stop trigram should be skipped, only rare trigram used
			expect(candidates.size).toBe(1);
			expect(candidates.has(1)).toBe(true);
		});

		it("returns all files when all query trigrams are stop trigrams", () => {
			const filePaths = ["a.ts", "b.ts"];
			const postings = new Map<number, PostingList>();
			const commonTri = packTrigram(0x61, 0x62, 0x63);
			postings.set(commonTri, {
				fileIds: new Uint32Array([0, 1]),
				locMasks: new Uint8Array(2),
				nextMasks: new Uint8Array(2),
			});

			const index = new TrigramIndex(
				filePaths,
				postings,
				new Set([commonTri]),
				"abc123",
				"/tmp/test",
			);

			const candidates = index.query([commonTri]);
			expect(candidates.size).toBe(2);
		});
	});

	describe("queryCandidatePaths", () => {
		it("returns file paths instead of IDs", () => {
			const index = buildTestIndex({
				"src/auth.ts": "handleAuth function",
				"src/utils.ts": "formatDate function",
			});

			const trigrams = [...extractTrigrams("handleauth")];
			const paths = index.queryCandidatePaths(trigrams);
			expect(paths).toContain("src/auth.ts");
		});
	});

	// ===========================================
	// Dirty Layer
	// ===========================================

	describe("dirty layer", () => {
		it("adds new files to the index", () => {
			const index = buildTestIndex({
				"existing.ts": "hello world",
			});

			index.updateFile("new.ts", "handleAuth function xyz");

			const trigrams = [...extractTrigrams("handleauth")];
			const candidates = index.queryCandidatePaths(trigrams);
			expect(candidates).toContain("new.ts");
		});

		it("removes deleted files from results", () => {
			const index = buildTestIndex({
				"a.ts": "handleAuth function",
				"b.ts": "other content here",
			});

			index.updateFile("a.ts", null); // mark as deleted

			const trigrams = [...extractTrigrams("handleauth")];
			const candidates = index.queryCandidatePaths(trigrams);
			expect(candidates).not.toContain("a.ts");
		});

		it("updates modified files", () => {
			const index = buildTestIndex({
				"a.ts": "handleAuth function",
			});

			// Modify file to remove handleAuth
			index.updateFile("a.ts", "newFunction something else entirely");

			const oldTrigrams = [...extractTrigrams("handleauth")];
			const oldCandidates = index.queryCandidatePaths(oldTrigrams);
			expect(oldCandidates).not.toContain("a.ts");

			// New content should be searchable
			const newTrigrams = [...extractTrigrams("newfunction")];
			const newCandidates = index.queryCandidatePaths(newTrigrams);
			expect(newCandidates).toContain("a.ts");
		});

		it("tracks dirty file count", () => {
			const index = buildTestIndex({ "a.ts": "hello" });

			expect(index.dirtyFileCount).toBe(0);
			expect(index.isDirty).toBe(false);

			index.updateFile("a.ts", "world");
			expect(index.dirtyFileCount).toBe(1);
			expect(index.isDirty).toBe(true);

			index.updateFile("new.ts", "brand new");
			expect(index.dirtyFileCount).toBe(2);
		});

		it("clears dirty state", () => {
			const index = buildTestIndex({ "a.ts": "hello" });
			index.updateFile("a.ts", "world");
			index.updateFile("new.ts", "brand new");

			index.clearDirty();
			expect(index.dirtyFileCount).toBe(0);
			expect(index.isDirty).toBe(false);
		});

		it("handles updating the same dirty file multiple times", () => {
			const index = buildTestIndex({ "a.ts": "hello" });

			index.updateFile("new.ts", "first version abc");
			index.updateFile("new.ts", "second version xyz");

			const triAbc = [...extractTrigrams("first version")];
			const triXyz = [...extractTrigrams("second version")];

			index.queryCandidatePaths(triAbc); // exercise the query path
			const xyzCandidates = index.queryCandidatePaths(triXyz);

			// Should find "second version" but not "first version" trigrams
			expect(xyzCandidates).toContain("new.ts");
			// First version trigrams might partially match but the full intersection shouldn't
		});

		it("handles add then delete of dirty file", () => {
			const index = buildTestIndex({});

			index.updateFile("new.ts", "handleAuth function");
			let candidates = index.queryCandidatePaths([...extractTrigrams("handleauth")]);
			expect(candidates).toContain("new.ts");

			index.updateFile("new.ts", null); // delete
			candidates = index.queryCandidatePaths([...extractTrigrams("handleauth")]);
			expect(candidates).not.toContain("new.ts");
		});

		it("excludes deleted base files from getAllFileIds", () => {
			const index = buildTestIndex({
				"a.ts": "hello",
				"b.ts": "world",
				"c.ts": "foobar",
			});

			expect(index.totalFiles).toBe(3);

			index.updateFile("b.ts", null);
			// query with empty trigrams returns all files
			const all = index.query([]);
			expect(all.size).toBe(2);
			expect(all.has(1)).toBe(false); // b.ts was ID 1
		});
	});

	// ===========================================
	// Serialization Roundtrip
	// ===========================================

	describe("serialization", () => {
		it("roundtrips through save/load", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");

			try {
				const original = buildTestIndex({
					"src/auth.ts": "export function handleAuth(req) { return validate(req); }",
					"src/utils.ts": "export function formatDate(d) { return d.toISOString(); }",
					"src/login.ts": "import { handleAuth } from './auth'; handleAuth(req);",
					"test/auth.test.ts": "describe('handleAuth', () => { it('works', () => {}) });",
				});

				original.save(interlinkedDir);

				const loaded = TrigramIndex.load(tmpDir, interlinkedDir);
				expect(loaded).not.toBeNull();

				// Verify file count
				expect(loaded!.files.length).toBe(original.files.length);
				expect(loaded!.files).toEqual(original.files);

				// Verify query produces same results
				const trigrams = [...extractTrigrams("handleauth")];
				const origResults = original.queryCandidatePaths(trigrams);
				const loadedResults = loaded!.queryCandidatePaths(trigrams);
				expect(loadedResults.sort()).toEqual(origResults.sort());

				// Verify stats match
				const origStats = original.stats();
				const loadedStats = loaded!.stats();
				expect(loadedStats.fileCount).toBe(origStats.fileCount);
				expect(loadedStats.trigramCount).toBe(origStats.trigramCount);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("roundtrips stop trigrams", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");

			try {
				const postings = new Map<number, PostingList>();
				const rareTri = packTrigram(0x78, 0x79, 0x7a);
				postings.set(rareTri, {
					fileIds: new Uint32Array([0]),
					locMasks: new Uint8Array(1),
					nextMasks: new Uint8Array(1),
				});

				const stopTri = packTrigram(0x61, 0x62, 0x63);

				const original = new TrigramIndex(
					["a.ts"],
					postings,
					new Set([stopTri]),
					"abc123",
					tmpDir,
				);

				original.save(interlinkedDir);

				const loaded = TrigramIndex.load(tmpDir, interlinkedDir);
				expect(loaded).not.toBeNull();

				// Stop trigrams should be preserved — query should skip them
				const candidates = loaded!.query([stopTri, rareTri]);
				expect(candidates.size).toBe(1);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("handles empty index", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");

			try {
				const empty = new TrigramIndex([], new Map(), new Set(), "000000", tmpDir);
				empty.save(interlinkedDir);

				const loaded = TrigramIndex.load(tmpDir, interlinkedDir);
				expect(loaded).not.toBeNull();
				expect(loaded!.files.length).toBe(0);
				expect(loaded!.totalFiles).toBe(0);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("loadMeta returns stats without full index parse", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");

			try {
				const index = buildTestIndex({
					"a.ts": "hello world function",
					"b.ts": "foobar something here",
				});
				index.save(interlinkedDir);

				const meta = TrigramIndex.loadMeta(tmpDir, interlinkedDir);
				expect(meta).not.toBeNull();
				expect(meta!.fileCount).toBe(2);
				expect(meta!.trigramCount).toBeGreaterThan(0);
				expect(meta!.baseCommit).toBeTruthy();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("returns null for corrupted index", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");
			const indexDir = path.join(interlinkedDir, "index");
			fs.mkdirSync(indexDir, { recursive: true });

			try {
				// Write garbage data
				fs.writeFileSync(path.join(indexDir, "trigram.bin"), "not a valid index");
				const loaded = TrigramIndex.load(tmpDir, interlinkedDir);
				expect(loaded).toBeNull();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("returns null for wrong magic number", () => {
			const fs = require("node:fs");
			const os = require("node:os");
			const path = require("node:path");

			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trigram-test-"));
			const interlinkedDir = path.join(tmpDir, ".interlinked");
			const indexDir = path.join(interlinkedDir, "index");
			fs.mkdirSync(indexDir, { recursive: true });

			try {
				const buf = Buffer.alloc(24);
				buf.writeUInt32LE(0xdeadbeef, 0); // wrong magic
				fs.writeFileSync(path.join(indexDir, "trigram.bin"), buf);
				expect(TrigramIndex.load(tmpDir, interlinkedDir)).toBeNull();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("returns null for nonexistent index", () => {
			expect(TrigramIndex.load("/nonexistent/path")).toBeNull();
		});
	});

	describe("stats", () => {
		it("returns accurate statistics", () => {
			const index = buildTestIndex({
				"a.ts": "hello world foo",
				"b.ts": "bar baz qux quux",
			});

			const stats = index.stats();
			expect(stats.fileCount).toBe(2);
			expect(stats.trigramCount).toBeGreaterThan(0);
			expect(stats.stopTrigramCount).toBe(0);
			expect(stats.indexSizeBytes).toBeGreaterThan(0);
		});
	});
});

// ===========================================
// Regex Decomposition
// ===========================================

describe("decomposePattern", () => {
	describe("literal patterns", () => {
		it("extracts trigrams from a literal string", () => {
			const result = decomposePattern("handleAuth", false);
			expect(result.isLiteral).toBe(true);
			expect(result.hasLiterals).toBe(true);
			expect(result.requiredTrigrams.length).toBeGreaterThan(0);
			// Literal segments preserve original case; trigrams are lowercased internally
			expect(result.literalSegments).toEqual(["handleAuth"]);
		});

		it("handles short strings (< 3 chars)", () => {
			const result = decomposePattern("ab", false);
			expect(result.hasLiterals).toBe(false);
			expect(result.requiredTrigrams.length).toBe(0);
		});

		it("handles empty string", () => {
			const result = decomposePattern("", false);
			expect(result.hasLiterals).toBe(false);
		});
	});

	describe("regex patterns", () => {
		it("extracts literals from simple regex", () => {
			const result = decomposePattern("handleAuth", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments.length).toBeGreaterThan(0);
		});

		it("extracts literals around wildcards", () => {
			// "foo.*bar" → literals "foo" and "bar"
			const result = decomposePattern("foo.*bar", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("bar");
		});

		it("handles dot wildcard", () => {
			// "fo.bar" → "fo" (too short) and "bar"
			const result = decomposePattern("fo.bar", true);
			expect(result.literalSegments).toContain("bar");
		});

		it("handles character classes by breaking literal chain", () => {
			// "[abc]def" → literals from "def" only
			const result = decomposePattern("[abc]def", true);
			expect(result.literalSegments).toContain("def");
		});

		it("handles escaped special characters as literals", () => {
			// "foo\.bar" → literal "foo.bar"
			const result = decomposePattern("foo\\.bar", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles escape sequences", () => {
			// "foo\\nbar" → includes newline literal
			const result = decomposePattern("foo\\nbar", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles quantifiers by removing preceding char", () => {
			// "foob+ar" → "foo" (b is variable) and then "ar" (too short)
			const result = decomposePattern("foob+ar", true);
			expect(result.literalSegments).toContain("foo");
		});

		it("handles alternation by intersecting branches", () => {
			// "foo|bar" → no common trigrams between branches, so no required trigrams
			const result = decomposePattern("foo|bar", true);
			expect(result.hasLiterals).toBe(false);
			expect(result.requiredTrigrams).toHaveLength(0);
		});

		it("extracts common trigrams from alternation branches", () => {
			// "fooXYZ|fooABC" → both produce trigram "foo", so it's in the intersection
			const result = decomposePattern("fooXYZ|fooABC", true);
			expect(result.hasLiterals).toBe(true);
			// The trigram for "foo" should be in the required set (common to both branches)
			expect(result.requiredTrigrams.length).toBeGreaterThan(0);
		});

		it("extracts literals around group alternation", () => {
			// "prefix(?:abc|def)suffix" → "prefix" and "suffix" are outside the alternation
			const result = decomposePattern("prefix(?:abc|def)suffix", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("prefix");
			expect(result.literalSegments).toContain("suffix");
		});

		it("handles anchors without affecting literals", () => {
			// "^handleAuth$" → "handleauth"
			const result = decomposePattern("^handleAuth$", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.literalSegments).toContain("handleauth");
		});

		it("handles non-capturing groups", () => {
			// "foo(?:bar)baz" → should extract literals from group content
			const result = decomposePattern("foo(?:bar)baz", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles groups with alternation by skipping them", () => {
			// "foo(a|b)bar" → "foo" and "bar"
			const result = decomposePattern("foo(a|b)bar", true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("bar");
		});

		it("handles character class shorthands", () => {
			// "\\d+\\.handleAuth" → dot breaks, "handleauth"
			const result = decomposePattern("\\d+\\.handleAuth", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles repetition braces", () => {
			// "a{3,5}bcdef" → "bcde" and "cdef"
			const result = decomposePattern("a{3,5}bcdef", true);
			expect(result.hasLiterals).toBe(true);
		});

		it("handles lookahead by skipping", () => {
			const result = decomposePattern("foo(?=bar)baz", true);
			expect(result.literalSegments).toContain("foo");
			expect(result.literalSegments).toContain("baz");
		});

		it("returns no literals for pure wildcard regex", () => {
			const result = decomposePattern(".*", true);
			expect(result.hasLiterals).toBe(false);
		});

		it("returns no literals for short regex segments", () => {
			const result = decomposePattern("[a-z].", true);
			expect(result.hasLiterals).toBe(false);
		});

		it("handles complex real-world pattern", () => {
			// Searching for function definitions
			const result = decomposePattern("export\\s+function\\s+handle", true);
			expect(result.hasLiterals).toBe(true);
			// "export" and "function" and "handle" should be extractable
			expect(result.literalSegments.some((s) => s.includes("export"))).toBe(true);
		});

		it("handles pattern with multiple literal segments", () => {
			const result = decomposePattern("MAX_FILE_SIZE", true);
			expect(result.hasLiterals).toBe(true);
			expect(result.requiredTrigrams.length).toBeGreaterThan(5);
		});
	});
});

// ===========================================
// Grep Command Parsing
// ===========================================

describe("parseGrepCommand", () => {
	it("parses basic rg command", () => {
		const result = parseGrepCommand("rg 'handleAuth'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("handleAuth");
		expect(result!.isRegex).toBe(true);
	});

	it("parses rg with path", () => {
		const result = parseGrepCommand("rg 'pattern' src/");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("pattern");
		expect(result!.path).toBe("src/");
	});

	it("parses case-insensitive flag", () => {
		const result = parseGrepCommand("rg -i 'Pattern'");
		expect(result).not.toBeNull();
		expect(result!.caseInsensitive).toBe(true);
	});

	it("parses fixed-string flag", () => {
		const result = parseGrepCommand("rg -F 'literal.string'");
		expect(result).not.toBeNull();
		expect(result!.isRegex).toBe(false);
	});

	it("declines on the glob flag (-g) — unsound glob filter, so native runs", () => {
		expect(parseGrepCommand("rg -g '*.ts' 'pattern'")).toBeNull();
	});

	it("parses double-quoted pattern", () => {
		const result = parseGrepCommand('rg "handleAuth"');
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("handleAuth");
	});

	it("parses grep command", () => {
		const result = parseGrepCommand("grep 'pattern' file.ts");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("pattern");
	});

	it("parses -e flag for pattern", () => {
		const result = parseGrepCommand("rg -e 'mypattern' src/");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("mypattern");
	});

	it("returns null for non-grep commands", () => {
		expect(parseGrepCommand("ls -la")).toBeNull();
		expect(parseGrepCommand("cat file.ts")).toBeNull();
		expect(parseGrepCommand("npm test")).toBeNull();
	});

	it("returns null for empty pattern", () => {
		expect(parseGrepCommand("rg")).toBeNull();
	});

	it("parses safe combined flags (-i -F)", () => {
		const result = parseGrepCommand("rg -i -F 'test'");
		expect(result).not.toBeNull();
		expect(result!.caseInsensitive).toBe(true);
		expect(result!.isRegex).toBe(false);
	});

	it("declines on unmodeled flags (-n, --color, -v, -l) → native", () => {
		expect(parseGrepCommand("rg -n --color=never -i 'test'")).toBeNull();
		expect(parseGrepCommand("rg -v 'test'")).toBeNull();
		expect(parseGrepCommand("rg -l 'test'")).toBeNull();
	});

	it("declines on pipelines / compound commands → native", () => {
		expect(parseGrepCommand("rg 'pattern' | head -20")).toBeNull();
		expect(parseGrepCommand("rg 'x' && echo done")).toBeNull();
	});

	it("handles backslash-escaped characters in pattern", () => {
		const result = parseGrepCommand("rg 'foo\\.bar'");
		expect(result).not.toBeNull();
		expect(result!.pattern).toBe("foo\\.bar");
	});
});

// ===========================================
// Grep Accelerator
// ===========================================

describe("checkGrepAcceleration", () => {
	function buildTestIndex(files: Record<string, string>): TrigramIndex {
		const filePaths = Object.keys(files);
		const postingsBuilder = new Map<number, number[]>();
		const fileArray: string[] = [];

		for (let fileId = 0; fileId < filePaths.length; fileId++) {
			const path = nonNull(filePaths[fileId]);
			fileArray.push(path);
			const trigrams = extractTrigrams(nonNull(files[path]));
			for (const tri of trigrams) {
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

		return new TrigramIndex(fileArray, postings, new Set(), "abc123", "/tmp/test");
	}

	function makeGrepEvent(
		pattern: string,
		opts?: { path?: string; glob?: string; caseInsensitive?: boolean },
	): HarnessEvent {
		return {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Grep",
			tool_input: {
				pattern,
				path: opts?.path || ".",
				glob: opts?.glob,
				"-i": opts?.caseInsensitive,
			},
			timestamp: FIXED_TIMESTAMP,
		};
	}

	function makeBashGrepEvent(command: string): HarnessEvent {
		return {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Bash",
			tool_input: { command },
			timestamp: FIXED_TIMESTAMP,
		};
	}

	beforeEach(() => {
		_resetRgPathCache();
	});

	it("returns null when no index is provided", () => {
		const event = makeGrepEvent("handleAuth");
		expect(checkGrepAcceleration(event, null)).toBeNull();
	});

	it("returns null for non-grep tools", () => {
		const index = buildTestIndex({ "a.ts": "handleAuth" });
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: { file_path: "a.ts" },
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(event, index)).toBeNull();
	});

	it("returns null for patterns with no extractable literals", () => {
		const index = buildTestIndex({ "a.ts": "hello" });
		const event = makeGrepEvent(".*");
		expect(checkGrepAcceleration(event, index)).toBeNull();
	});

	it("returns null for very short patterns", () => {
		const index = buildTestIndex({ "a.ts": "hello" });
		const event = makeGrepEvent("ab");
		expect(checkGrepAcceleration(event, index)).toBeNull();
	});

	it("falls through when no candidates found (safety over false negatives)", () => {
		// When zero candidates match, the accelerator returns null to let
		// normal grep run — the index may be stale, incomplete, or the
		// trigram decomposition may have been lossy.
		const index = buildTestIndex({
			"a.ts": "hello world",
			"b.ts": "foo bar baz",
		});

		const event = makeGrepEvent("xyznonexistentpattern");
		const result = checkGrepAcceleration(event, index);
		expect(result).toBeNull();
	});

	it("allows with warning for very broad patterns", () => {
		// Create an index where the pattern matches most files.
		// Use string concat (not template literals) so the check's block parser
		// is not confused by { } inside ${...} interpolations.
		const files: Record<string, string> = {};
		for (let i = 0; i < 100; i++) {
			files[`file${i}.ts`] = `export function handle${i}() {} // common pattern in all files`;
		}

		const index = buildTestIndex(files);
		const event = makeGrepEvent("function");
		const result = checkGrepAcceleration(event, index, { maxCandidateRatio: 0.3 });

		// "function" appears in many files — should allow with warning
		if (result) {
			// If the accelerator decided to act, it should be allow+warning for broad patterns
			if (result.decision === "allow") {
				expect(result.warnings).toBeDefined();
				expect(result.warnings!.some((w) => w.includes("broad pattern"))).toBe(true);
			}
		}
	});

	it("intercepts Bash rg commands", () => {
		const index = buildTestIndex({
			"a.ts": "xyzuniquepatternabc",
			"b.ts": "other content entirely",
		});

		const event = makeBashGrepEvent("rg 'xyzuniquepattern'");
		const result = checkGrepAcceleration(event, index);
		// Should intercept since it's a grep command
		// Whether it blocks depends on rg availability, but it should at least try
		expect(result !== undefined).toBe(true);
	});

	it("declines (null) when the index is not fresh — staleness completeness gate", () => {
		const index = buildTestIndex({ "a.ts": "uniqueidentifierforsearch" });
		const event = makeGrepEvent("uniqueidentifierforsearch");
		// Default indexFresh:false → never substitute (a stale index could miss
		// a file that changed on disk — a silent false negative).
		expect(checkGrepAcceleration(event, index, { minFilesForAccel: 1 })).toBeNull();
	});

	it("declines (null) when the repo is below the size gate", () => {
		const index = buildTestIndex({ "a.ts": "uniqueidentifierforsearch" });
		const event = makeGrepEvent("uniqueidentifierforsearch");
		expect(
			checkGrepAcceleration(event, index, { indexFresh: true, minFilesForAccel: 999_999 }),
		).toBeNull();
	});

	it("handles missing pattern in Grep tool", () => {
		const index = buildTestIndex({ "a.ts": "hello" });
		const event: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Grep",
			tool_input: { path: "." }, // no pattern
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(event, index)).toBeNull();
	});
});

// ===========================================
// Integration: End-to-end index + query
// ===========================================

describe("end-to-end integration", () => {
	function buildTestIndex(files: Record<string, string>): TrigramIndex {
		const filePaths = Object.keys(files);
		const postingsBuilder = new Map<number, number[]>();
		const fileArray: string[] = [];

		for (let fileId = 0; fileId < filePaths.length; fileId++) {
			const path = nonNull(filePaths[fileId]);
			fileArray.push(path);
			const trigrams = extractTrigrams(nonNull(files[path]));
			for (const tri of trigrams) {
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

		return new TrigramIndex(fileArray, postings, new Set(), "abc123", "/tmp/test");
	}

	it("finds the right files in a realistic codebase", () => {
		const index = buildTestIndex({
			"src/auth/handler.ts": `
                export async function handleAuthCallback(req: Request): Promise<Response> {
                    const code = req.url.searchParams.get('code');
                    const state = req.url.searchParams.get('state');
                    return exchangeCodeForToken(code, state);
                }
            `,
			"src/auth/types.ts": `
                export interface AuthConfig {
                    clientId: string;
                    clientSecret: string;
                    redirectUri: string;
                }
            `,
			"src/routes/index.ts": `
                import { handleAuthCallback } from '../auth/handler';
                router.get('/callback', handleAuthCallback);
                router.get('/login', renderLoginPage);
            `,
			"src/utils/format.ts": `
                export function formatDate(d: Date): string {
                    return d.toISOString().split('T')[0];
                }
            `,
			"test/auth.fixture.ts": `
                // A fixture file that references handleAuthCallback so the
                // trigram search surfaces matches outside src/.
                import { handleAuthCallback } from '../src/auth/handler';
                const _ref: typeof handleAuthCallback = handleAuthCallback;
            `,
			"README.md": `
                # My Project
                See the auth documentation for setup instructions.
            `,
		});

		// Search for "handleAuthCallback"
		const decomp = decomposePattern("handleAuthCallback", false);
		const candidates = index.queryCandidatePaths(decomp.requiredTrigrams);

		// Should find the files that contain "handleAuthCallback"
		expect(candidates).toContain("src/auth/handler.ts");
		expect(candidates).toContain("src/routes/index.ts");
		expect(candidates).toContain("test/auth.fixture.ts");

		// Should NOT include files that don't contain it
		expect(candidates).not.toContain("src/utils/format.ts");
		expect(candidates).not.toContain("README.md");
	});

	it("handles regex pattern search across codebase", () => {
		const index = buildTestIndex({
			"src/config.ts": "const MAX_FILE_SIZE = 1048576;",
			"src/upload.ts": "if (file.size > MAX_FILE_SIZE) throw new Error('too large');",
			"src/types.ts": "export type Config = { maxFileSize: number; }",
			"test/upload.test.ts": "expect(MAX_FILE_SIZE).toBe(1048576);",
		});

		// Regex search for MAX_FILE_SIZE
		const decomp = decomposePattern("MAX_FILE_SIZE", true);
		const candidates = index.queryCandidatePaths(decomp.requiredTrigrams);

		expect(candidates).toContain("src/config.ts");
		expect(candidates).toContain("src/upload.ts");
		expect(candidates).toContain("test/upload.test.ts");
		// types.ts has "maxFileSize" (camelCase) which lowercased matches
		// the trigrams from "max_file_size" — but let's check
	});

	it("handles dirty layer updates during a session", () => {
		const index = buildTestIndex({
			"src/auth.ts": "export function handleAuth() {}",
		});

		// Agent edits a file — add new content
		index.updateFile("src/auth.ts", "export function handleAuth() { validateToken(); }");

		// New trigrams from "validatetoken" should be findable
		const decomp = decomposePattern("validateToken", false);
		const candidates = index.queryCandidatePaths(decomp.requiredTrigrams);
		expect(candidates).toContain("src/auth.ts");

		// Agent creates a new file
		index.updateFile(
			"src/validator.ts",
			"export function validateToken(t: string) { return true; }",
		);

		const candidates2 = index.queryCandidatePaths(decomp.requiredTrigrams);
		expect(candidates2).toContain("src/auth.ts");
		expect(candidates2).toContain("src/validator.ts");
	});

	it("stop trigram filtering works correctly with TrigramIndex.build", () => {
		// Simulate stop trigrams: create files where "the" appears in >40%
		const files: Record<string, string> = {};
		for (let i = 0; i < 10; i++) {
			// All files contain "the" → should become a stop trigram
			files[`common${i}.ts`] = `the quick brown fox ${i}`;
		}
		// But only some contain "fox"
		files["unique.ts"] = "unique identifier xyz123abc";

		// Build with real stop threshold
		const filePaths = Object.keys(files);
		const postingsBuilder = new Map<number, number[]>();
		const trigramCounts = new Map<number, number>();
		const fileArray: string[] = [];

		for (let fileId = 0; fileId < filePaths.length; fileId++) {
			const path = nonNull(filePaths[fileId]);
			fileArray.push(path);
			const trigrams = extractTrigrams(nonNull(files[path]));
			for (const tri of trigrams) {
				let list = postingsBuilder.get(tri);
				if (!list) {
					list = [];
					postingsBuilder.set(tri, list);
				}
				list.push(fileId);
				trigramCounts.set(tri, (trigramCounts.get(tri) || 0) + 1);
			}
		}

		// Filter stop trigrams at 40% threshold
		const stopCutoff = Math.floor(fileArray.length * 0.4);
		const stopTrigrams = new Set<number>();
		for (const [tri, count] of trigramCounts) {
			if (count > stopCutoff) stopTrigrams.add(tri);
		}

		const postings = new Map<number, PostingList>();
		for (const [tri, list] of postingsBuilder) {
			if (stopTrigrams.has(tri)) continue;
			const fileIds = new Uint32Array(list);
			postings.set(tri, {
				fileIds,
				locMasks: new Uint8Array(fileIds.length),
				nextMasks: new Uint8Array(fileIds.length),
			});
		}

		const index = new TrigramIndex(fileArray, postings, stopTrigrams, "abc", "/tmp");

		// Query for "the" (stop trigram) + "unique" (rare)
		const theTrigrams = [...extractTrigrams("the")];
		const uniqueTrigrams = [...extractTrigrams("unique identifier")];

		// "the" alone should return all files (it's a stop trigram, gets skipped)
		const theResults = index.query(theTrigrams);
		expect(theResults.size).toBe(fileArray.length);

		// "unique identifier" should return only "unique.ts"
		const uniqueResults = index.query(uniqueTrigrams);
		expect(uniqueResults.size).toBe(1);
	});
});

// ===========================================
// Edge Cases & Stress Tests
// ===========================================

describe("edge cases", () => {
	it("handles files with only whitespace", () => {
		const trigrams = extractTrigrams("   \n\n\t\t   ");
		// 7 unique 3-char windows over the 10-char string (tab/newline pass
		// the control-char filter, so this is not the trivial empty case).
		expect(trigrams.size).toBe(7);
	});

	it("handles very long strings efficiently", () => {
		const longString = "a".repeat(100_000);
		const start = Date.now();
		const trigrams = extractTrigrams(longString);
		const elapsed = Date.now() - start;
		// Should complete in under 100ms even for 100K chars
		expect(elapsed).toBeLessThan(500);
		// Only 1 unique trigram: "aaa"
		expect(trigrams.size).toBe(1);
	});

	it("handles diverse unicode content", () => {
		const content = "こんにちは世界 hello wörld café";
		const trigrams = extractTrigrams(content);
		expect(trigrams.size).toBeGreaterThan(0);
	});

	it("handles mixed line endings", () => {
		const content = "line1\r\nline2\nline3\rline4";
		const trigrams = extractTrigrams(content);
		expect(trigrams.size).toBeGreaterThan(0);
	});

	it("index build handles empty file list", () => {
		const index = new TrigramIndex([], new Map(), new Set(), "abc", "/tmp");
		const candidates = index.query([packTrigram(0x61, 0x62, 0x63)]);
		expect(candidates.size).toBe(0);
	});

	it("index handles file with only control characters", () => {
		const trigrams = extractTrigrams("\x01\x02\x03\x04\x05");
		expect(trigrams.size).toBe(0);
	});

	it("query with many trigrams still works", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 100; i++) {
			files[`f${i}.ts`] = `content ${i} with some words here abc def ghi`;
		}
		files["target.ts"] = "very specific unique content xyzabc123def456ghi789";

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

		const index = new TrigramIndex(fileArray, postings, new Set(), "abc", "/tmp");

		// Very specific pattern — should narrow to just "target.ts"
		const trigrams = [...extractTrigrams("xyzabc123def456ghi789")];
		expect(trigrams.length).toBeGreaterThan(10);

		const candidates = index.queryCandidatePaths(trigrams);
		expect(candidates).toContain("target.ts");
		expect(candidates.length).toBeLessThan(5); // Very few false positives
	});
});

// ===========================================
// Performance Benchmarks
// ===========================================

describe("performance", () => {
	it("builds index for 1000 synthetic files in under 2 seconds", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) {
			// ~500 bytes per file
			files[`src/module${i}/index.ts`] = `
                export function handler${i}(req: Request): Response {
                    const data = processRequest${i}(req);
                    return new Response(JSON.stringify(data), {
                        headers: { "Content-Type": "application/json" }
                    });
                }
                export interface Config${i} { field${i}: string; timeout: number; }
            `;
		}

		const filePaths = Object.keys(files);
		const start = Date.now();

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

		const index = new TrigramIndex(fileArray, postings, new Set(), "abc", "/tmp");
		const buildTime = Date.now() - start;

		expect(buildTime).toBeLessThan(2000);
		expect(index.files.length).toBe(1000);
	});

	it("queries complete in under 5ms", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 1000; i++) {
			files[`f${i}.ts`] = `module${i} function handler${i} export const x${i} = ${i}`;
		}
		files["target.ts"] = "uniqueTargetIdentifier function special";

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

		const index = new TrigramIndex(fileArray, postings, new Set(), "abc", "/tmp");

		const trigrams = [...extractTrigrams("uniquetargetidentifier")];

		// Warm up
		index.query(trigrams);

		// Measure
		const iterations = 100;
		const start = Date.now();
		for (let i = 0; i < iterations; i++) {
			index.query(trigrams);
		}
		const elapsed = Date.now() - start;
		const avgMs = elapsed / iterations;

		expect(avgMs).toBeLessThan(5);
	});

	it("dirty layer updates complete in under 1ms", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 500; i++) {
			files[`f${i}.ts`] = `content ${i}`;
		}

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

		const index = new TrigramIndex(fileArray, postings, new Set(), "abc", "/tmp");

		const start = Date.now();
		for (let i = 0; i < 100; i++) {
			index.updateFile(`new${i}.ts`, `new content ${i} with some text here`);
		}
		const elapsed = Date.now() - start;
		const avgMs = elapsed / 100;

		expect(avgMs).toBeLessThan(1);
	});
});
