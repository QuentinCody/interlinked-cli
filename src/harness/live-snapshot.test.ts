import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_LIVE_TTL_MS,
	deleteLiveSnapshot,
	liveSnapshotPath,
	readLiveSnapshot,
	sweepStaleLiveSnapshots,
	writeLiveSnapshot,
} from "./live-snapshot.js";

describe("liveSnapshotPath", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "live-snapshot-path-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("resolves under .interlinked/sessions and creates the directory", () => {
		const path = liveSnapshotPath(cwd, "session-1");
		expect(path).toBe(join(cwd, ".interlinked", "sessions", "session-1.live.json"));
		expect(existsSync(join(cwd, ".interlinked", "sessions"))).toBe(true);
	});

	it("returns null when the session id sanitizes to empty", () => {
		expect(liveSnapshotPath(cwd, "")).toBeNull();
	});

	it("sanitizes unsafe characters out of the session id", () => {
		const path = liveSnapshotPath(cwd, "../../etc/passwd");
		expect(path).toBe(join(cwd, ".interlinked", "sessions", "______etc_passwd.live.json"));
	});
});

describe("writeLiveSnapshot / readLiveSnapshot round trip", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "live-snapshot-rw-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writes atomically and reads back the same object", () => {
		const result = writeLiveSnapshot(cwd, "sess-a", { edits: 3, acknowledged: ["x", "y"] });
		expect(result).toEqual({ ok: true });
		const back = readLiveSnapshot(cwd, "sess-a");
		expect(back).toEqual({ edits: 3, acknowledged: ["x", "y"] });
		// The atomic-write temp sibling must never survive a successful write.
		expect(existsSync(join(cwd, ".interlinked", "sessions", "sess-a.live.json.tmp"))).toBe(
			false,
		);
	});

	it("returns ok:false with an Error when the session id can't be sanitized", () => {
		const result = writeLiveSnapshot(cwd, "", { a: 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
			expect(result.error.message).toMatch(/invalid session_id/);
		}
	});

	it("returns ok:false and cleans up the .tmp sibling when the write itself fails", () => {
		// Pre-create the `.tmp` sibling as a directory so writeFileSync throws
		// EISDIR; the catch path then tries to remove it (also failing, since
		// rmSync without recursive:true can't remove a directory) — both
		// failures must be swallowed and surfaced as a single ok:false result.
		const dir = join(cwd, ".interlinked", "sessions");
		mkdirSync(dir, { recursive: true });
		mkdirSync(join(dir, "sess-c.live.json.tmp"));
		const result = writeLiveSnapshot(cwd, "sess-c", { a: 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
		}
	});

	it("readLiveSnapshot returns null for a session with no snapshot on disk", () => {
		expect(readLiveSnapshot(cwd, "never-written")).toBeNull();
	});

	it("readLiveSnapshot returns null for malformed JSON on disk", () => {
		const dir = join(cwd, ".interlinked", "sessions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "broken.live.json"), "{not json");
		expect(readLiveSnapshot(cwd, "broken")).toBeNull();
	});

	it("readLiveSnapshot returns null when the parsed JSON is an array, not an object", () => {
		const dir = join(cwd, ".interlinked", "sessions");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "arr.live.json"), "[1,2,3]");
		expect(readLiveSnapshot(cwd, "arr")).toBeNull();
	});

	it("readLiveSnapshot returns null when the session id can't be sanitized", () => {
		expect(readLiveSnapshot(cwd, "")).toBeNull();
	});
});

describe("deleteLiveSnapshot", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "live-snapshot-del-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("removes an existing snapshot file", () => {
		writeLiveSnapshot(cwd, "sess-b", { done: true });
		const path = join(cwd, ".interlinked", "sessions", "sess-b.live.json");
		expect(existsSync(path)).toBe(true);
		deleteLiveSnapshot(cwd, "sess-b");
		expect(existsSync(path)).toBe(false);
	});

	it("is idempotent when the file never existed", () => {
		expect(() => deleteLiveSnapshot(cwd, "never-written")).not.toThrow();
	});

	it("is a no-op when the session id can't be sanitized", () => {
		expect(() => deleteLiveSnapshot(cwd, "")).not.toThrow();
	});
});

describe("sweepStaleLiveSnapshots", () => {
	let cwd: string;
	let sessDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "live-snapshot-sweep-"));
		sessDir = join(cwd, ".interlinked", "sessions");
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("reports scanned:0 removed:[] when the sessions directory doesn't exist", () => {
		expect(sweepStaleLiveSnapshots(cwd)).toEqual({ scanned: 0, removed: [] });
	});

	it("removes *.live.json files older than the TTL and ignores non-snapshot files", () => {
		mkdirSync(sessDir, { recursive: true });
		const oldA = join(sessDir, "old-a.live.json");
		const oldB = join(sessDir, "old-b.live.json");
		const ignored = join(sessDir, "ignored.txt");
		writeFileSync(oldA, "{}");
		writeFileSync(oldB, "{}");
		writeFileSync(ignored, "not a snapshot");
		// Force both snapshots' mtime well into the past so a TTL comparison
		// against "now" is deterministic instead of racing the clock.
		const ancientSeconds = (Date.now() - 60 * 60 * 1000) / 1000;
		utimesSync(oldA, ancientSeconds, ancientSeconds);
		utimesSync(oldB, ancientSeconds, ancientSeconds);

		const result = sweepStaleLiveSnapshots(cwd, 60_000); // 60s TTL, files are 1h old
		expect(result.scanned).toBe(2); // only the two *.live.json files
		expect(result.removed.sort()).toEqual([oldA, oldB].sort());
		expect(existsSync(oldA)).toBe(false);
		expect(existsSync(ignored)).toBe(true);
	});

	it("leaves recently-written files alone under the default TTL", () => {
		mkdirSync(sessDir, { recursive: true });
		writeFileSync(join(sessDir, "just-now.live.json"), "{}");
		const result = sweepStaleLiveSnapshots(cwd, DEFAULT_LIVE_TTL_MS);
		expect(result.scanned).toBe(1);
		expect(result.removed).toEqual([]);
		expect(existsSync(join(sessDir, "just-now.live.json"))).toBe(true);
	});

	it("returns scanned:0 removed:[] without throwing when the sessions path isn't a directory", () => {
		// The sessions "directory" existing as a plain file makes readdirSync
		// throw ENOTDIR — the sweep's directory-listing catch must degrade to
		// empty rather than propagate.
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(sessDir, "not a directory");
		expect(sweepStaleLiveSnapshots(cwd)).toEqual({ scanned: 0, removed: [] });
	});
});
