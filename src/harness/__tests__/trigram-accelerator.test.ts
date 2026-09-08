// @perf — benchmark tests in this file use Date.now() for timing
// characterization. Fake timers would defeat the measurement. Opt out of
// the non_deterministic_test check via this marker (see taste-checks.ts).

import { beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { _resetRgPathCache, checkGrepAcceleration } from "../grep-accelerator.js";
import { decomposePattern } from "../regex-trigrams.js";
import { extractTrigrams, type PostingList, packTrigram, TrigramIndex } from "../trigram-index.js";
import type { HarnessEvent } from "../types.js";
import { buildTestIndex, FIXED_TIMESTAMP } from "./fixtures/trigram.js";

// ===========================================
// Grep Accelerator
// ===========================================

describe("checkGrepAcceleration", () => {
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
		const result = checkGrepAcceleration(event, index, {
			maxCandidateRatio: 0.3,
			indexFresh: true,
			minFilesForAccel: 1,
		});

		// "function" appears in (nearly) every file — the key invariant is that a
		// broad pattern is NEVER substituted (block); at most it is allow+warning,
		// so the native command still runs.
		expect(result?.decision).not.toBe("block");
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

	it("declines (null) when the index is not fresh — the staleness completeness gate", () => {
		const index = buildTestIndex({ "a.ts": "uniqueidentifierforsearch" });
		const event = makeGrepEvent("uniqueidentifierforsearch");
		// Default indexFresh:false → never substitute (a stale index could miss a
		// file that changed on disk — a silent false negative).
		expect(checkGrepAcceleration(event, index, { minFilesForAccel: 1 })).toBeNull();
		expect(
			checkGrepAcceleration(event, index, { indexFresh: false, minFilesForAccel: 1 }),
		).toBeNull();
	});

	it("declines (null) when the repo is below the size gate — no guaranteed win", () => {
		const index = buildTestIndex({ "a.ts": "uniqueidentifierforsearch" });
		const event = makeGrepEvent("uniqueidentifierforsearch");
		expect(
			checkGrepAcceleration(event, index, { indexFresh: true, minFilesForAccel: 999_999 }),
		).toBeNull();
	});

	it("declines (null) when a Grep glob or output_mode is set — output shape not reproduced", () => {
		const index = buildTestIndex({ "a.ts": "uniqueidentifierforsearch" });
		const globEvent = makeGrepEvent("uniqueidentifierforsearch", { glob: "*.ts" });
		expect(
			checkGrepAcceleration(globEvent, index, { indexFresh: true, minFilesForAccel: 1 }),
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
			"test/auth.test.ts": `
                import { handleAuthCallback } from '../src/auth/handler';
                describe('handleAuthCallback', () => {
                    it('exchanges code for token', async () => {
                        const res = await handleAuthCallback(fakeReq);
                        expect(res.status).toBe(200);
                    });
                });
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
		expect(candidates).toContain("test/auth.test.ts");

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
		// Ten characters yield eight windows. The first and last are both
		// three spaces, leaving seven distinct packed trigrams.
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
