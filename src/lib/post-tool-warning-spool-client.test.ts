import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spies on the handful of fs entry points a few tests below need to fail on
// command (a corrupted/undeletable drain lock, an unlistable spool
// directory, a read that vanishes mid-check) while every other export stays
// untouched and every other test call-throughs to the real filesystem.
// Plain `vi.spyOn(fs, ...)` throws "Module namespace is not configurable in
// ESM" for node:fs — this is the vitest-documented workaround (prior art:
// src/lib/config.mutation-kill.test.ts, src/lib/file-mutation-lock.test.ts).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: vi.fn(actual.mkdirSync),
		readdirSync: vi.fn(actual.readdirSync),
		readFileSync: vi.fn(actual.readFileSync),
		renameSync: vi.fn(actual.renameSync),
		statSync: vi.fn(actual.statSync),
	};
});

import {
	acknowledgeSynchronousPostToolResult,
	drainLatePostToolWarnings,
	QUALITY_WARNING_SPOOL_DIR,
} from "./post-tool-warning-spool-client.js";

let dataDir = "";
let spoolDir = "";

function readyRecord(
	token: string,
	sessionId: string,
	warnings: string[],
	producedAt: string,
): string {
	return JSON.stringify({
		version: 1,
		token,
		session_id: sessionId,
		produced_at: producedAt,
		warnings,
	});
}

function writeReady(
	token: string,
	sessionId: string,
	warnings: string[],
	producedAt: string,
): string {
	const path = join(spoolDir, `${token}.ready.json`);
	writeFileSync(path, readyRecord(token, sessionId, warnings, producedAt));
	return path;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "interlinked-warning-client-"));
	spoolDir = join(dataDir, QUALITY_WARNING_SPOOL_DIR);
	mkdirSync(spoolDir);
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

describe("acknowledgeSynchronousPostToolResult", () => {
	it("removes only its request-owned ready record and deduplicates a rolling-upgrade legacy copy", () => {
		const token = "request-token-0001";
		const own = writeReady(
			token,
			"session-a",
			["direct warning"],
			new Date().toISOString(),
		);
		const foreign = writeReady(
			"request-token-0002",
			"session-b",
			["foreign warning"],
			new Date(Date.now() - 1_000).toISOString(),
		);
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["direct warning", "legacy warning"]));

		expect(acknowledgeSynchronousPostToolResult(dataDir, token, ["direct warning"])).toEqual([
			"direct warning",
		]);
		expect(existsSync(own)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(legacy)).toBe(false);
	});

	it("discards an unparseable legacy file during acknowledgement instead of leaving it behind", () => {
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, "not-json");

		expect(
			acknowledgeSynchronousPostToolResult(dataDir, "request-token-0003", ["direct warning"]),
		).toEqual(["direct warning"]);
		expect(existsSync(legacy)).toBe(false);
	});
});

describe("drainLatePostToolWarnings", () => {
	it("defers young same-session work, then claims that session exactly once while retaining foreign work", () => {
		const now = Date.now();
		const eligible = writeReady(
			"eligible-token-001",
			"session-a",
			["late warning"],
			new Date(now - 1_000).toISOString(),
		);
		const foreign = writeReady(
			"foreign-token-0001",
			"session-b",
			["foreign warning"],
			new Date(now - 1_000).toISOString(),
		);
		const young = writeReady(
			"young-token-000001",
			"session-a",
			["young warning"],
			new Date(now - 50).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(eligible)).toBe(true);
		expect(existsSync(young)).toBe(true);
		expect(drainLatePostToolWarnings(dataDir, "session-a", now + 1_000)).toEqual([
			"late warning",
			"young warning",
		]);
		expect(drainLatePostToolWarnings(dataDir, "session-a", now + 1_000)).toEqual([]);
		expect(existsSync(eligible)).toBe(false);
		expect(existsSync(foreign)).toBe(true);
		expect(existsSync(young)).toBe(false);
	});

	it("silently discards stale and malformed records without replaying them as clean output", () => {
		const stale = writeReady(
			"stale-token-00001",
			"session-a",
			["stale warning"],
			"2020-01-01T00:00:00.000Z",
		);
		const malformed = join(spoolDir, "malformed-token-01.ready.json");
		writeFileSync(malformed, "not-json");
		const malformedActive = join(spoolDir, "malformed-token-01.active.json");
		writeFileSync(
			malformedActive,
			JSON.stringify({
				version: 1,
				token: "malformed-token-01",
				session_id: "session-a",
				started_at: "2020-01-01T00:00:00.000Z",
				client_pid: 999_999,
			}),
		);
		const staleActive = join(spoolDir, "stale-token-00001.active.json");
		writeFileSync(
			staleActive,
			JSON.stringify({
				version: 1,
				token: "stale-token-00001",
				session_id: "session-a",
				started_at: "2020-01-01T00:00:00.000Z",
				// A reused live PID must not pin a day-old record forever.
				client_pid: process.pid,
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(staleActive)).toBe(false);
		expect(existsSync(malformed)).toBe(false);
		expect(existsSync(malformedActive)).toBe(false);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
	});

	it("defers both modern and legacy delivery while the same request is still active", () => {
		const token = "active-token-00001";
		const active = join(spoolDir, `${token}.active.json`);
		writeFileSync(
			active,
			JSON.stringify({
				version: 1,
				token,
				session_id: "session-a",
				started_at: new Date().toISOString(),
				client_pid: process.pid,
			}),
		);
		const ready = writeReady(
			token,
			"session-a",
			["same warning"],
			new Date(Date.now() - 1_000).toISOString(),
		);
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["unscoped foreign warning"]));

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(active)).toBe(true);
		expect(existsSync(ready)).toBe(true);
		expect(existsSync(legacy)).toBe(true);

		unlinkSync(active);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual(["same warning"]);
		expect(existsSync(legacy)).toBe(false);
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
	});

	it("does not create a drain lock or output when there is no pending work", () => {
		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(join(spoolDir, ".drain.lock"))).toBe(false);
	});

	it("sweeps an abandoned active-only marker but preserves a live one", () => {
		const now = Date.now();
		const abandoned = join(spoolDir, "abandoned-token01.active.json");
		writeFileSync(
			abandoned,
			JSON.stringify({
				version: 1,
				token: "abandoned-token01",
				session_id: "session-a",
				started_at: new Date(now - 1_000).toISOString(),
				client_pid: 999_999,
			}),
		);
		const live = join(spoolDir, "live-token-000001.active.json");
		writeFileSync(
			live,
			JSON.stringify({
				version: 1,
				token: "live-token-000001",
				session_id: "session-b",
				started_at: new Date(now - 1_000).toISOString(),
				client_pid: process.pid,
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(abandoned)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});

	it("sweeps a malformed active-only marker after the compatibility grace period", () => {
		const malformed = join(spoolDir, "malformed-active1.active.json");
		writeFileSync(malformed, "not-json");

		expect(drainLatePostToolWarnings(dataDir, "session-a", Date.now() + 1_000)).toEqual([]);
		expect(existsSync(malformed)).toBe(false);
	});

	it("discards a ready record whose session_id fails string validation without delivering it", () => {
		const now = Date.now();
		const bad = join(spoolDir, "bad-session-id-00001.ready.json");
		writeFileSync(
			bad,
			JSON.stringify({
				version: 1,
				token: "bad-session-id-00001",
				session_id: 12345,
				produced_at: new Date(now - 1_000).toISOString(),
				warnings: ["unreachable warning"],
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(bad)).toBe(false);
	});

	it("discards a ready record whose warnings array fails shape validation without delivering it", () => {
		const now = Date.now();
		const bad = join(spoolDir, "bad-warnings-token-001.ready.json");
		writeFileSync(
			bad,
			JSON.stringify({
				version: 1,
				token: "bad-warnings-token-001",
				session_id: "session-a",
				produced_at: new Date(now - 1_000).toISOString(),
				warnings: [42],
			}),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(bad)).toBe(false);
	});

	it("degrades to legacy-only delivery when the spool directory cannot be listed", () => {
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["legacy-only warning"]));
		// hasPendingSpoolWork (2 calls) + readyPaths + sweep's arg + activeForSession's
		// arg = 5 spoolFiles() calls, each backed by exactly one readdirSync() call.
		for (let i = 0; i < 5; i++) {
			vi.mocked(readdirSync).mockImplementationOnce(() => {
				throw Object.assign(new Error("EACCES: permission denied, scandir"), {
					code: "EACCES",
				});
			});
		}

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual(["legacy-only warning"]);
		expect(existsSync(legacy)).toBe(false);
	});

	it("delivers nothing and still claims an unparseable legacy file when there are no modern records", () => {
		// Unlike the acknowledgeSynchronousPostToolResult case above, this path
		// (no ready/active records at all) actually CONSUMES consumeLegacyWarnings'
		// return value at consumeLegacyAfterModern's hadModernRecords===false arm
		// (`for (const warning of consumeLegacyWarnings(dataDir)) warnings.add(warning)`),
		// so it is the only case that can tell "the catch returned []" apart from
		// "the catch returned the parsed content" or an injected value.
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, "not-json");

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(legacy)).toBe(false);
	});

	it("declines to acquire the drain lock while a live drain is actively holding it", () => {
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
		const pending = writeReady(
			"pending-token-000001",
			"session-a",
			["pending warning"],
			new Date().toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("treats a non-object lock file body as an unrecognized holder rather than a valid one", () => {
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, JSON.stringify([1, 2, 3]));
		const pending = writeReady(
			"shape-token-0000001",
			"session-a",
			["shape warning"],
			new Date().toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("recycles a corrupted lock file that has aged past the drain TTL and completes the drain", () => {
		const now = Date.now();
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, "not-json");
		const old = new Date(now - 200_000);
		utimesSync(lockPath, old, old);
		const pending = writeReady(
			"recycled-token-00001",
			"session-a",
			["recycled warning"],
			new Date(now - 1_000).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual(["recycled warning"]);
		expect(existsSync(pending)).toBe(false);
		expect(existsSync(lockPath)).toBe(false);
	});

	it("abandons the drain when a corrupted lock's age cannot be measured", () => {
		// The pending record is aged past READY_GRACE_MS (unlike a fresh record,
		// which would return [] on its own via hasYoungReadyRecord regardless of
		// whether the lock was reclaimed) and `now` is passed explicitly so a
		// mutant that grants a lease here would actually deliver the warning.
		const now = Date.now();
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, "not-json");
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, stat"), {
				code: "ENOENT",
			});
		});
		const pending = writeReady(
			"unmeasurable-tok0001",
			"session-a",
			["unmeasurable warning"],
			new Date(now - 1_000).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("aborts the drain when a stale lock cannot be renamed away", () => {
		const now = Date.now();
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: now - 100_000 }));
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("EACCES: permission denied, rename"), { code: "EACCES" });
		});
		const pending = writeReady(
			"unrenameable-tok0001",
			"session-a",
			["unrenameable warning"],
			new Date(now - 1_000).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("aborts the drain when the spool directory itself cannot be created", () => {
		rmSync(spoolDir, { recursive: true, force: true });
		const legacy = join(dataDir, "pending-quality-warnings.json");
		writeFileSync(legacy, JSON.stringify(["orphaned warning"]));
		vi.mocked(mkdirSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("EACCES: permission denied, mkdir"), { code: "EACCES" });
		});

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(spoolDir)).toBe(false);
		expect(existsSync(legacy)).toBe(true);
	});

	it("gives up acquiring the lock after two attempts that each find it stale again", () => {
		const now = Date.now();
		const lockPath = join(spoolDir, ".drain.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999_999, at: now - 100_000 }));
		// Fakes both stale-lock reclaims as successful renames without touching the
		// real file, so the SAME stale lock is still there on the second attempt —
		// forcing acquireDrainLease to exhaust its two-attempt budget.
		vi.mocked(renameSync)
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {});
		const pending = writeReady(
			"stuck-token-00000001",
			"session-a",
			["stuck warning"],
			new Date(now - 1_000).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("sweeps an active record whose age cannot be measured because it has no started_at", () => {
		const activePath = join(spoolDir, "unmeasurable-active01.active.json");
		writeFileSync(
			activePath,
			JSON.stringify({
				version: 1,
				token: "unmeasurable-active01",
				session_id: "session-a",
				started_at: null,
				client_pid: process.pid,
			}),
		);
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, stat"), {
				code: "ENOENT",
			});
		});

		expect(drainLatePostToolWarnings(dataDir, "session-a")).toEqual([]);
		expect(existsSync(activePath)).toBe(false);
	});

	it("defers delivery entirely while a pid-less active record is still inside its grace window", () => {
		const now = Date.now();
		const activePath = join(spoolDir, "compat-active-000001.active.json");
		writeFileSync(
			activePath,
			JSON.stringify({
				version: 1,
				token: "compat-active-000001",
				session_id: "session-a",
				started_at: new Date(now).toISOString(),
				client_pid: null,
			}),
		);
		const pending = writeReady(
			"deferred-token-00001",
			"session-a",
			["deferred warning"],
			new Date(now - 1_000).toISOString(),
		);

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([]);
		expect(existsSync(activePath)).toBe(true);
		expect(existsSync(pending)).toBe(true);
	});

	it("still delivers a ready warning when rechecking active ownership fails to reread the record", async () => {
		const nodeFsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
		const now = Date.now();
		const activePath = join(spoolDir, "flaky-active-0000001.active.json");
		writeFileSync(
			activePath,
			JSON.stringify({
				version: 1,
				token: "flaky-active-0000001",
				session_id: "session-a",
				started_at: new Date(now).toISOString(),
				client_pid: process.pid,
			}),
		);
		const ready = writeReady(
			"flaky-ready-token001",
			"session-a",
			["still delivered warning"],
			new Date(now - 1_000).toISOString(),
		);
		// First read (the sweep pass) succeeds for real; the second read — the
		// ownership recheck this test targets — fails, so ownership falls back to
		// "not owned" instead of deferring the whole drain.
		vi.mocked(readFileSync)
			.mockImplementationOnce((path, options) => nodeFsActual.readFileSync(path, options))
			.mockImplementationOnce(() => {
				throw Object.assign(new Error("ENOENT: no such file or directory, read"), {
					code: "ENOENT",
				});
			});

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual([
			"still delivered warning",
		]);
		expect(existsSync(ready)).toBe(false);
	});

	it("still delivers a ready warning when the youth probe fails to reread the record", () => {
		const now = Date.now();
		const ready = writeReady(
			"youth-probe-token001",
			"session-a",
			["youth probe warning"],
			new Date(now - 5_000).toISOString(),
		);
		vi.mocked(readFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("ENOENT: no such file or directory, read"), {
				code: "ENOENT",
			});
		});

		expect(drainLatePostToolWarnings(dataDir, "session-a", now)).toEqual(["youth probe warning"]);
		expect(existsSync(ready)).toBe(false);
	});
});
