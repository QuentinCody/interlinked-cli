import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsMod from "node:fs";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Bypass real sanitization so we can hand the module deliberately dangerous
// (traversal) session ids in targeted tests, while normal alnum ids still
// pass through unchanged for the baseline-behavior tests.
vi.mock("./session-paths.js", () => ({
	sanitizeSessionId: (id: string) => id,
}));

// Spy-wrap node:fs with real implementations so call-count assertions can
// distinguish "guard skipped the call" mutants from "guard called it and it
// happened to be a harmless no-op" — return-value alone can't tell those apart.
vi.mock("node:fs", { spy: true });

import {
	deleteLiveSnapshot,
	liveSnapshotPath,
	readLiveSnapshot,
	sweepStaleLiveSnapshots,
	writeLiveSnapshot,
} from "./live-snapshot.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "live-snap-w58-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(cwd, { recursive: true, force: true });
});

describe("liveSnapshotPath — traversal guard (a2e0481f, a0d14d52, 78d3a345)", () => {
	// test-contract: security — liveSnapshotPath must refuse a target that
	// resolves outside .interlinked/sessions/, the path-traversal invariant
	// the resolvedTarget !== resolvedDir && !startsWith(...) check enforces.
	it("rejects a sanitizer-bypassed id that resolves outside sessions/", () => {
		// With sanitizeSessionId mocked to identity, this id contains real path
		// separators, so the resolved target genuinely lands outside sessDir.
		const evil = "../../../outside";
		const result = liveSnapshotPath(cwd, evil);
		expect(result).toBeNull();
	});

	// test-contract: public-api — a normal id resolves to a concrete path
	// inside sessions/, the documented success shape of liveSnapshotPath.
	it("accepts a normal id and returns a path inside sessions/", () => {
		const result = liveSnapshotPath(cwd, "abc123");
		expect(result).not.toBeNull();
		expect(result).toContain(join(".interlinked", "sessions"));
		expect(result).toMatch(/abc123\.live\.json$/);
	});
});

describe("ensureSessionsDir mkdir guard (ad9f2a4d)", () => {
	// test-contract: invariant — mkdirSync should run exactly once to create
	// sessions/, and never again once the directory already exists.
	it("only creates sessions/ once across repeated calls", () => {
		const mkdirSpy = vi.mocked(fsMod.mkdirSync);
		mkdirSpy.mockClear();
		liveSnapshotPath(cwd, "sess1"); // dir missing -> should mkdir
		expect(mkdirSpy).toHaveBeenCalledTimes(1);
		expect(mkdirSpy).toHaveBeenCalledWith(join(cwd, ".interlinked", "sessions"), { recursive: true });
		liveSnapshotPath(cwd, "sess2"); // dir now exists -> should NOT mkdir again
		expect(mkdirSpy).toHaveBeenCalledTimes(1);
	});
});

describe("writeLiveSnapshot cleanup-on-failure (bee2baff, da0f5e5d, 26c24e9b)", () => {
	// test-contract: bug — a failed rename must not leave a `.tmp` sibling on
	// disk; the catch block's cleanup is the only thing that removes it.
	it("removes the .tmp sibling when renameSync fails, and leaves nothing behind", () => {
		const target = liveSnapshotPath(cwd, "failcase")!;
		// Pre-create a directory at the final target path so renameSync(tmp, target) throws.
		fsMod.mkdirSync(target, { recursive: true });

		const result = writeLiveSnapshot(cwd, "failcase", { a: 1 });

		expect(result.ok).toBe(false);
		// The .tmp sibling must be gone — proves the cleanup branch actually ran.
		expect(fsMod.existsSync(`${target}.tmp`)).toBe(false);
	});

	// test-contract: invariant — a clean successful write already renamed the
	// tmp file away, so the cleanup-only rmSync call must never fire.
	it("does not call rmSync at all on a clean successful write", () => {
		const rmSpy = vi.mocked(fsMod.rmSync);
		rmSpy.mockClear();
		const result = writeLiveSnapshot(cwd, "goodcase", { a: 1 });
		expect(result.ok).toBe(true);
		expect(rmSpy).not.toHaveBeenCalled();
	});
});

describe("readLiveSnapshot missing-file short-circuit (9619349101050458, 3f621b20)", () => {
	// test-contract: security — an invalid session id must short-circuit to
	// null before touching the filesystem with a null target; skipping the
	// short-circuit throws (existsSync(null)) instead of returning null.
	it("returns null without throwing for an invalid (empty) session id", () => {
		// sanitizeSessionId is mocked to identity, so "" stays "" and
		// liveSnapshotPath legitimately returns null (the !safeId guard).
		expect(() => readLiveSnapshot(cwd, "")).not.toThrow();
		expect(readLiveSnapshot(cwd, "")).toBeNull();
	});

	// test-contract: invariant — a missing snapshot file must return null
	// via the existsSync guard, never by attempting and catching a read.
	it("does not call readFileSync when the snapshot file does not exist", () => {
		const readSpy = vi.mocked(fsMod.readFileSync);
		readSpy.mockClear();
		const result = readLiveSnapshot(cwd, "never-written");
		expect(result).toBeNull();
		expect(readSpy).not.toHaveBeenCalled();
	});
});

describe("readLiveSnapshot parse-result shape (b6fe40b6, 18d73cc2, e529bbf2, 398ee355)", () => {
	function writeRaw(sessionId: string, raw: string) {
		const target = liveSnapshotPath(cwd, sessionId)!;
		fsMod.writeFileSync(target, raw);
	}

	// test-contract: public-api — a real snapshot written with non-ASCII
	// content must round-trip exactly, which requires reading as utf-8.
	it("round-trips a real JSON object written by writeLiveSnapshot", () => {
		const ok = writeLiveSnapshot(cwd, "roundtrip", { hello: "wörld", n: 1 });
		expect(ok.ok).toBe(true);
		const back = readLiveSnapshot(cwd, "roundtrip");
		expect(back).toEqual({ hello: "wörld", n: 1 });
	});

	// test-contract: boundary — a JSON top-level number is not an object and
	// must be rejected (null), not returned as-is.
	it("returns null for a numeric JSON top-level value", () => {
		writeRaw("numcase", "42");
		expect(readLiveSnapshot(cwd, "numcase")).toBeNull();
	});

	// test-contract: boundary — a JSON top-level string is not an object and
	// must be rejected (null), not returned as-is.
	it("returns null for a string JSON top-level value", () => {
		writeRaw("strcase", '"hello"');
		expect(readLiveSnapshot(cwd, "strcase")).toBeNull();
	});
});

describe("deleteLiveSnapshot guards (5df44cb9, 5af3ac64)", () => {
	// test-contract: security — an invalid session id must short-circuit
	// before ever calling existsSync with a null target.
	it("does not touch the filesystem with a null target for an invalid session id", () => {
		const existsSpy = vi.mocked(fsMod.existsSync);
		existsSpy.mockClear();
		expect(() => deleteLiveSnapshot(cwd, "")).not.toThrow();
		const calledWithNull = existsSpy.mock.calls.some((args) => args[0] === null);
		expect(calledWithNull).toBe(false);
	});

	// test-contract: invariant — deleting a snapshot that was never written
	// must not call rmSync at all (existsSync guard skips it).
	it("does not call rmSync when the snapshot file does not exist", () => {
		const rmSpy = vi.mocked(fsMod.rmSync);
		rmSpy.mockClear();
		deleteLiveSnapshot(cwd, "ghost-session");
		expect(rmSpy).not.toHaveBeenCalled();
	});

	// test-contract: public-api — deleting an existing snapshot must
	// actually remove the file from disk.
	it("actually removes an existing snapshot file", () => {
		writeLiveSnapshot(cwd, "todelete", { x: 1 });
		const target = liveSnapshotPath(cwd, "todelete")!;
		expect(fsMod.existsSync(target)).toBe(true);
		deleteLiveSnapshot(cwd, "todelete");
		expect(fsMod.existsSync(target)).toBe(false);
	});
});

describe("sweepStaleLiveSnapshots (070a54e8, cfe25a52)", () => {
	// test-contract: invariant — when sessions/ doesn't exist, the function
	// must return the empty result WITHOUT ever calling readdirSync.
	it("does not call readdirSync when the sessions dir does not exist", () => {
		const readdirSpy = vi.mocked(fsMod.readdirSync);
		readdirSpy.mockClear();
		const result = sweepStaleLiveSnapshots(cwd, 1000);
		expect(result).toEqual({ scanned: 0, removed: [] });
		expect(readdirSpy).not.toHaveBeenCalled();
	});

	// test-contract: boundary — the cutoff comparison is strictly `<`, so a
	// file whose mtime exactly equals the cutoff must be KEPT, not removed.
	it("keeps a file whose mtime is exactly at the cutoff", () => {
		vi.useFakeTimers();
		const now = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(now);

		const ttlMs = 1000;
		liveSnapshotPath(cwd, "boundary"); // ensures sessions/ exists
		const target = liveSnapshotPath(cwd, "boundary")!;
		fsMod.writeFileSync(target, "{}");

		const cutoff = now.getTime() - ttlMs;
		utimesSync(target, new Date(cutoff), new Date(cutoff));

		const result = sweepStaleLiveSnapshots(cwd, ttlMs);

		// mtimeMs === cutoff: original `<` is false -> file is kept, not removed.
		expect(result.removed).toEqual([]);
		expect(fsMod.existsSync(target)).toBe(true);

		vi.useRealTimers();
	});

	// test-contract: public-api — a file strictly older than the TTL is the
	// documented purge case and must be removed and reported.
	it("removes a file whose mtime is strictly older than the cutoff", () => {
		vi.useFakeTimers();
		const now = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(now);

		const ttlMs = 1000;
		const target = liveSnapshotPath(cwd, "stale")!;
		fsMod.writeFileSync(target, "{}");

		const old = now.getTime() - ttlMs - 5000;
		utimesSync(target, new Date(old), new Date(old));

		const result = sweepStaleLiveSnapshots(cwd, ttlMs);

		expect(result.removed).toEqual([target]);
		expect(fsMod.existsSync(target)).toBe(false);

		vi.useRealTimers();
	});
});
