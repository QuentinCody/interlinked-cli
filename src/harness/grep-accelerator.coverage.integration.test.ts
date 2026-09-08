// ===========================================
// Grep Accelerator — supplementary coverage suite
// ===========================================
// The primary behavioral suite for the accelerator lives in
// __tests__/trigram-index.test.ts; it exercises the early-return guards
// (null index, no candidates, broad-pattern warning, staleness / size
// gates). This file targets the branches that ONLY run once the
// never-worse-than-native gates are *opened* — i.e. the actual
// acceleration path: in-process matching, real ripgrep execution,
// block-and-answer formatting, the dirty-layer fallthrough, path
// filtering, output compression, and the FileContentCache.
//
// The accelerator only ever handles plain content searches: a glob or a
// non-default output_mode (-l / -c) is DECLINED at the eligibility gate
// (its output shape can't be reproduced byte-for-byte). Those gate-decline
// branches are pinned below under "never-worse-than-native gates"; the
// downstream glob/output-mode HANDLING was removed as unreachable, so the
// content-mode matcher and the two residual defensive helpers exported for
// direct unit coverage (safeRegExp, compressGrepOutput) are tested at the
// bottom.
//
// All searches run against a real on-disk temp cwd so matchInProcess /
// runRipgrepOnCandidates read genuine file content. ripgrep is detected
// via findRipgrep() — the rg-path assertions skip gracefully if rg is
// absent so the suite stays green on a bare runner.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	_resetRgPathCache,
	checkGrepAcceleration,
	compressGrepOutput,
	FileContentCache,
	findRipgrep,
	safeRegExp,
} from "./grep-accelerator.js";
import { extractTrigrams, type PostingList, TrigramIndex } from "./trigram-index.js";
import type { HarnessEvent } from "./types.js";

const FIXED_TIMESTAMP = "2024-01-01T00:00:00.000Z";

// Whether a real ripgrep binary is reachable. The runRipgrepOnCandidates
// branch only does useful work when it is; gate those assertions on it so
// the file passes on a runner without rg installed.
const RG_AVAILABLE = findRipgrep() !== null;

// ===========================================
// On-disk fixture helpers
// ===========================================

interface Fixture {
	dir: string;
	index: TrigramIndex;
}

/**
 * Build a TrigramIndex over real files written to a fresh temp directory.
 * The index `cwd` is that directory, so the accelerator's disk reads and
 * rg spawn resolve against actual content.
 */
function buildDiskFixture(files: Record<string, string>): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "grep-accel-cov-"));
	const filePaths = Object.keys(files);
	const postingsBuilder = new Map<number, number[]>();
	const fileArray: string[] = [];

	for (let fileId = 0; fileId < filePaths.length; fileId++) {
		const relPath = nonNull(filePaths[fileId]);
		fileArray.push(relPath);
		// Write the real file so matchInProcess / rg can read it.
		const abs = join(dir, relPath);
		const lastSlash = relPath.lastIndexOf("/");
		if (lastSlash >= 0) mkdirSync(join(dir, relPath.slice(0, lastSlash)), { recursive: true });
		const fileContent = nonNull(files[relPath]);
		writeFileSync(abs, fileContent);

		for (const tri of extractTrigrams(fileContent)) {
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

	const index = new TrigramIndex(fileArray, postings, new Set(), "abc123", dir);
	return { dir, index };
}

function grepEvent(
	pattern: string,
	opts?: { path?: string; glob?: string; caseInsensitive?: boolean; outputMode?: string },
): HarnessEvent {
	const toolInput: Record<string, unknown> = { pattern };
	if (opts?.path !== undefined) toolInput.path = opts.path;
	if (opts?.glob !== undefined) toolInput.glob = opts.glob;
	if (opts?.caseInsensitive !== undefined) toolInput["-i"] = opts.caseInsensitive;
	if (opts?.outputMode !== undefined) toolInput.output_mode = opts.outputMode;
	return {
		hook_event: "PreToolUse",
		session_id: "test",
		agent_source: "claude",
		tool_name: "Grep",
		tool_input: toolInput,
		timestamp: FIXED_TIMESTAMP,
	};
}

function bashEvent(command: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: FIXED_TIMESTAMP,
	};
}

// All accelerated tests opt past the never-worse-than-native gates:
// indexFresh:true + minFilesForAccel:1 so even a tiny index is eligible.
// The tiny fixtures here make a matched pattern hit a high candidate ratio,
// so maxCandidateRatio:1 + a generous maxCandidates keep the default path on
// the BLOCK branch rather than the broad-pattern allow-with-warning. The two
// broad-pattern tests override these back down to assert that branch.
const ACCEL = {
	indexFresh: true,
	minFilesForAccel: 1,
	maxCandidateRatio: 1,
	maxCandidates: 500,
} as const;

// Track every temp dir so we can clean them all up at the end.
const createdDirs: string[] = [];
function fixture(files: Record<string, string>): Fixture {
	const f = buildDiskFixture(files);
	createdDirs.push(f.dir);
	return f;
}

beforeEach(() => {
	_resetRgPathCache();
});

afterAll(() => {
	for (const d of createdDirs) {
		rmSync(d, { recursive: true, force: true });
	}
});

// ===========================================
// FileContentCache
// ===========================================

describe("FileContentCache", () => {
	it("stores and returns fresh content", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "hello");
		expect(cache.get("a.ts")).toBe("hello");
		expect(cache.size).toBe(1);
	});

	it("returns null for a missing key", () => {
		const cache = new FileContentCache();
		expect(cache.get("nope.ts")).toBeNull();
	});

	it("expires and deletes entries past their TTL", () => {
		// ttlMs = -1 forces `Date.now() - entry.ts > ttlMs` (a non-negative delta
		// > -1) to be true on the very next read regardless of wall-clock — a
		// synthetic value chosen purely to exercise the expiry branch + delete
		// deterministically (no sleeping, no fake timers).
		const cache = new FileContentCache(10, -1);
		cache.set("a.ts", "stale");
		expect(cache.get("a.ts")).toBeNull();
		// The stale read also evicted it.
		expect(cache.size).toBe(0);
	});

	it("evicts the oldest entry when at capacity", () => {
		const cache = new FileContentCache(2, 60_000);
		cache.set("first.ts", "1");
		cache.set("second.ts", "2");
		expect(cache.size).toBe(2);
		// Third insert is at capacity → oldest ("first.ts") is evicted.
		cache.set("third.ts", "3");
		expect(cache.size).toBe(2);
		expect(cache.get("first.ts")).toBeNull();
		expect(cache.get("second.ts")).toBe("2");
		expect(cache.get("third.ts")).toBe("3");
	});

	it("handles a zero-capacity cache without crashing on the empty eviction scan", () => {
		// maxEntries:0 → `size >= maxEntries` is true on the first set, but the
		// eviction loop finds no oldest key (empty map) so `oldestKey` stays null
		// and the `if (oldestKey)` guard's false arm runs. The entry is then stored
		// (capacity is not strictly enforced for a single insert).
		const cache = new FileContentCache(0, 60_000);
		cache.set("only.ts", "x");
		expect(cache.get("only.ts")).toBe("x");
	});

	it("invalidates a specific entry", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "x");
		cache.invalidate("a.ts");
		expect(cache.get("a.ts")).toBeNull();
	});

	it("clears the whole cache", () => {
		const cache = new FileContentCache();
		cache.set("a.ts", "x");
		cache.set("b.ts", "y");
		cache.clear();
		expect(cache.size).toBe(0);
	});
});

// ===========================================
// Top-level entry guards (null index / param extraction / tool routing)
// ===========================================

describe("checkGrepAcceleration entry guards", () => {
	it("returns null immediately when the index is null", () => {
		const ev = grepEvent("anyToken");
		expect(checkGrepAcceleration(ev, null, ACCEL)).toBeNull();
	});

	it("returns null when a Grep event carries no pattern", () => {
		const { index } = fixture({ "a.ts": "content here" });
		// tool_input has no `pattern` key → extractSearchParams returns null
		// → checkGrepAcceleration returns null (the !searchParams guard).
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Grep",
			tool_input: {},
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("returns null for a tool that is neither Grep nor a shell variant", () => {
		const { index } = fixture({ "a.ts": "content here" });
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Read",
			tool_input: { file_path: "a.ts" },
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("tolerates a missing tool_name (defaults to empty → unknown tool → null)", () => {
		const { index } = fixture({ "a.ts": "content here" });
		// Omit tool_name and tool_input entirely: the `|| ""` / `|| {}` defaults
		// run, extractSearchParams sees an empty tool name, and returns null.
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("routes a Shell-tool rg command through the bash parser and blocks", () => {
		const { index } = fixture({ "a.ts": "shellToolNeedle on a line" });
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "Shell",
			tool_input: { command: "rg -F 'shellToolNeedle'" },
			timestamp: FIXED_TIMESTAMP,
		};
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("shellToolNeedle");
	});

	it("routes a lowercase shell-tool rg command through the bash parser", () => {
		const { index } = fixture({ "a.ts": "lowerShellNeedle here" });
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "shell",
			tool_input: { command: "rg -F 'lowerShellNeedle'" },
			timestamp: FIXED_TIMESTAMP,
		};
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("lowerShellNeedle");
	});

	it("routes a run_command-tool rg command through the bash parser", () => {
		const { index } = fixture({ "a.ts": "runCommandNeedle present" });
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "run_command",
			tool_input: { command: "rg -F 'runCommandNeedle'" },
			timestamp: FIXED_TIMESTAMP,
		};
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("runCommandNeedle");
	});

	it("returns null for a shell variant whose command has no parseable grep", () => {
		const { index } = fixture({ "a.ts": "content here" });
		// run_command with an empty command → parseGrepCommand yields null.
		const ev: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "test",
			agent_source: "claude",
			tool_name: "run_command",
			tool_input: { command: "" },
			timestamp: FIXED_TIMESTAMP,
		};
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});
});

// ===========================================
// Gate combinations (the second half of each && in the gate chain)
// ===========================================

describe("never-worse-than-native gates", () => {
	it("declines (default config) because indexFresh is false", () => {
		const { index } = fixture({ "a.ts": "freshGateToken here" });
		// No ACCEL override: DEFAULTS.indexFresh === false → first gate trips.
		const ev = grepEvent("freshGateToken");
		expect(checkGrepAcceleration(ev, index, {})).toBeNull();
	});

	it("declines when the indexed file count is below minFilesForAccel", () => {
		const { index } = fixture({ "a.ts": "sizeGateToken here" });
		// Fresh, but minFilesForAccel raised above the (tiny) totalFiles → size gate.
		const ev = grepEvent("sizeGateToken");
		expect(
			checkGrepAcceleration(ev, index, { indexFresh: true, minFilesForAccel: 1000 }),
		).toBeNull();
	});

	it("declines when a glob is supplied (output-shape gate)", () => {
		const { index } = fixture({ "a.ts": "uniqueidentifierforsearch here" });
		const ev = grepEvent("uniqueidentifierforsearch", { glob: "*.ts" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("declines when a non-content output mode is supplied", () => {
		const { index } = fixture({ "a.ts": "uniqueidentifierforsearch here" });
		const ev = grepEvent("uniqueidentifierforsearch", { outputMode: "files_with_matches" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("declines a pure-wildcard pattern (no extractable literals)", () => {
		const { index } = fixture({ "a.ts": "content" });
		// `.+` is regex-only wildcard → hasLiterals false.
		const ev = grepEvent(".+");
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("declines on an empty index without dividing by zero (totalFiles === 0)", () => {
		// An index with zero indexed files. minFilesForAccel:0 lets it past the
		// size gate (0 < 0 is false), so the ratio/selectivity computation runs
		// with totalFiles === 0 — exercising the `: 1` / `: 0` cond-expr arms —
		// then the empty candidate set drives the zero-candidates decline.
		const { index } = fixture({});
		expect(index.totalFiles).toBe(0);
		const ev = grepEvent("anyTokenAtAll");
		const result = checkGrepAcceleration(ev, index, {
			indexFresh: true,
			minFilesForAccel: 0,
		});
		expect(result).toBeNull();
	});
});

// ===========================================
// Candidate filtering: path + dirty-layer fallthrough
// ===========================================

describe("candidate filtering", () => {
	// The subject here is the PATH FILTER (resolveCandidatePaths), which sits
	// UPSTREAM of the match engine — so these drive the hermetic fixed-string
	// in-process route (`rg -F`, candidates <= inProcessThreshold) instead of a
	// Grep-tool event. A Grep-tool pattern has REGEX semantics, which ALWAYS
	// routes to the real rg binary, and CI runners ship no ripgrep — the
	// previous form passed on any dev machine with rg and failed on every CI
	// runner (finding 2026-06).
	it("filters candidates by a relative path prefix and blocks with a match", () => {
		const { index } = fixture({
			"src/auth.ts": "function uniquePathToken() {}",
			"lib/auth.ts": "function uniquePathToken() {}",
		});
		// positional path "src" → only src/auth.ts survives the prefix filter.
		const ev = bashEvent("rg -F 'uniquePathToken' src");
		const result = checkGrepAcceleration(ev, index, ACCEL);
		expect(result).not.toBeNull();
		const decision = nonNull(result);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("src/auth.ts");
		expect(decision.reason).not.toContain("lib/auth.ts");
	});

	it("resolves an absolute path filter against index.cwd", () => {
		const { dir, index } = fixture({
			"src/deep.ts": "function absolutePathToken() {}",
			"other.ts": "function absolutePathToken() {}",
		});
		// Absolute path inside the fixture → relative("src") after resolution.
		const ev = bashEvent(`rg -F 'absolutePathToken' ${join(dir, "src")}`);
		const result = checkGrepAcceleration(ev, index, ACCEL);
		expect(result).not.toBeNull();
		const decision = nonNull(result);
		expect(decision.decision).toBe("block");
		expect(decision.reason).toContain("src/deep.ts");
		expect(decision.reason).not.toContain("other.ts");
	});

	it("treats a trailing-slash path the same as the bare prefix", () => {
		const { index } = fixture({
			"pkg/mod.ts": "const trailingSlashToken = 1;",
			"top.ts": "const trailingSlashToken = 1;",
		});
		const ev = bashEvent("rg -F 'trailingSlashToken' pkg/");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("pkg/mod.ts");
	});

	it("path filtering blocks with NO rg binary reachable (the CI condition, pinned)", async () => {
		// The exact environment that broke CI (finding 2026-06): no ripgrep
		// anywhere. child_process is mocked so ANY spawn attempt throws — a block
		// can therefore only come from the in-process matcher, proving the
		// path-filter tests above stay green on runners without rg.
		vi.resetModules();
		vi.doMock("node:child_process", () => ({
			spawnSync: () => {
				throw new Error("no rg in this environment");
			},
			execSync: () => {
				throw new Error("no rg in this environment");
			},
		}));
		const mod = await import("./grep-accelerator.js");
		try {
			const { index } = fixture({
				"src/auth.ts": "function hermeticPathToken() {}",
				"lib/auth.ts": "function hermeticPathToken() {}",
			});
			const ev = bashEvent("rg -F 'hermeticPathToken' src");
			const result = nonNull(mod.checkGrepAcceleration(ev, index, ACCEL));
			expect(result.decision).toBe("block");
			expect(result.reason).toContain("src/auth.ts");
			expect(result.reason).not.toContain("lib/auth.ts");
		} finally {
			vi.doUnmock("node:child_process");
			vi.resetModules();
		}
	});

	it("falls through to null when a path filter removes every candidate", () => {
		const { index } = fixture({ "src/a.ts": "function noMatchInDir() {}" });
		// Pattern exists, but only under src/ — filtering on a non-existent dir
		// empties the candidate set → the zero-candidates fallthrough returns null.
		const ev = grepEvent("noMatchInDir", { path: "nonexistent" });
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});

	it("drops dirty new files (unresolvable id) and falls through to native", () => {
		// A file added only to the dirty layer has an id >= files.length, so the
		// candidate resolver (index.files[id] || getFilePath) yields undefined and
		// the .filter removes it. With no base candidate left, the accelerator
		// declines so native rg can still find the on-disk file.
		const { index } = fixture({ "base.ts": "totally different content xyz" });
		index.updateFile("dirtyOnly.ts", "function dirtyLayerToken() {}");
		const ev = grepEvent("dirtyLayerToken");
		expect(checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});
});

// ===========================================
// In-process matching path (fixed-string, small candidate set)
// ===========================================

describe("in-process matching (fixed-string)", () => {
	it("blocks with grouped block-and-answer output for a literal Bash match", () => {
		const { index } = fixture({
			"a.ts": "const literalNeedle = 1;\nconst other = 2;\nliteralNeedle again;",
		});
		// rg -F → isRegex:false → in-process matcher (candidates <= threshold).
		const ev = bashEvent("rg -F 'literalNeedle'");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		// Compressed grouped format: file header then `lineNum:content` rows.
		expect(result.reason).toContain("a.ts");
		expect(result.reason).toContain("1:const literalNeedle = 1;");
		expect(result.grep_stats?.accelerated).toBe(true);
		expect(result.grep_stats?.match_count).toBe(2);
	});

	it("matches case-insensitively in-process via rg -i -F", () => {
		const { index } = fixture({ "a.ts": "const CamelNeedle = 1;" });
		const ev = bashEvent("rg -i -F 'camelneedle'");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("1:const CamelNeedle = 1;");
	});

	it("declines (null) when the in-process matcher finds zero real matches", () => {
		// The index over-selects: every trigram of "abcdefgh" is present (split
		// across two disjoint spans of the file), so the candidate set is
		// non-empty — but the contiguous literal never appears on a line, so the
		// in-process matcher returns matchCount 0 → checkGrepAcceleration declines
		// (290 → 295) so the agent sees native rg's empty result.
		const { index } = fixture({ "a.ts": "abcdefQQ QQefgh more text here" });
		const ev = bashEvent("rg -F 'abcdefgh'");
		// Force in-process by keeping it fixed-string + a tiny candidate set.
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 50 })).toBeNull();
	});

	it("skips files that cannot be read on disk and continues", () => {
		// Build an index referencing a phantom path that was never written to
		// disk, sharing trigrams with one real matching file. The unreadable
		// candidate hits the readFileSync catch (continue); the real one matches.
		const f = fixture({ "real.ts": "function ghostReadToken() {}" });
		const phantomFiles = ["real.ts", "phantom.ts"];
		const postingsBuilder = new Map<number, number[]>();
		for (let id = 0; id < phantomFiles.length; id++) {
			for (const tri of extractTrigrams("function ghostReadToken() {}")) {
				let list = postingsBuilder.get(tri);
				if (!list) {
					list = [];
					postingsBuilder.set(tri, list);
				}
				list.push(id);
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
		const index = new TrigramIndex(phantomFiles, postings, new Set(), "abc", f.dir);
		const ev = bashEvent("rg -F 'ghostReadToken'");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		// real.ts matched; phantom.ts was skipped (read failed) without crashing.
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("real.ts");
		expect(result.reason).not.toContain("phantom.ts");
	});

	it("declines when the in-process result would exceed the output cap (truncation)", () => {
		// maxOutputLines:1 with two matching lines → truncated → decline so the
		// native command returns the complete result.
		const { index } = fixture({
			"a.ts": "capNeedle one\ncapNeedle two\ncapNeedle three",
		});
		const ev = bashEvent("rg -F 'capNeedle'");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, maxOutputLines: 1 })).toBeNull();
	});

	// skipIf (not a silent early-return): the skip is REPORTED in the run
	// summary, so an environment without rg shows the gap instead of recording
	// phantom passes (finding 2026-06; CI installs ripgrep so it runs there).
	it.skipIf(!RG_AVAILABLE)("falls back to rg when in-process regex compilation fails (pattern over length cap)", () => {
		// safeRegExp rejects sources longer than 1000 chars. A fixed-string
		// pattern of 1001 plain chars routes through the in-process branch
		// (isRegex false, small candidate set), safeRegExp returns null, and the
		// matcher falls back to runRipgrepOnCandidates — which finds the literal.
		const longLiteral = "z".repeat(1001);
		const { index } = fixture({ "long.ts": `prefix ${longLiteral} suffix` });
		const ev = bashEvent(`rg -F '${longLiteral}'`);
		const result = nonNull(checkGrepAcceleration(ev, index, {
			...ACCEL,
			inProcessThreshold: 50,
		}));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("long.ts");
	});
});

// ===========================================
// Ripgrep execution path (regex / forced spawn)
// ===========================================

// describe-level skipIf (not silent early-returns inside each test): skips are
// REPORTED in the run summary, so an environment without rg shows exactly what
// did not run instead of recording phantom passes (finding 2026-06; CI installs
// ripgrep so these execute there).
describe.skipIf(!RG_AVAILABLE)("ripgrep execution", () => {
	it("blocks via real rg for a regex Grep query with multiple files", () => {
		const { index } = fixture({
			"src/a.ts": "export function rgRegexToken() {}",
			"src/b.ts": "export function rgRegexToken() { return 1; }",
			"unrelated.ts": "nothing to see here",
		});
		// Grep tool → isRegex:true → always rg.
		const ev = grepEvent("rgRegexToken");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("src/a.ts");
		expect(result.reason).toContain("src/b.ts");
		expect(result.grep_stats?.accelerated).toBe(true);
		expect(result.grep_stats?.match_count).toBeGreaterThanOrEqual(2);
	});

	it("uses rg even for a fixed string when inProcessThreshold is 0", () => {
		const { index } = fixture({ "a.ts": "forcedRgNeedle on a line" });
		// inProcessThreshold:0 → candidates.length (>=1) > 0 forces the rg branch.
		const ev = bashEvent("rg -F 'forcedRgNeedle'");
		const result = nonNull(checkGrepAcceleration(ev, index, {
			...ACCEL,
			inProcessThreshold: 0,
		}));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("forcedRgNeedle");
	});

	it("declines (null) when rg finds zero matches (over-selected stale candidate)", () => {
		// All required trigrams (from the literal "rgZeroToken") are present so the
		// candidate set is non-empty, but the regex demands a trailing digit the
		// file never has → rg exits 1 (no matches) → runRipgrepOnCandidates returns
		// matchCount 0 → checkGrepAcceleration declines (524 → 290 → 295).
		const { index } = fixture({ "a.ts": "rgZeroToken without any digit suffix" });
		const ev = grepEvent("rgZeroToken\\d");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 0 })).toBeNull();
	});

	it("passes --ignore-case to rg for a case-insensitive regex query", () => {
		// Grep tool with -i + regex → rg branch with --ignore-case (line 507).
		const { index } = fixture({ "a.ts": "const RgCaseToken = compute();" });
		const ev = grepEvent("rgcasetoken", { caseInsensitive: true });
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("RgCaseToken");
	});

	it("declines (null) when rg output exceeds the line cap (truncation)", () => {
		const lines = Array.from({ length: 8 }, (_, i) => `rgCapToken line ${i}`).join("\n");
		const { index } = fixture({ "a.ts": lines });
		const ev = grepEvent("rgCapToken");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, maxOutputLines: 2 })).toBeNull();
	});

	it("declines (null) when rg errors on a malformed regex (exit >= 2)", () => {
		// "rgErrToken[" decomposes to the single literal "rgErrToken" (the unclosed
		// char class contributes no segment), so every required trigram is present
		// → candidates non-empty → rg runs. rg then rejects the unterminated class
		// with exit 2 → runRipgrepOnCandidates returns null (527-528) →
		// checkGrepAcceleration declines (281-283) so the native command surfaces
		// the real parse error.
		const { index } = fixture({ "a.ts": "rgErrToken appears here" });
		const ev = grepEvent("rgErrToken[");
		expect(checkGrepAcceleration(ev, index, { ...ACCEL, inProcessThreshold: 0 })).toBeNull();
	});

	it("emits complete grep_stats on a single-file rg block", () => {
		const { index } = fixture({ "solo.ts": "soloStatToken on one line" });
		const ev = grepEvent("soloStatToken");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		// Single candidate, single match → stats fully populated, selectivity 100%.
		expect(result.grep_stats).toBeDefined();
		expect(result.grep_stats?.candidates).toBe(1);
		expect(result.grep_stats?.total_files).toBe(1);
		expect(result.grep_stats?.selectivity_pct).toBe(100);
		// rg omits the path for a lone file arg; --with-filename restores it.
		expect(result.reason).toContain("solo.ts");
	});
});

// ===========================================
// Broad-pattern allow-with-warning (ratio + maxCandidates branches)
// ===========================================

describe("broad-pattern handling", () => {
	it("allows with a warning when candidate ratio exceeds the cap", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 12; i++) {
			files[`file${i}.ts`] = `const broadShared${i} = sharedTokenHere;`;
		}
		const { index } = fixture(files);
		// "sharedTokenHere" is in every file → ratio 1.0 > 0.3.
		const ev = grepEvent("sharedTokenHere");
		const result = nonNull(checkGrepAcceleration(ev, index, {
			...ACCEL,
			maxCandidateRatio: 0.3,
		}));
		expect(result.decision).toBe("allow");
		expect(result.warnings?.some((w) => w.includes("broad pattern"))).toBe(true);
		expect(result.grep_stats?.accelerated).toBe(false);
	});

	it("allows with a warning when candidate count exceeds maxCandidates", () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 6; i++) {
			files[`f${i}.ts`] = `const countShared${i} = countTokenHere;`;
		}
		const { index } = fixture(files);
		// maxCandidates:2 with 6 matching files → count cap trips first.
		const ev = grepEvent("countTokenHere");
		const result = nonNull(checkGrepAcceleration(ev, index, {
			...ACCEL,
			maxCandidates: 2,
			maxCandidateRatio: 0.99,
		}));
		expect(result.decision).toBe("allow");
		expect(result.warnings?.[0]).toContain("broad pattern");
	});
});

// ===========================================
// Output compression (content-mode grouping across files + separators)
// ===========================================

describe("output compression", () => {
	it("groups matches from multiple files under per-file headers", () => {
		const { index } = fixture({
			"foo.ts": "compressGroupTok a\ncompressGroupTok b",
			"bar.ts": "compressGroupTok c",
		});
		const ev = bashEvent("rg -F 'compressGroupTok'");
		const result = nonNull(checkGrepAcceleration(ev, index, ACCEL));
		expect(result.decision).toBe("block");
		const reason = result.reason ?? "";
		// Both file headers present, with a blank line separating groups.
		expect(reason).toContain("foo.ts");
		expect(reason).toContain("bar.ts");
		expect(reason).toContain("1:compressGroupTok a");
		expect(reason).toContain("2:compressGroupTok b");
		// A blank line appears between the two file groups.
		expect(reason).toMatch(/\n\n/);
	});
});

// ===========================================
// findRipgrep + cache reset
// ===========================================

describe("findRipgrep", () => {
	it("memoizes the resolved path across calls", () => {
		_resetRgPathCache();
		const first = findRipgrep();
		const second = findRipgrep();
		// Second call hits the `_rgPath !== undefined` early return → same value.
		expect(second).toBe(first);
	});

	it("re-resolves to the same value after a cache reset", () => {
		const before = findRipgrep();
		_resetRgPathCache();
		const after = findRipgrep();
		// On any given machine resolution is stable, so the value matches, but the
		// reset forced the lookup to run again (cache-miss path re-executed).
		expect(after).toBe(before);
	});
});

// ===========================================
// findRipgrep — discovery fallback branches (fs / child_process mocked)
// ===========================================
// On a normal dev box rg lives at a common path, so the existsSync loop returns
// on the first iteration and the PATH-lookup fallback never runs. These tests
// mock node:fs + node:child_process and load a *fresh* module instance via
// vi.resetModules() + dynamic import, so the mocks apply only inside each test
// and the statically-imported accelerator used everywhere else is untouched.

describe("findRipgrep — fallback discovery (mocked fs/child_process)", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:child_process");
	});

	async function loadWith(opts: {
		existsSync: (p: string) => boolean;
		execSync?: (cmd: string) => string;
	}): Promise<typeof import("./grep-accelerator.js")> {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return { ...actual, existsSync: opts.existsSync };
		});
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>("node:child_process");
			return {
				...actual,
				execSync:
					opts.execSync ??
					(() => {
						throw new Error("no execSync stub");
					}),
			};
		});
		return import("./grep-accelerator.js");
	}

	it("falls back to PATH lookup when no common path exists and returns the resolved binary", async () => {
		const mod = await loadWith({
			existsSync: () => false, // every common path absent → loop exhausts
			execSync: () => "/custom/bin/rg\n", // `which rg` result (trailing newline trimmed)
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBe("/custom/bin/rg");
	});

	it("rejects a multi-line PATH result (shell-function artifact) and returns null", async () => {
		const mod = await loadWith({
			existsSync: () => false,
			// A which/command output spanning lines is treated as untrustworthy.
			execSync: () => "rg () {\n  rg --color=auto\n}\n",
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBeNull();
	});

	it("rejects a PATH result containing the word 'function' and returns null", async () => {
		const mod = await loadWith({
			existsSync: () => false,
			execSync: () => "rg is a function",
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBeNull();
	});

	it("returns null when the PATH lookup itself throws", async () => {
		const mod = await loadWith({
			existsSync: () => false,
			execSync: () => {
				throw new Error("which: command not found");
			},
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBeNull();
	});

	it("continues past a common path whose existsSync throws, then resolves via PATH", async () => {
		let calls = 0;
		const mod = await loadWith({
			existsSync: () => {
				calls++;
				throw new Error("EACCES"); // each common-path probe throws → caught, loop continues
			},
			execSync: () => "/recovered/rg",
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBe("/recovered/rg");
		// All four common paths were probed (and each threw) before the PATH fallback.
		expect(calls).toBe(4);
	});

	it("returns the first common path that exists without consulting PATH", async () => {
		let execCalled = false;
		const mod = await loadWith({
			existsSync: (p: string) => p === "/opt/homebrew/bin/rg",
			execSync: () => {
				execCalled = true;
				return "/should/not/be/used";
			},
		});
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBe("/opt/homebrew/bin/rg");
		expect(execCalled).toBe(false);
	});
});

// ===========================================
// runRipgrepOnCandidates — declines when no rg binary is available
// ===========================================

describe("acceleration with no ripgrep binary (mocked absent)", () => {
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("node:fs");
		vi.doUnmock("node:child_process");
	});

	it("returns null when a regex search needs rg but the binary cannot be found", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			// existsSync false everywhere EXCEPT real fixture files (so the index's
			// own reads still work); rg's common-path probes all miss.
			return {
				...actual,
				existsSync: (p: string) => (p.endsWith("/rg") ? false : actual.existsSync(p)),
			};
		});
		vi.doMock("node:child_process", async () => {
			const actual =
				await vi.importActual<typeof import("node:child_process")>("node:child_process");
			return { ...actual, execSync: () => "" }; // `which rg` finds nothing
		});
		const mod = await import("./grep-accelerator.js");
		mod._resetRgPathCache();
		expect(mod.findRipgrep()).toBeNull();

		// A regex Grep query (isRegex:true) must use rg; with rg unavailable
		// runRipgrepOnCandidates returns null → buildAcceleratedDecision → null.
		const { index } = fixture({ "a.ts": "noRgRegexToken on a line" });
		const ev = grepEvent("noRgRegexToken");
		expect(mod.checkGrepAcceleration(ev, index, ACCEL)).toBeNull();
	});
});

// ===========================================
// safeRegExp — ReDoS length cap + compile-failure guard (direct)
// ===========================================
// matchInProcess routes every agent-supplied pattern through safeRegExp; it is
// exported and unit-tested directly so the cap and the catch are covered as real
// behavior rather than via the (now content-only) matcher.

describe("safeRegExp", () => {
	it("compiles a valid source into a RegExp with the requested flags", () => {
		const re = safeRegExp("foo\\d+", "gi");
		expect(re).toBeInstanceOf(RegExp);
		expect(re?.flags).toBe("gi");
		expect(re?.test("FOO123")).toBe(true);
	});

	it("returns null for a source over the MAX_PATTERN_LENGTH (1000) cap", () => {
		// 1001 plain chars trips the length guard BEFORE construction — the ReDoS
		// mitigation — so no RegExp is built regardless of validity.
		const tooLong = "a".repeat(1001);
		expect(safeRegExp(tooLong, "g")).toBeNull();
	});

	it("allows a source exactly at the 1000-char cap (boundary, > not >=)", () => {
		// The guard is `> MAX_PATTERN_LENGTH`, so 1000 is still compiled.
		const atCap = "a".repeat(1000);
		expect(safeRegExp(atCap, "g")).toBeInstanceOf(RegExp);
	});

	it("returns null when the engine rejects the source (covers the catch)", () => {
		// "(" is an unterminated group — new RegExp throws → caught → null.
		expect(safeRegExp("(", "g")).toBeNull();
	});
});

// ===========================================
// compressGrepOutput — file-grouped formatting (direct)
// ===========================================
// buildAcceleratedDecision feeds rg's content output straight through
// compressGrepOutput. Exported and tested directly so every grouping arm is
// covered without round-tripping through a real index + rg spawn.

describe("compressGrepOutput", () => {
	it("groups multiple matches in one file under a single path header", () => {
		const input = "src/foo.ts:10:export function bar()\nsrc/foo.ts:20:export function baz()";
		expect(compressGrepOutput(input)).toBe(
			["src/foo.ts", "10:export function bar()", "20:export function baz()"].join("\n"),
		);
	});

	it("groups matches across files with a blank line between groups", () => {
		const input = [
			"src/foo.ts:10:a()",
			"src/foo.ts:20:b()",
			"src/other.ts:5:c()",
		].join("\n");
		expect(compressGrepOutput(input)).toBe(
			["src/foo.ts", "10:a()", "20:b()", "", "src/other.ts", "5:c()"].join("\n"),
		);
	});

	it("skips embedded empty lines in the body without breaking grouping", () => {
		// A blank line between two content rows (an artifact of how some streams are
		// joined) hits the `if (!line) continue` skip arm and must not affect the
		// grouped output.
		const input = ["src/foo.ts:10:a()", "", "src/foo.ts:20:b()"].join("\n");
		expect(compressGrepOutput(input)).toBe(
			["src/foo.ts", "10:a()", "20:b()"].join("\n"),
		);
	});

	it("returns an empty-string input unchanged (no non-empty sample line)", () => {
		// `lines.find(non-empty)` is undefined → early return of the raw input.
		expect(compressGrepOutput("")).toBe("");
	});

	it("returns a non-content stream (no path:line: shape) unchanged", () => {
		// A bare file list (files_with_matches shape) has no `:number:` second
		// segment, so the content-mode detection fails and the input is returned
		// verbatim. (Such output never reaches here in production — the gate
		// declines -l/-c searches — but the as-is guard is still exercised.)
		const fileList = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
		expect(compressGrepOutput(fileList)).toBe(fileList);
	});

	it("appends a content line that does not parse to the current file group", () => {
		// First line establishes the content shape + opens a group; the middle
		// line lacks a `path:number:` prefix (e.g. an rg separator) so it hits the
		// append-to-last-group arm rather than starting a new group.
		const input = ["src/foo.ts:10:first match", "--", "src/foo.ts:11:second match"].join("\n");
		expect(compressGrepOutput(input)).toBe(
			["src/foo.ts", "10:first match", "--", "11:second match"].join("\n"),
		);
	});

	it("drops a leading non-parsing line when no group is open yet", () => {
		// The first non-empty line IS content (so detection passes), but a later
		// truly-unparseable line arriving before any group would have no last key.
		// Here the sample is content; a stray separator at the very front of the
		// body (after the sample check) with no open group is silently skipped.
		const input = ["a.ts:1:x", "stray-no-colon-number"].join("\n");
		expect(compressGrepOutput(input)).toBe(["a.ts", "1:x", "stray-no-colon-number"].join("\n"));
	});
});
