import { makeGuardRules as completeGuardRulesConfigFixture } from "./evaluator/__tests__/fixtures.js";
import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
// Tests for the SessionEnd scratchpad archive sweep: content-addressed blob
// copy of the session scratchpad into .interlinked/scratchpad-archive/ with
// bounded work (dir/extension/binary excludes, per-file + total + count caps)
// and manifest-recorded skips (no silent truncation).

import { execSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// realpathSync is forced to always fail so `deriveScratchpadCandidates`'s
// catch-fallback (base path used as-is) is exercised — on this dev host
// tmpdir()/"/tmp"/"/private/tmp" all resolve cleanly, so the fallback is
// otherwise unreachable without mocking. statSync is trapped ONLY for an
// exact path a test opts into (`statTrapPath`), simulating a stat that fails
// after the file was already listed (a listing/archiving race) without
// disturbing any other statSync call in this file (the top-of-function
// sourceDir check, or any other fixture file).
let statTrapPath: string | null = null;
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		realpathSync: () => {
			throw new Error("no realpath");
		},
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			if (statTrapPath !== null && args[0] === statTrapPath) {
				throw new Error("stat trap for coverage");
			}
			return actual.statSync(...args);
		},
	};
});

const { archiveScratchpadDir, deriveScratchpadCandidates, runSessionEndScratchpadArchive } =
	await import("./scratchpad-archive.js");

function makeFixture(): { source: string; destRoot: string } {
	const base = mkdtempSync(join(tmpdir(), "scratch-arch-"));
	const source = join(base, "scratchpad");
	mkdirSync(join(source, "sub"), { recursive: true });
	writeFileSync(join(source, "probe.mts"), "export {};\n");
	writeFileSync(join(source, "sub", "results.json"), '{"ok":true}\n');
	return { source, destRoot: join(base, "archive") };
}

function manifestOf(destRoot: string, sessionId: string): Record<string, unknown> {
	const raw = readFileSync(join(destRoot, `${sessionId}.manifest.json`), "utf8");
	// SAFETY: the manifest is JSON we just wrote — an object at the top level.
	return parseWire(JSON.parse(raw), wireRecord(wireUnknown), "test JSON value");
}

describe("archiveScratchpadDir", () => {
	it("copies text files into content-addressed blobs and writes a manifest", () => {
		const { source, destRoot } = makeFixture();
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s1" });
		expect(summary).not.toBeNull();
		expect(summary?.fileCount).toBe(2);
		expect(summary?.truncated).toBe(false);
		const manifest = manifestOf(destRoot, "s1");
		// SAFETY: manifest schema under test — `files` is the entry array asserted below.
		const files = parseWire(manifest.files, wireArray(wireObject({ "path": wireString, "sha256": wireString, "size": wireNumber })), "test JSON value");
		expect(files.map((f) => f.path).sort()).toEqual(["probe.mts", "sub/results.json"]);
		for (const f of files) {
			const blob = readFileSync(join(destRoot, "blobs", f.sha256), "utf8");
			expect(blob.length).toBe(f.size);
		}
	});

	it("skips excluded dirs, archive extensions, and binary files — with reasons", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "node_modules", "lodash"), { recursive: true });
		writeFileSync(join(source, "node_modules", "lodash", "index.js"), "// dep\n");
		writeFileSync(join(source, "bundle.tgz"), "not-really-a-tarball");
		writeFileSync(join(source, "blob.bin"), Buffer.from([0, 1, 2, 3]));
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s2" });
		expect(summary?.fileCount).toBe(2); // only the two text files
		const reasons = (summary?.skipped ?? []).map((s) => s.reason);
		expect(reasons).toContain("excluded-dir");
		expect(reasons).toContain("excluded-extension");
		expect(reasons).toContain("binary");
	});

	it("deduplicates identical content into a single blob", () => {
		const { source, destRoot } = makeFixture();
		writeFileSync(join(source, "copy-a.txt"), "same-bytes\n");
		writeFileSync(join(source, "copy-b.txt"), "same-bytes\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s3" });
		expect(summary?.fileCount).toBe(4);
		const blobs = readdirSync(join(destRoot, "blobs"));
		expect(blobs.length).toBe(3); // probe.mts + results.json + one shared blob
	});

	it("skips oversized files per max_file_bytes with reason too-large", () => {
		const { source, destRoot } = makeFixture();
		writeFileSync(join(source, "big.log"), "x".repeat(4096));
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "s4",
			config: { max_file_bytes: 1024 },
		});
		expect(summary?.skipped.some((s) => s.path === "big.log" && s.reason === "too-large")).toBe(
			true,
		);
	});

	it("stops at the total budget and marks the archive truncated", () => {
		const { source, destRoot } = makeFixture();
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(source, `chunk-${i}.txt`), "y".repeat(512));
		}
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "s5",
			config: { max_total_bytes: 1024 },
		});
		expect(summary?.truncated).toBe(true);
		expect(summary?.skipped.some((s) => s.reason === "budget-exhausted")).toBe(true);
	});

	it("skips symlinks instead of following them", () => {
		const { source, destRoot } = makeFixture();
		symlinkSync(join(source, "probe.mts"), join(source, "link.mts"));
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s6" });
		expect(summary?.skipped.some((s) => s.path === "link.mts" && s.reason === "symlink")).toBe(
			true,
		);
	});

	it("returns null for a missing source dir", () => {
		const { destRoot } = makeFixture();
		expect(
			archiveScratchpadDir({ sourceDir: "/nonexistent/nowhere", destRoot, sessionId: "s7" }),
		).toBeNull();
	});

	it("returns null when sourceDir exists but is not a directory", () => {
		const { source, destRoot } = makeFixture();
		const filePath = join(source, "probe.mts"); // an existing regular file
		expect(archiveScratchpadDir({ sourceDir: filePath, destRoot, sessionId: "s8" })).toBeNull();
	});

	it("skips directory entries that are neither files, dirs, nor symlinks (e.g. a FIFO)", () => {
		const { source, destRoot } = makeFixture();
		const fifoPath = join(source, "a.fifo");
		execSync(`mkfifo "${fifoPath}"`);
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s9" });
		expect(summary?.fileCount).toBe(2); // the FIFO is silently skipped, not archived
	});

	it("skips a file that disappears between listing and archiving (stat race)", () => {
		const { source, destRoot } = makeFixture();
		const racedPath = join(source, "raced.txt");
		writeFileSync(racedPath, "x");
		statTrapPath = racedPath;
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s10" });
		statTrapPath = null;
		expect(
			summary?.skipped.some((s) => s.path === "raced.txt" && s.reason === "unreadable"),
		).toBe(true);
		expect(summary?.fileCount).toBe(2); // the two fixture files; raced.txt skipped
	});

	it("skips a file it cannot read due to permissions (statSync ok, readFileSync fails)", () => {
		const { source, destRoot } = makeFixture();
		const noReadPath = join(source, "secret.txt");
		writeFileSync(noReadPath, "shh");
		chmodSync(noReadPath, 0o000);
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "s11" });
		chmodSync(noReadPath, 0o644);
		expect(
			summary?.skipped.some((s) => s.path === "secret.txt" && s.reason === "unreadable"),
		).toBe(true);
	});

	it("stops after max_files and marks the archive truncated with file-cap skips", () => {
		const { source, destRoot } = makeFixture(); // 2 fixture files already
		writeFileSync(join(source, "extra.txt"), "z");
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "s12",
			config: { max_files: 1 },
		});
		expect(summary?.fileCount).toBe(1);
		expect(summary?.truncated).toBe(true);
		expect(summary?.skipped.some((s) => s.reason === "file-cap")).toBe(true);
	});

	it("falls back to 'unknown-session' for a sessionId that sanitizes to empty", () => {
		const { source, destRoot } = makeFixture();
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "" });
		expect(summary?.manifestPath).toBe(join(destRoot, "unknown-session.manifest.json"));
	});
});

describe("deriveScratchpadCandidates", () => {
	it("builds the host layout <temp-root>/claude-<uid>/<cwd-slug>/<session>/scratchpad", () => {
		const candidates = deriveScratchpadCandidates({
			cwd: "/Users/x/repo",
			sessionId: "sess-123",
			uid: 501,
		});
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.endsWith(join("claude-501", "-Users-x-repo", "sess-123", "scratchpad"))).toBe(
				true,
			);
		}
	});

	it("returns [] without a uid (non-POSIX host)", () => {
		expect(
			deriveScratchpadCandidates({ cwd: "/Users/x/repo", sessionId: "sess-123", uid: undefined }),
		).toEqual([]);
	});

	it("falls back to the raw base path when realpathSync fails", () => {
		// This file's module-level mock makes realpathSync always throw.
		const candidates = deriveScratchpadCandidates({ cwd: "/a/b", sessionId: "s1", uid: 42 });
		expect(candidates.length).toBeGreaterThan(0);
		for (const c of candidates) {
			expect(c.endsWith(join("claude-42", "-a-b", "s1", "scratchpad"))).toBe(true);
		}
	});
});

// Motivating incident: a cloned repo in one session's scratchpad spent the whole
// 2000-file cap, so both surviving manifests read `truncated: true` and every
// agent-authored artifact — including a hand-rolled patch applier — was evicted
// before it could be archived.
describe("archiveScratchpadDir — foreign-project-root exclusion", () => {
	it("skips a cloned tree whole and keeps the session's own files", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "oh-my-pi", "src"), { recursive: true });
		writeFileSync(join(source, "oh-my-pi", "package.json"), "{}\n");
		writeFileSync(join(source, "oh-my-pi", "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(source, "oh-my-pi", "src", "b.ts"), "export const b = 2;\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "f1" });
		expect(summary?.fileCount).toBe(2); // only the fixture's own two files
		expect(summary?.skipped.find((s) => s.path === "oh-my-pi")?.reason).toBe("vendored-tree");
	});

	it("recognises a bare git checkout carrying no package.json", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "vendored", ".git"), { recursive: true });
		writeFileSync(join(source, "vendored", ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(source, "vendored", "README.md"), "theirs\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "f2" });
		expect(summary?.fileCount).toBe(2);
		expect(summary?.skipped.find((s) => s.path === "vendored")?.reason).toBe("vendored-tree");
	});

	it("recognises Cargo / Go / Python roots too", () => {
		const { source, destRoot } = makeFixture();
		for (const [dir, marker] of [
			["rs", "Cargo.toml"],
			["go", "go.mod"],
			["py", "pyproject.toml"],
		] as const) {
			mkdirSync(join(source, dir), { recursive: true });
			writeFileSync(join(source, dir, marker), "x\n");
			writeFileSync(join(source, dir, "code.txt"), "y\n");
		}
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "f3" });
		expect(summary?.fileCount).toBe(2);
	});

	it("does NOT treat the scratchpad ROOT as foreign", () => {
		const { source, destRoot } = makeFixture();
		writeFileSync(join(source, "package.json"), '{"name":"repro"}\n');
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "f4" });
		expect(summary?.fileCount).toBe(3);
	});
});

describe("archiveScratchpadDir — archive_excludes globs", () => {
	it("skips paths matching a configured glob", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "bulk"), { recursive: true });
		writeFileSync(join(source, "bulk", "one.txt"), "a\n");
		const summary = archiveScratchpadDir({
			sourceDir: source,
			destRoot,
			sessionId: "g1",
			config: { archive_excludes: ["bulk"] },
		});
		expect(summary?.fileCount).toBe(2);
		expect(summary?.skipped.find((s) => s.path === "bulk")?.reason).toBe("excluded-glob");
	});

	it("archives everything when no globs are configured", () => {
		const { source, destRoot } = makeFixture();
		mkdirSync(join(source, "bulk"), { recursive: true });
		writeFileSync(join(source, "bulk", "one.txt"), "a\n");
		const summary = archiveScratchpadDir({ sourceDir: source, destRoot, sessionId: "g2" });
		expect(summary?.fileCount).toBe(3);
	});
});

describe("runSessionEndScratchpadArchive", () => {
	/** Creates a real scratchpad directory at the exact host-layout path
	 *  `deriveScratchpadCandidates` would derive for (cwd, sessionId), so the
	 *  private `archiveSessionScratchpad` lookup succeeds end-to-end. */
	function setupRealScratchpad(cwd: string, sessionId: string): void {
		const uid = process.getuid?.();
		if (uid === undefined) throw new Error("test requires a POSIX host (process.getuid)");
		const candidates = deriveScratchpadCandidates({ cwd, sessionId, uid });
		const dir = candidates[0];
		if (!dir) throw new Error("no candidate scratchpad path derived");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "note.txt"), "hello\n");
	}

	it("does nothing when scratchpad_archive.enabled is false", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const log = vi.fn<(message: string) => void>();
		runSessionEndScratchpadArchive({
			cwd,
			sessionId: "disabled-1",
			rules: ({ ...completeGuardRulesConfigFixture(), ...{ scratchpad_archive: { enabled: false } } }),
			log,
		});
		expect(log).not.toHaveBeenCalled();
	});

	it("logs nothing when no scratchpad exists for the session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const log = vi.fn<(message: string) => void>();
		runSessionEndScratchpadArchive({
			cwd,
			sessionId: `no-scratch-${Date.now()}`,
			rules: ({ ...completeGuardRulesConfigFixture(), ...{} }),
			log,
		});
		expect(log).not.toHaveBeenCalled();
	});

	it("archives a real scratchpad and logs the summary", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const sessionId = `real-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		const log = vi.fn<(message: string) => void>();
		runSessionEndScratchpadArchive({ cwd, sessionId, rules: ({ ...completeGuardRulesConfigFixture(), ...{} }), log });
		expect(log).toHaveBeenCalledTimes(1);
		const message = nonNull(log.mock.calls[0])[0];
		expect(message).toContain("Scratchpad archived:");
		expect(message).not.toContain("(truncated)");
	});

	it("logs '(truncated)' when the archived scratchpad hit its file cap", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const sessionId = `truncated-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId); // writes one file (note.txt)
		const log = vi.fn<(message: string) => void>();
		runSessionEndScratchpadArchive({
			cwd,
			sessionId,
			rules: ({ ...completeGuardRulesConfigFixture(), ...{ scratchpad_archive: { max_files: 0 } } }),
			log,
		});
		expect(log).toHaveBeenCalledTimes(1);
		const message = nonNull(log.mock.calls[0])[0];
		expect(message).toContain("(truncated)");
	});

	it("logs a non-fatal failure message when the log callback throws an Error", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const sessionId = `err-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		let calls = 0;
		const log = vi.fn((_msg: string) => {
			calls++;
			if (calls === 1) throw new Error("log boom");
		});
		expect(() =>
			runSessionEndScratchpadArchive({ cwd, sessionId, rules: ({ ...completeGuardRulesConfigFixture(), ...{} }), log }),
		).not.toThrow();
		expect(log).toHaveBeenCalledTimes(2);
		expect((nonNull(log.mock.calls[1]))[0]).toBe(
			"Scratchpad archive failed (non-fatal): log boom",
		);
	});

	it("logs a non-fatal failure message when the log callback throws a non-Error", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sess-end-cwd-"));
		const sessionId = `errstr-${Date.now()}`;
		setupRealScratchpad(cwd, sessionId);
		let calls = 0;
		const log = vi.fn((_msg: string) => {
			calls++;
			if (calls === 1) throw "log boom string";
		});
		runSessionEndScratchpadArchive({ cwd, sessionId, rules: ({ ...completeGuardRulesConfigFixture(), ...{} }), log });
		expect(log).toHaveBeenCalledTimes(2);
		expect((nonNull(log.mock.calls[1]))[0]).toBe(
			"Scratchpad archive failed (non-fatal): log boom string",
		);
	});
});
