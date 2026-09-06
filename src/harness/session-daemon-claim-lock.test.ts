// Companion tests for the claim-lock record cluster extracted from
// session-daemon.ts. The lock file is what fences two racing daemon starts, so
// these cover record parsing (every rejection branch), liveness/identity
// classification, and stale-lock recovery.
//
// Fixtures: a real temp directory, because the recovery branches are decided by
// real errno values. Two filesystem shapes stand in for a race that cannot be
// scheduled — a directory parked on the quarantine path (rename fails EISDIR)
// and a hard-link twin of the lock file (POSIX makes that rename a no-op, so
// the canonical path is still occupied when the exclusive create runs). Only
// the "the write itself failed" branch is fault-injected: `node:fs` is mocked
// as a pass-through with `writeFileSync` wrapped, and exactly one test arms it
// with `mockImplementationOnce`.

import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

import { readFileMutationProcessIdentity } from "../lib/file-mutation-lock-identity.js";
import {
	claimLockIsCurrent,
	claimLockRecord,
	isProcessAlive,
	liveClaimLockIsCurrent,
	makeClaimLock,
	readFileText,
	recoverStaleClaimLock,
	removeCurrentClaimLock,
} from "./session-daemon-claim-lock.js";

let temp = "";

afterEach(() => {
	if (temp !== "") rmSync(temp, { recursive: true, force: true });
	temp = "";
});

function tempPidPath(): string {
	temp = mkdtempSync(join(tmpdir(), "session-daemon-claim-"));
	return join(temp, "harness-x.pid");
}

describe("makeClaimLock", () => {
	it("addresses the companion .claim path and records this process", () => {
		const lock = makeClaimLock("/repo/.interlinked/harness-x.pid");
		expect(lock.path).toBe("/repo/.interlinked/harness-x.pid.claim");
		const parsed: unknown = JSON.parse(lock.raw);
		expect(parsed).toMatchObject({ pid: process.pid, token: lock.token });
		expect(lock.raw.endsWith("\n")).toBe(true);
	});

	it("mints a distinct token on every call", () => {
		const a = makeClaimLock("/repo/p.pid");
		const b = makeClaimLock("/repo/p.pid");
		expect(a.token).not.toBe(b.token);
	});
});

describe("readFileText", () => {
	it("returns the bytes of an existing file", () => {
		const path = tempPidPath();
		writeFileSync(path, "hello");
		expect(readFileText(path)).toBe("hello");
	});

	it("returns null for a missing file instead of throwing", () => {
		expect(readFileText(join(tmpdir(), "no-such-claim-file-xyz"))).toBeNull();
	});
});

describe("claimLockRecord", () => {
	const good = {
		pid: 4242,
		token: "t",
		created_at_ms: 1_700_000_000_000,
		boot_id: "boot",
		process_start_id: "start",
	};

	it("parses a well-formed record", () => {
		expect(claimLockRecord(JSON.stringify(good))).toEqual({
			pid: 4242,
			createdAtMs: 1_700_000_000_000,
			bootId: "boot",
			processStartId: "start",
		});
	});

	it("accepts null identity fields", () => {
		const raw = JSON.stringify({ ...good, boot_id: null, process_start_id: null });
		expect(claimLockRecord(raw)).toMatchObject({ bootId: null, processStartId: null });
	});

	it("rejects null input, non-JSON, and non-objects", () => {
		expect(claimLockRecord(null)).toBeNull();
		expect(claimLockRecord("{not json")).toBeNull();
		expect(claimLockRecord("[1,2]")).toBeNull();
		expect(claimLockRecord("null")).toBeNull();
	});

	it("rejects a bad pid, token, or timestamp", () => {
		expect(claimLockRecord(JSON.stringify({ ...good, pid: 0 }))).toBeNull();
		expect(claimLockRecord(JSON.stringify({ ...good, pid: 1.5 }))).toBeNull();
		expect(claimLockRecord(JSON.stringify({ ...good, token: "" }))).toBeNull();
		expect(claimLockRecord(JSON.stringify({ ...good, created_at_ms: "x" }))).toBeNull();
	});

	it("rejects a non-string identity field", () => {
		expect(claimLockRecord(JSON.stringify({ ...good, boot_id: 7 }))).toBeNull();
		expect(claimLockRecord(JSON.stringify({ ...good, process_start_id: 7 }))).toBeNull();
	});
});

describe("isProcessAlive", () => {
	it("reports this process as alive", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("reports an unused PID as dead", () => {
		expect(isProcessAlive(0x7ff_fff0)).toBe(false);
	});
});

describe("liveClaimLockIsCurrent", () => {
	it("is false for a missing record", () => {
		expect(liveClaimLockIsCurrent(null)).toBe(false);
	});

	it("is false when the recorded process is dead", () => {
		expect(
			liveClaimLockIsCurrent({
				pid: 0x7ff_fff0,
				createdAtMs: Date.now(),
				bootId: null,
				processStartId: null,
			}),
		).toBe(false);
	});

	it("is true for this live process when identity is unknown and the record is fresh", () => {
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now(),
				bootId: null,
				processStartId: null,
			}),
		).toBe(true);
	});

	it("is false for this live process when the record is older than the stale bound", () => {
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now() - 60_000,
				bootId: null,
				processStartId: null,
			}),
		).toBe(false);
	});

	it("is false when a recorded process-start id contradicts the live process", () => {
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now(),
				bootId: null,
				processStartId: "definitely-not-this-process",
			}),
		).toBe(false);
	});

	it("trusts a matching process-start id over the staleness bound", () => {
		const live = readFileMutationProcessIdentity(process.pid, Date.now());
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now() - 3_600_000,
				bootId: null,
				processStartId: live.processStartId,
			}),
		).toBe(true);
	});

	it("accepts an hour-old record whose boot id also matches the live boot", () => {
		const live = readFileMutationProcessIdentity(process.pid, Date.now());
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now() - 3_600_000,
				bootId: live.bootId,
				processStartId: live.processStartId,
			}),
		).toBe(true);
	});

	it("rejects a record from another boot even when the start id and PID match", () => {
		const live = readFileMutationProcessIdentity(process.pid, Date.now());
		expect(
			liveClaimLockIsCurrent({
				pid: process.pid,
				createdAtMs: Date.now(),
				bootId: "linux:a-boot-this-machine-never-had",
				processStartId: live.processStartId,
			}),
		).toBe(false);
	});
});

describe("claimLockIsCurrent / removeCurrentClaimLock", () => {
	it("holds only while the canonical path carries our exact bytes", () => {
		const lock = makeClaimLock(tempPidPath());
		expect(claimLockIsCurrent(lock)).toBe(false);
		writeFileSync(lock.path, lock.raw);
		expect(claimLockIsCurrent(lock)).toBe(true);
		writeFileSync(lock.path, "someone else\n");
		expect(claimLockIsCurrent(lock)).toBe(false);
	});

	it("removes our own lock and leaves a displaced one alone", () => {
		const lock = makeClaimLock(tempPidPath());
		writeFileSync(lock.path, lock.raw);
		removeCurrentClaimLock(lock);
		expect(existsSync(lock.path)).toBe(false);

		writeFileSync(lock.path, "another claimant\n");
		removeCurrentClaimLock(lock);
		expect(readFileSync(lock.path, "utf-8")).toBe("another claimant\n");
	});
});

describe("recoverStaleClaimLock", () => {
	it("takes over a stale lock and leaves no quarantine file behind", () => {
		const lock = makeClaimLock(tempPidPath());
		const stale = "stale-record\n";
		writeFileSync(lock.path, stale);
		const result = recoverStaleClaimLock(lock, stale);
		expect(result).toEqual({ lock });
		expect(readFileSync(lock.path, "utf-8")).toBe(lock.raw);
		expect(existsSync(`${lock.path}.${lock.token}.stale`)).toBe(false);
	});

	it("asks for a retry when the lock vanished before the rename", () => {
		const lock = makeClaimLock(tempPidPath());
		expect(recoverStaleClaimLock(lock, "whatever")).toEqual({ retry: true });
	});

	it("restores the record and retries when the observed bytes changed under us", () => {
		const lock = makeClaimLock(tempPidPath());
		writeFileSync(lock.path, "actual-bytes\n");
		// The caller observed different bytes, so the record it judged stale is
		// not the one on disk — the recovery must put it back untouched.
		expect(recoverStaleClaimLock(lock, "bytes-the-caller-saw\n")).toEqual({ retry: true });
		expect(readFileSync(lock.path, "utf-8")).toBe("actual-bytes\n");
	});

	it("propagates a rename failure that is not ENOENT and leaves the record alone", () => {
		const lock = makeClaimLock(tempPidPath());
		const stale = "stale-record\n";
		writeFileSync(lock.path, stale);
		// A directory parked on the quarantine path fails the rename with EISDIR,
		// which is not the ENOENT the "someone else already took it" arm expects.
		mkdirSync(`${lock.path}.${lock.token}.stale`);
		expect(() => recoverStaleClaimLock(lock, stale)).toThrow(/^EISDIR:/);
		expect(readFileSync(lock.path, "utf-8")).toBe(stale);
	});

	it("yields to a claimant that filled the rename gap and drops the quarantine copy", () => {
		const lock = makeClaimLock(tempPidPath());
		const other = "other-claimant\n";
		writeFileSync(lock.path, other);
		const quarantinePath = `${lock.path}.${lock.token}.stale`;
		// A hard-link twin makes the rename a POSIX no-op, so the canonical path
		// is still occupied when the exclusive create runs — the same state a
		// claimant that filled the rename gap leaves behind.
		linkSync(lock.path, quarantinePath);
		expect(recoverStaleClaimLock(lock, other)).toEqual({ retry: true });
		expect(readFileSync(lock.path, "utf-8")).toBe(other);
		expect(existsSync(quarantinePath)).toBe(false);
	});

	it("keeps the quarantined record when the replacement write fails", () => {
		const lock = makeClaimLock(tempPidPath());
		const stale = "stale-record\n";
		writeFileSync(lock.path, stale);
		const quarantinePath = `${lock.path}.${lock.token}.stale`;
		vi.mocked(writeFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("claim write failed"), { code: "EIO" });
		});
		expect(() => recoverStaleClaimLock(lock, stale)).toThrow("claim write failed");
		expect(readFileSync(quarantinePath, "utf-8")).toBe(stale);
		expect(existsSync(lock.path)).toBe(false);
	});
});
