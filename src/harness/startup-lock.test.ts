import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: spies on openSync/statSync/writeFileSync only (call-through to the
// real implementation by default) while every other fs export stays
// untouched. Plain `vi.spyOn(fs, ...)` throws "Module namespace is not
// configurable in ESM" for node:fs — see src/lib/file-mutation-lock.test.ts
// for the prior art. Used only to force the rare fs-failure branches
// (read-only mount races, a losing second steal attempt) that real races
// cannot reliably reproduce; every other case in this file drives genuine
// fs state.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		openSync: vi.fn(actual.openSync),
		statSync: vi.fn(actual.statSync),
		writeFileSync: vi.fn(actual.writeFileSync),
	};
});

import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import {
	acquireStartupLock,
	isStartupLockStale,
	readStartupLockHolder,
	releaseStartupLock,
	STARTUP_LOCK_INITIALIZATION_GRACE_MS,
	STARTUP_LOCK_TTL_MS,
	startupInFlight,
	startupLockPath,
	touchStartupLock,
	touchStartupLockHolder,
	transferStartupLock,
	waitForDaemonSocket,
} from "./startup-lock.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "il-startup-lock-"));
	mkdirSync(join(root, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a lock file as if another (live) process held it. */
function foreignLock(at: number, pid = process.pid): void {
	writeFileSync(startupLockPath(root), JSON.stringify({ pid, at }));
}

describe("acquireStartupLock — positive (must fire: exactly one binder)", () => {
	it("P1: the first caller acquires and records its pid", () => {
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
		expect(readStartupLockHolder(root)?.pid).toBe(process.pid);
	});

	it("P2: two concurrent starts collapse to ONE binder", () => {
		const first = acquireStartupLock(root);
		const second = acquireStartupLock(root);
		expect(first.acquired).toBe(true);
		expect(second.acquired).toBe(false);
		if (second.acquired) throw new Error("unreachable");
		expect(second.holder?.pid).toBe(process.pid);
	});

	it("P3: three concurrent starts still yield exactly one winner", () => {
		const results = [acquireStartupLock(root), acquireStartupLock(root), acquireStartupLock(root)];
		expect(results.filter((r) => r.acquired)).toHaveLength(1);
	});

	it("P4: a lock older than the TTL is stolen, not obeyed forever", () => {
		foreignLock(Date.now() - STARTUP_LOCK_TTL_MS - 1_000);
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
	});

	it("P5: a lock held by a dead pid is stolen", () => {
		foreignLock(Date.now(), 999_999_998);
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
	});

	it("P6: releasing lets the next caller acquire", () => {
		const first = acquireStartupLock(root);
		if (!first.acquired) throw new Error("expected acquire");
		first.release();
		expect(existsSync(startupLockPath(root))).toBe(false);
		expect(acquireStartupLock(root).acquired).toBe(true);
	});
});

describe("acquireStartupLock — negative (must not fire)", () => {
	it("N1: a fresh lock from a live holder is NOT stolen", () => {
		foreignLock(Date.now());
		expect(isStartupLockStale(readStartupLockHolder(root), Date.now())).toBe(false);
		expect(acquireStartupLock(root).acquired).toBe(false);
	});

	it("N2: releaseStartupLock leaves ANOTHER process's lock alone", () => {
		writeFileSync(startupLockPath(root), JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
		releaseStartupLock(root);
		expect(existsSync(startupLockPath(root))).toBe(true);
	});

	it("N3: release leaves initializing or malformed lock metadata alone", () => {
		const path = startupLockPath(root);
		writeFileSync(path, "");
		releaseStartupLock(root);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf-8")).toBe("");
	});

	it("N4: fresh unreadable lock metadata is treated as initialization, not stolen", () => {
		writeFileSync(startupLockPath(root), "not json");
		expect(readStartupLockHolder(root)).toBeNull();
		expect(acquireStartupLock(root).acquired).toBe(false);
	});

	it("N5: unreadable lock metadata is reclaimed after the initialization grace", () => {
		const path = startupLockPath(root);
		writeFileSync(path, "not json");
		const stale = new Date(Date.now() - STARTUP_LOCK_INITIALIZATION_GRACE_MS - 1_000);
		utimesSync(path, stale, stale);
		expect(acquireStartupLock(root).acquired).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8")).pid).toBe(process.pid);
	});

	it("N6: startupInFlight is false with no lock and false for an expired one", () => {
		expect(startupInFlight(root)).toBe(false);
		foreignLock(Date.now() - STARTUP_LOCK_TTL_MS - 1);
		expect(startupInFlight(root)).toBe(false);
	});
});

describe("acquireStartupLock — fs failure branches (forced via mocked node:fs)", () => {
	afterEach(() => {
		vi.mocked(openSync).mockRestore();
		vi.mocked(statSync).mockRestore();
	});

	it("N7: a non-EEXIST open failure (read-only mount) is treated as a degraded acquire, not a real lock file", () => {
		vi.mocked(openSync).mockImplementationOnce(() => {
			// SAFETY: constructing a synthetic fs error for the test fixture;
			// `writeLockFile` only reads `.code`, which we set explicitly below.
			const err: NodeJS.ErrnoException = new Error("EACCES: permission denied, open");
			err.code = "EACCES";
			throw err;
		});
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
		// The open never actually succeeded, so no lock file exists on disk —
		// this is a no-mutex degraded start, distinct from a real acquire.
		expect(readStartupLockHolder(root)).toBeNull();
	});

	it("N8: a stat failure while checking the initialization grace treats malformed metadata as stealable stale state", () => {
		writeFileSync(startupLockPath(root), "not json");
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw new Error("ENOENT: no such file or directory, stat");
		});
		const lock = acquireStartupLock(root);
		expect(lock.acquired).toBe(true);
		expect(readStartupLockHolder(root)?.pid).toBe(process.pid);
	});

	it("N9: losing the steal attempt AGAIN reports the freshly re-read holder, not the stale one it started from", () => {
		// Seed a lock held by a dead pid so the first attempt is judged stale
		// and a steal is attempted; force every open to fail with EEXIST so
		// the retry-after-unlink also loses, exercising the final fallback.
		writeFileSync(startupLockPath(root), JSON.stringify({ pid: 999_999_998, at: Date.now() }));
		vi.mocked(openSync).mockImplementation(() => {
			// SAFETY: constructing a synthetic fs error for the test fixture;
			// `writeLockFile` only reads `.code`, which we set explicitly below.
			const err: NodeJS.ErrnoException = new Error("EEXIST: file already exists, open");
			err.code = "EEXIST";
			throw err;
		});
		const result = acquireStartupLock(root);
		expect(result.acquired).toBe(false);
		if (result.acquired) throw new Error("unreachable");
		// The unlink between attempts really removed the file (mocked open
		// never wrote anything back), so the freshly re-read holder is null —
		// not the stale `{pid: 999999998}` snapshot the first read produced.
		expect(result.holder).toBeNull();
	});
});

describe("touchStartupLock — positive (must refresh a held lock)", () => {
	it("P1: refreshing an old-but-alive lock's own pid stops it reading stale", () => {
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		const pastTtl = Date.now() - STARTUP_LOCK_TTL_MS - 1_000;
		writeFileSync(startupLockPath(root), JSON.stringify({ pid: process.pid, at: pastTtl }));
		expect(isStartupLockStale(readStartupLockHolder(root), Date.now())).toBe(true);

		touchStartupLock(root);

		expect(isStartupLockStale(readStartupLockHolder(root), Date.now())).toBe(false);
	});

	it("P2: closes the race — a slow-but-alive holder is never stolen mid-poll", () => {
		// Simulates `daemonizeHarness`'s up-to-60s poll loop outliving the 15s
		// TTL: without a heartbeat, a concurrent `acquireStartupLock` call past
		// the TTL steals the lock out from under a holder that is still working.
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		writeFileSync(
			startupLockPath(root),
			JSON.stringify({ pid: process.pid, at: Date.now() - STARTUP_LOCK_TTL_MS - 5_000 }),
		);

		touchStartupLock(root);
		const contender = acquireStartupLock(root);

		expect(contender.acquired).toBe(false);
	});
});

describe("touchStartupLock — negative (must not touch someone else's lock)", () => {
	it("N1: a lock owned by a different pid is left byte-for-byte alone", () => {
		const foreignAt = Date.now() - STARTUP_LOCK_TTL_MS - 1_000;
		foreignLock(foreignAt, process.pid + 1);
		touchStartupLock(root);
		expect(readStartupLockHolder(root)).toEqual({ pid: process.pid + 1, at: foreignAt });
	});

	it("N2: no lock file present is a silent no-op, not a throw", () => {
		expect(() => touchStartupLock(root)).not.toThrow();
		expect(existsSync(startupLockPath(root))).toBe(false);
	});
});

describe("transferStartupLock — hook-to-daemon ownership handoff", () => {
	it("P1: transfers this process's fresh lease to the spawned child", () => {
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		expect(transferStartupLock(root, { childPid: 424_242, nowMs: 12_345 })).toBe(true);
		expect(readStartupLockHolder(root)).toEqual({ pid: 424_242, at: 12_345 });
	});

	it("N1: refuses to overwrite another process's lease", () => {
		foreignLock(Date.now(), process.pid + 1);
		expect(transferStartupLock(root, { childPid: 424_242 })).toBe(false);
		expect(readStartupLockHolder(root)?.pid).toBe(process.pid + 1);
	});

	it("N1b: a temp-file write failure (replaceStartupLockHolder) leaves the original holder untouched", () => {
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw new Error("ENOSPC: no space left on device");
		});
		expect(transferStartupLock(root, { childPid: 424_242, nowMs: 99_999 })).toBe(false);
		expect(readStartupLockHolder(root)?.pid).toBe(process.pid);
		vi.mocked(writeFileSync).mockRestore();
	});

	it("P2: the launching parent can heartbeat the transferred child lease", () => {
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		expect(transferStartupLock(root, { childPid: 424_242, nowMs: 10_000 })).toBe(true);
		touchStartupLockHolder(root, { holderPid: 424_242, nowMs: 20_000 });
		expect(readStartupLockHolder(root)).toEqual({ pid: 424_242, at: 20_000 });
	});

	it("N2: a mismatched parent heartbeat leaves the child lease unchanged", () => {
		const lock = acquireStartupLock(root);
		if (!lock.acquired) throw new Error("expected acquire");
		expect(transferStartupLock(root, { childPid: 424_242, nowMs: 10_000 })).toBe(true);
		touchStartupLockHolder(root, { holderPid: 777_777, nowMs: 20_000 });
		expect(readStartupLockHolder(root)).toEqual({ pid: 424_242, at: 10_000 });
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
		"N3: rejects an invalid child pid (%s)",
		(childPid) => {
			const lock = acquireStartupLock(root);
			if (!lock.acquired) throw new Error("expected acquire");
			expect(transferStartupLock(root, { childPid })).toBe(false);
			expect(readStartupLockHolder(root)?.pid).toBe(process.pid);
		},
	);
});

describe("waitForDaemonSocket — loser waits instead of binding", () => {
	it("P1: resolves true as soon as a socket answers", async () => {
		let calls = 0;
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 1_000,
			poll_ms: 1,
			listSockets: () => ["/tmp/x.sock"],
			probe: () => Promise.resolve(++calls >= 2),
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(true);
		expect(calls).toBe(2);
	});

	it("N1: resolves false when nothing answers before the deadline", async () => {
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 0,
			poll_ms: 1,
			listSockets: () => ["/tmp/x.sock"],
			probe: () => Promise.resolve(false),
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(false);
	});

	it("N2: no socket files at all still terminates (no infinite loop)", async () => {
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 0,
			poll_ms: 1,
			sleep: () => Promise.resolve(),
		});
		expect(ok).toBe(false);
	});

	it("N2b: with no sleep override, the default closure paces the poll loop to a handful of ticks", async () => {
		// No `sleep` override — this is the only case in the file that reaches
		// the module's own default `sleep` closure instead of a test-supplied
		// stub. `listSockets` is overridden only to COUNT polls, not to skip
		// the default sleep: the loop's own `Date.now() >= deadline` check
		// bounds wall-clock elapsed time regardless of what `sleep` does, so
		// timing the call cannot tell a real ~10ms delay apart from an
		// instantly-resolving one — only the number of polls can. A real
		// default sleep yields a handful of ticks in 30ms; an instant-resolve
		// mutant spins thousands of times before the deadline check fires.
		let ticks = 0;
		const ok = await waitForDaemonSocket(root, {
			timeout_ms: 30,
			poll_ms: 10,
			listSockets: () => {
				ticks += 1;
				return [];
			},
		});
		expect(ok).toBe(false);
		expect(ticks).toBeLessThanOrEqual(6);
	});

	it("N3: a silent accepting listener is not a ready startup winner", async () => {
		const socketPath = join(root, ".interlinked", "harness.sock");
		const peers = new Set<Socket>();
		const server = createServer((socket) => {
			peers.add(socket);
			socket.once("close", () => peers.delete(socket));
			/* accepts connections but never speaks the harness protocol */
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			await expect(
				waitForDaemonSocket(root, { timeout_ms: 0, poll_ms: 10 }),
			).resolves.toBe(false);
		} finally {
			for (const peer of peers) peer.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
