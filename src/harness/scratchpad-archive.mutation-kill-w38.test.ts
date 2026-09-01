// Mutation-kill suite (wave 38) for src/harness/scratchpad-archive.ts.
// Targets specific Stryker survivors: /tmp root candidates, the excludeGlobs
// short-circuit, empty-array initial state, the walk ceiling + its boundary,
// sort-order, exact byte-count boundaries, blob-dedup write-avoidance, the
// per-file skip-list cap + its boundary, manifest schema/clock fields,
// process.getuid optional chaining, destRoot path assembly, the
// enabled-flag comparisons, the "" vs truncated-suffix string, the excluded
// module-level dir-name literals, and the extension regex's `$` anchor.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardRulesConfig } from "./types.js";

const matchesAnyGlobSpy = vi.hoisted(() => vi.fn());
const writeFileSyncSpy = vi.hoisted(() => vi.fn());

vi.mock("../lib/path-glob.js", async () => {
	const actual = await vi.importActual<typeof import("../lib/path-glob.js")>("../lib/path-glob.js");
	return {
		...actual,
		matchesAnyGlob: (...args: Parameters<typeof actual.matchesAnyGlob>) => {
			matchesAnyGlobSpy(...args);
			return actual.matchesAnyGlob(...args);
		},
	};
});

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			writeFileSyncSpy(...args);
			return actual.writeFileSync(...args);
		},
	};
});

const { archiveScratchpadDir, deriveScratchpadCandidates, runSessionEndScratchpadArchive } =
	await import("./scratchpad-archive.js");

function freshSource(): { source: string; destRoot: string } {
	const base = mkdtempSync(join(tmpdir(), "w38-scratch-"));
	const source = join(base, "scratchpad");
	mkdirSync(source, { recursive: true });
	return { source, destRoot: join(base, "archive") };
}

function manifestOf(destRoot: string, sessionId: string): Record<string, unknown> {
	const raw = readFileSync(join(destRoot, `${sessionId}.manifest.json`), "utf8");
	// SAFETY: manifest is JSON this suite just wrote — an object at top level.
	return JSON.parse(raw) as Record<string, unknown>;
}

function setupRealScratchpad(cwd: string, sessionId: string): void {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("test requires a POSIX host (process.getuid)");
	const candidates = deriveScratchpadCandidates({ cwd, sessionId, uid });
	const dir = candidates[0];
	if (!dir) throw new Error("no candidate scratchpad path derived");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "note.txt"), "hello\n");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("deriveScratchpadCandidates — /tmp and /private/tmp literals", () => {
	// test-contract: invariant — the fixed-root fallback list must resolve each
	// hardcoded root through realpathSync (so a /tmp -> /private/tmp symlink
	// collapses to one candidate, not a literal duplicate), never an emptied
	// string.
	it("includes the realpath-resolved /private/tmp candidate root", () => {
		const candidates = deriveScratchpadCandidates({ cwd: "/a/b", sessionId: "s1", uid: 42 });
		const suffix = join("claude-42", "-a-b", "s1", "scratchpad");
		expect(candidates).toContain(join("/private/tmp", suffix));
	});
});

describe("classifyWalkEntry — excludeGlobs short-circuit", () => {
	// test-contract: invariant — matchesAnyGlob must not be invoked at all when
	// no globs are configured (the `.length > 0 &&` guard exists precisely to
	// skip that call, not merely to skip a no-op match).
	it("never calls matchesAnyGlob when archive_excludes is empty", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "a.txt"), "hi\n");
		archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "glob1" });
		expect(matchesAnyGlobSpy).not.toHaveBeenCalled();
	});
});

describe("collectCandidateFiles — empty containers", () => {
	// test-contract: invariant — an empty scratchpad must produce genuinely
	// empty files/skipped arrays at every layer, not a seeded placeholder entry.
	it("produces zero files, zero skips for a truly empty source dir", () => {
		const { source, destRoot } = freshSource();
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "empty1" });
		expect(summary?.fileCount).toBe(0);
		expect(summary?.totalBytes).toBe(0);
		expect(summary?.skipped).toEqual([]);
		const manifest = manifestOf(destRoot, "empty1");
		expect(manifest.files).toEqual([]);
	});
});

describe("collectCandidateFiles — walk ceiling", () => {
	// test-contract: boundary — once out.files clearly exceeds maxFiles+200,
	// the walk must stop enumerating further pending directories.
	it("stops enumerating once the file count clearly exceeds the ceiling", () => {
		const { source, destRoot } = freshSource();
		for (let i = 0; i < 205; i++) {
			writeFileSync(join(source, `root-${i}.txt`), "x\n");
		}
		mkdirSync(join(source, "later"));
		writeFileSync(join(source, "later", "later.txt"), "y\n");
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "ceil1",
			config: { max_files: 0 },
		});
		const laterPath = join("later", "later.txt");
		expect(summary?.skipped.some((s) => s.path === laterPath)).toBe(false);
	});

	// test-contract: boundary — exactly at out.files.length === scanCeiling the
	// walk must still continue (the check is `<=`, not `<`).
	it("still continues when the file count exactly equals the ceiling", () => {
		const { source, destRoot } = freshSource();
		for (let i = 0; i < 200; i++) {
			writeFileSync(join(source, `root-${i}.txt`), "x\n");
		}
		mkdirSync(join(source, "later"));
		writeFileSync(join(source, "later", "later.txt"), "y\n");
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "ceil2",
			config: { max_files: 0 },
		});
		const laterPath = join("later", "later.txt");
		expect(summary?.skipped.some((s) => s.path === laterPath)).toBe(true);
	});
});

describe("collectCandidateFiles — sort", () => {
	// test-contract: invariant — the walk result must be alphabetically sorted
	// by relative path, not left in directory-discovery order.
	it("returns files in alphabetical relative-path order, not discovery order", () => {
		const { source, destRoot } = freshSource();
		// Single entry per directory at every level so discovery order carries
		// no OS-dependent ambiguity: root sees exactly {b.txt, a_dir}, and
		// a_dir sees exactly {inner.txt} — both entries of the root pair are
		// recorded in the same walk iteration regardless of readdir order.
		writeFileSync(join(source, "b.txt"), "1\n");
		mkdirSync(join(source, "a_dir"));
		writeFileSync(join(source, "a_dir", "inner.txt"), "2\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "sort1" });
		const manifest = manifestOf(destRoot, "sort1");
		const files = manifest.files as Array<{ path: string }>;
		expect(files.map((f) => f.path)).toEqual([join("a_dir", "inner.txt"), "b.txt"]);
		expect(summary?.fileCount).toBe(2);
	});
});

describe("archiveOneFile — exact byte boundaries", () => {
	// test-contract: boundary — a file exactly at max_file_bytes must be
	// archived, not rejected as too-large (the check is strictly `>`).
	it("archives a file whose size exactly equals max_file_bytes", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "exact.txt"), "x".repeat(50));
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "size1",
			config: { max_file_bytes: 50 },
		});
		expect(summary?.skipped.some((s) => s.path === "exact.txt")).toBe(false);
		expect(summary?.fileCount).toBe(1);
	});

	// test-contract: boundary — a single file whose size exactly equals
	// max_total_bytes must be archived, not rejected as budget-exhausted.
	it("archives a single file whose size exactly equals max_total_bytes", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "budget.txt"), "y".repeat(30));
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "budget1",
			config: { max_total_bytes: 30 },
		});
		expect(summary?.skipped.some((s) => s.reason === "budget-exhausted")).toBe(false);
		expect(summary?.fileCount).toBe(1);
		expect(summary?.totalBytes).toBe(30);
	});

	// test-contract: invariant — the running total must be totalSoFar + size,
	// not totalSoFar - size; a second same-size file must trip the budget.
	it("accumulates totalSoFar by addition, not subtraction, across files", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "file-a.txt"), "a".repeat(60));
		writeFileSync(join(source, "file-b.txt"), "b".repeat(60));
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "sum1",
			config: { max_total_bytes: 100 },
		});
		expect(summary?.fileCount).toBe(1);
		expect(
			summary?.skipped.some((s) => s.path === "file-b.txt" && s.reason === "budget-exhausted"),
		).toBe(true);
	});
});

describe("archiveOneFile — blob dedup avoids a redundant write", () => {
	// test-contract: invariant — an existing blob must not be rewritten; the
	// `!existsSync(blobPath)` guard must gate the writeFileSync call.
	it("writes the blob only once for two files sharing content", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "copy-a.txt"), "same-bytes\n");
		writeFileSync(join(source, "copy-b.txt"), "same-bytes\n");
		writeFileSyncSpy.mockClear();
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "dedup1" });
		expect(summary?.fileCount).toBe(2);
		// One manifest write + exactly one blob write (the second file's blob
		// already exists on disk from the first).
		expect(writeFileSyncSpy).toHaveBeenCalledTimes(2);
	});
});

describe("archiveScratchpadDir — per-file skip-list cap", () => {
	// test-contract: boundary — once `skipped.length` reaches SKIP_LIST_CAP
	// (200), further archiveOneFile-sourced skips must stop being recorded.
	it("caps recorded skip entries at 200 even with far more skip-worthy files", () => {
		const { source, destRoot } = freshSource();
		for (let i = 0; i < 250; i++) {
			writeFileSync(join(source, `bulk-${i}.tgz`), "not-a-tarball\n");
		}
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "cap1" });
		expect(summary?.skipped.length).toBe(200);
	});

	// test-contract: boundary — exactly at skipped.length === 200 the guard
	// (`<`, not `<=`) must refuse one more push.
	it("stops at exactly 200 recorded skips, not 201", () => {
		const { source, destRoot } = freshSource();
		for (let i = 0; i < 201; i++) {
			writeFileSync(join(source, `bulk-${i}.tgz`), "not-a-tarball\n");
		}
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "cap2" });
		expect(summary?.skipped.length).toBe(200);
	});
});

describe("archiveScratchpadDir — manifest schema and clock fields", () => {
	// test-contract: invariant — the manifest must carry the literal schema id
	// and a real timestamp from the default clock, not emptied/undefined values.
	it("writes the schema literal and a real archived_at timestamp", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "a.txt"), "hi\n");
		archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "schema1" });
		const manifest = manifestOf(destRoot, "schema1");
		expect(manifest.schema).toBe("scratchpad-archive.v1");
		expect(typeof manifest.archived_at).toBe("string");
		expect((manifest.archived_at as string).length).toBeGreaterThan(0);
	});
});

describe("archiveScratchpadDir — module-level excluded dir names", () => {
	const names = [".git", "package", "dist", "build", ".npm", ".venv", ".cache", "__pycache__"];
	// test-contract: invariant — each literal dir name must still be excluded;
	// an emptied literal would let the directory (and its content) through.
	it.each(names)("still excludes a top-level '%s' directory", (name) => {
		const { source, destRoot } = freshSource();
		mkdirSync(join(source, name));
		writeFileSync(join(source, name, "inner.txt"), "content\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: `dir-${name}` });
		expect(summary?.skipped.find((s) => s.path === name)?.reason).toBe("excluded-dir");
	});
});

describe("archiveScratchpadDir — excluded extension regex anchor", () => {
	// test-contract: invariant — the `$` anchor means the excluded extension
	// must be at the END of the filename; "notes.gz.txt" does not qualify.
	it("does not exclude a file whose name merely contains .gz mid-string", () => {
		const { source, destRoot } = freshSource();
		writeFileSync(join(source, "notes.gz.txt"), "plain text\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "regex1" });
		expect(summary?.skipped.some((s) => s.path === "notes.gz.txt")).toBe(false);
		expect(summary?.fileCount).toBe(1);
	});
});

describe("archiveSessionScratchpad — process.getuid optional chaining", () => {
	// test-contract: boundary — on a host without getuid, the optional-chain
	// must yield undefined (safe), not throw by calling a missing function.
	it("does not throw or log a failure when process.getuid is unavailable", () => {
		const original = process.getuid;
		(process as unknown as { getuid?: unknown }).getuid = undefined;
		try {
			const cwd = mkdtempSync(join(tmpdir(), "w38-getuid-"));
			const log = vi.fn();
			runSessionEndScratchpadArchive({
				cwd,
				sessionId: "no-getuid-1",
				rules: {} as GuardRulesConfig,
				log,
			});
			expect(log).not.toHaveBeenCalled();
		} finally {
			(process as unknown as { getuid?: unknown }).getuid = original;
		}
	});
});

describe("runSessionEndScratchpadArchive — destRoot path assembly", () => {
	// test-contract: invariant — the archive must land at exactly
	// `<cwd>/.interlinked/scratchpad-archive/blobs`, not a path missing either
	// literal path segment.
	it("writes blobs under <cwd>/.interlinked/scratchpad-archive/blobs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "w38-destroot-"));
		const sessionId = `dest-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		const log = vi.fn();
		runSessionEndScratchpadArchive({ cwd, sessionId, rules: {} as GuardRulesConfig, log });
		expect(existsSync(join(cwd, ".interlinked", "scratchpad-archive", "blobs"))).toBe(true);
		expect(log).toHaveBeenCalledTimes(1);
	});
});

describe("runSessionEndScratchpadArchive — enabled-flag comparisons", () => {
	// test-contract: invariant — the disable check compares `=== false`; a
	// scratchpad that exists must still be skipped when enabled is false.
	it("still skips archiving when disabled even though a real scratchpad exists", () => {
		const cwd = mkdtempSync(join(tmpdir(), "w38-disabled-"));
		const sessionId = `disabled-real-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		const log = vi.fn();
		runSessionEndScratchpadArchive({
			cwd,
			sessionId,
			rules: { scratchpad_archive: { enabled: false } } as GuardRulesConfig,
			log,
		});
		expect(log).not.toHaveBeenCalled();
	});

	// test-contract: invariant — `enabled: true` is not `=== false`, so
	// archiving must proceed (only literal `false` disables it).
	it("still archives when enabled is explicitly true", () => {
		const cwd = mkdtempSync(join(tmpdir(), "w38-enabledtrue-"));
		const sessionId = `enabled-true-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		const log = vi.fn();
		runSessionEndScratchpadArchive({
			cwd,
			sessionId,
			rules: { scratchpad_archive: { enabled: true } } as GuardRulesConfig,
			log,
		});
		expect(log).toHaveBeenCalledTimes(1);
	});
});

describe("runSessionEndScratchpadArchive — truncated-suffix string", () => {
	// test-contract: invariant — the non-truncated branch must interpolate the
	// empty string, never the Stryker placeholder text.
	it("does not inject the mutant placeholder into a non-truncated log message", () => {
		const cwd = mkdtempSync(join(tmpdir(), "w38-suffix-"));
		const sessionId = `suffix-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		const log = vi.fn();
		runSessionEndScratchpadArchive({ cwd, sessionId, rules: {} as GuardRulesConfig, log });
		const message = (log.mock.calls[0] as [string])[0];
		expect(message).not.toContain("Stryker was here!");
	});
});
