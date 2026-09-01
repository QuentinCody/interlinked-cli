// ===========================================
// live-snapshot — round-trip + sweep coverage
// ===========================================
// Snapshots back the per-event durability path: every recordEvent rewrites
// `<id>.live.json`, every restart reads it back. Round-trip parity, atomic
// rename, missing-file safety, and TTL sweep are the four invariants.

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LIVE_TTL_MS,
	deleteLiveSnapshot,
	liveSnapshotPath,
	readLiveSnapshot,
	sweepStaleLiveSnapshots,
	writeLiveSnapshot,
} from "../live-snapshot.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "interlinked-livesnap-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("liveSnapshotPath", () => {
	it("resolves under .interlinked/sessions and creates the dir", () => {
		const p = liveSnapshotPath(tmpDir, "abc-123");
		expect(p).not.toBeNull();
		expect(p).toContain(join(tmpDir, ".interlinked", "sessions"));
		expect(p?.endsWith(".live.json")).toBe(true);
		expect(existsSync(join(tmpDir, ".interlinked", "sessions"))).toBe(true);
	});

	it("rejects path-traversal session_ids", () => {
		const sanitized = liveSnapshotPath(tmpDir, "../../../etc/passwd");
		// sanitizeSessionId scrubs slashes to underscores, so the resolved path
		// is still inside the sessions dir — verify the safe path stays inside.
		expect(sanitized).not.toBeNull();
		expect(sanitized?.startsWith(join(tmpDir, ".interlinked", "sessions"))).toBe(true);
		expect(sanitized).not.toContain("../");
	});

	it("returns null on a session_id that sanitizes to empty", () => {
		// sanitizeSessionId replaces non-[A-Za-z0-9_-] with "_", so even all
		// special chars become underscores — the truly-empty case is just "".
		const p = liveSnapshotPath(tmpDir, "");
		expect(p).toBeNull();
	});
});

describe("writeLiveSnapshot / readLiveSnapshot round-trip", () => {
	it("persists and reads back exactly", () => {
		const snap = {
			session_id: "round-trip-1",
			tool_call_count: 7,
			files_read: ["a.ts", "b.ts"],
			acknowledged_checks: [],
			nested: { foo: 42, bar: [1, 2, 3] },
		};
		const wrote = writeLiveSnapshot(tmpDir, "round-trip-1", snap);
		expect(wrote.ok).toBe(true);

		const read = readLiveSnapshot(tmpDir, "round-trip-1");
		expect(read).toEqual(snap);
	});

	it("uses atomic rename — no .tmp left over after a successful write", () => {
		writeLiveSnapshot(tmpDir, "atomic-1", { session_id: "atomic-1" });
		const path = liveSnapshotPath(tmpDir, "atomic-1");
		expect(path).not.toBeNull();
		expect(existsSync(path as string)).toBe(true);
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});

	it("returns null when the snapshot file does not exist", () => {
		expect(readLiveSnapshot(tmpDir, "never-written")).toBeNull();
	});

	it("returns null on a corrupted snapshot — never throws", () => {
		const path = liveSnapshotPath(tmpDir, "corrupt-1");
		expect(path).not.toBeNull();
		writeFileSync(path as string, "{not valid json");
		expect(readLiveSnapshot(tmpDir, "corrupt-1")).toBeNull();
	});

	it("returns null on a snapshot that parses to a non-object (array, primitive)", () => {
		const path = liveSnapshotPath(tmpDir, "wrong-shape");
		expect(path).not.toBeNull();
		writeFileSync(path as string, "[1, 2, 3]");
		expect(readLiveSnapshot(tmpDir, "wrong-shape")).toBeNull();
	});
});

describe("deleteLiveSnapshot", () => {
	it("removes an existing snapshot", () => {
		writeLiveSnapshot(tmpDir, "deletable", { session_id: "deletable" });
		const path = liveSnapshotPath(tmpDir, "deletable") as string;
		expect(existsSync(path)).toBe(true);
		deleteLiveSnapshot(tmpDir, "deletable");
		expect(existsSync(path)).toBe(false);
	});

	it("is idempotent on a missing snapshot", () => {
		expect(() => deleteLiveSnapshot(tmpDir, "missing")).not.toThrow();
	});
});

describe("sweepStaleLiveSnapshots", () => {
	// Freeze the clock so the relative-time backdating below (and the SUT's own
	// `Date.now()` cutoff) read from one deterministic reference instead of the
	// wall clock — no flake near the TTL boundary.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("removes only files older than the TTL", () => {
		writeLiveSnapshot(tmpDir, "fresh", { session_id: "fresh" });
		writeLiveSnapshot(tmpDir, "stale", { session_id: "stale" });
		const stalePath = liveSnapshotPath(tmpDir, "stale") as string;
		// Backdate the stale file by 49h (> 48h TTL)
		const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
		utimesSync(stalePath, old, old);

		const result = sweepStaleLiveSnapshots(tmpDir);
		expect(result.scanned).toBe(2);
		expect(result.removed).toEqual([stalePath]);
		expect(existsSync(stalePath)).toBe(false);
		expect(existsSync(liveSnapshotPath(tmpDir, "fresh") as string)).toBe(true);
	});

	it("respects a custom TTL", () => {
		writeLiveSnapshot(tmpDir, "minute-old", { session_id: "minute-old" });
		const path = liveSnapshotPath(tmpDir, "minute-old") as string;
		const past = new Date(Date.now() - 90_000);
		utimesSync(path, past, past);

		// 1-minute TTL — 90s old file is past it.
		const result = sweepStaleLiveSnapshots(tmpDir, 60_000);
		expect(result.removed).toEqual([path]);
	});

	it("ignores .trajectory.json siblings (only sweeps .live.json)", () => {
		const trajPath = join(tmpDir, ".interlinked", "sessions", "x.trajectory.json");
		writeLiveSnapshot(tmpDir, "live-1", { session_id: "live-1" });
		writeFileSync(trajPath, "{}");
		const old = new Date(Date.now() - 100 * 60 * 60 * 1000);
		utimesSync(trajPath, old, old);

		const result = sweepStaleLiveSnapshots(tmpDir);
		expect(result.removed).toEqual([]);
		expect(existsSync(trajPath)).toBe(true);
	});

	it("returns zero counts when sessions dir does not exist", () => {
		const empty = mkdtempSync(join(tmpdir(), "interlinked-empty-"));
		const result = sweepStaleLiveSnapshots(empty);
		expect(result).toEqual({ scanned: 0, removed: [] });
		rmSync(empty, { recursive: true, force: true });
	});
});

describe("DEFAULT_LIVE_TTL_MS", () => {
	it("is 48 hours", () => {
		expect(DEFAULT_LIVE_TTL_MS).toBe(48 * 60 * 60 * 1000);
	});
});

describe("integration with SessionTracker.serialize/hydrate", () => {
	it("a snapshot written by a tracker round-trips back into another tracker", async () => {
		const { SessionTracker } = await import("../session-state.js");
		const writer = new SessionTracker();
		writer.recordEvent({
			hook_event: "PostToolUse",
			session_id: "rtt-session",
			agent_name: "alice",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
			timestamp: "2026-05-05T10:00:00Z",
		});
		const session = writer.get("rtt-session");
		// Acknowledge a check so we have non-default state to round-trip.
		const { acknowledgeChecks } = await import("../session-state.js");
		if (session) acknowledgeChecks(session, "src/x.ts", ["typescript"]);

		const snap = writer.serialize("rtt-session");
		expect(snap).not.toBeNull();
		const wrote = writeLiveSnapshot(tmpDir, "rtt-session", snap as object as Record<string, unknown>);
		expect(wrote.ok).toBe(true);

		// Simulate a daemon restart: brand-new tracker, hydrate from disk.
		const reader = new SessionTracker();
		const read = readLiveSnapshot(tmpDir, "rtt-session");
		expect(read).not.toBeNull();
		const restored = reader.hydrate(read as Record<string, unknown>);
		expect(restored).not.toBeNull();
		expect(restored?.tool_call_count).toBe(1);
		expect(restored?.files_written.has("src/x.ts")).toBe(true);
		expect(restored?.acknowledged_checks.has("src/x.ts::typescript")).toBe(true);
	});
});
