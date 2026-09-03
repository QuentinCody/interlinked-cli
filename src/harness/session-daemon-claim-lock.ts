// ===========================================
// Session daemon — claim-lock record
// ===========================================
// Extracted from `session-daemon.ts` (per-file line cap). Pure relocation: the
// companion `<pidPath>.claim` record — how it is minted, parsed, validated,
// judged live-or-stale, and recovered when a dead claimant left it behind.
// `session-daemon.ts` keeps the claim ALGORITHM (acquire → claim → release);
// this module owns the bytes it fences with.

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
	type FileMutationProcessIdentity,
	readFileMutationProcessIdentity,
} from "../lib/file-mutation-lock-identity.js";

export interface SessionClaimLock {
	path: string;
	raw: string;
	token: string;
}

export interface ClaimLockRecord {
	pid: number;
	createdAtMs: number;
	bootId: string | null;
	processStartId: string | null;
}

type Retry = { retry: true };
export type ClaimLockAttempt = { lock: SessionClaimLock } | Retry;

const CLAIM_LOCK_STALE_MS = 5_000;
let claimTokenSequence = 0;

export function makeClaimLock(pidPath: string): SessionClaimLock {
	const createdAtMs = Date.now();
	const token = `${process.pid}-${createdAtMs}-${process.hrtime.bigint()}-${++claimTokenSequence}`;
	const identity = readFileMutationProcessIdentity(process.pid, createdAtMs);
	return {
		path: `${pidPath}.claim`,
		raw: `${JSON.stringify({
			pid: process.pid,
			token,
			created_at_ms: createdAtMs,
			boot_id: identity.bootId,
			process_start_id: identity.processStartId,
		})}\n`,
		token,
	};
}

export function readFileText(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function claimLockIdentity(value: Record<string, unknown>): {
	bootId: string | null;
	processStartId: string | null;
} | null {
	const { boot_id: bootId, process_start_id: processStartId } = value;
	if (bootId !== null && typeof bootId !== "string") return null;
	if (processStartId !== null && typeof processStartId !== "string") return null;
	return { bootId, processStartId };
}

export function claimLockRecord(raw: string | null): ClaimLockRecord | null {
	if (raw === null) return null;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isUnknownRecord(value)) return null;
		const { pid, token, created_at_ms: createdAtMs } = value;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
		if (typeof token !== "string" || token === "") return null;
		if (typeof createdAtMs !== "number" || !Number.isSafeInteger(createdAtMs)) return null;
		const identity = claimLockIdentity(value);
		return identity === null ? null : { pid, createdAtMs, ...identity };
	} catch {
		return null;
	}
}

function matchingKnownIdentity(
	record: ClaimLockRecord,
	current: FileMutationProcessIdentity,
): boolean | null {
	if (record.processStartId === null || current.processStartId === null) return null;
	if (record.processStartId !== current.processStartId) return false;
	if (record.bootId === null || current.bootId === null) return true;
	return record.bootId === current.bootId;
}

export function liveClaimLockIsCurrent(record: ClaimLockRecord | null): boolean {
	if (record === null || !isProcessAlive(record.pid)) return false;
	const identityMatch = matchingKnownIdentity(
		record,
		readFileMutationProcessIdentity(record.pid, Date.now()),
	);
	if (identityMatch !== null) return identityMatch;
	const ageMs = Date.now() - record.createdAtMs;
	return ageMs >= 0 && ageMs <= CLAIM_LOCK_STALE_MS;
}

export function claimLockIsCurrent(lock: SessionClaimLock): boolean {
	return readFileText(lock.path) === lock.raw;
}

export function removeCurrentClaimLock(lock: SessionClaimLock): void {
	if (claimLockIsCurrent(lock)) rmSync(lock.path, { force: true });
}

function restoreRacedClaimLock(lock: SessionClaimLock, quarantinePath: string): ClaimLockAttempt {
	try {
		// The canonical path contains our recovery marker, so replacing it with
		// the record we accidentally moved cannot stomp another cooperative
		// claimant. A failure preserves the quarantine bytes and is loud.
		renameSync(quarantinePath, lock.path);
		return { retry: true };
	} catch (err) {
		removeCurrentClaimLock(lock);
		throw err;
	}
}

export function recoverStaleClaimLock(
	lock: SessionClaimLock,
	observedRaw: string | null,
): ClaimLockAttempt {
	const quarantinePath = `${lock.path}.${lock.token}.stale`;
	try {
		renameSync(lock.path, quarantinePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { retry: true };
		throw err;
	}

	const movedRaw = readFileText(quarantinePath);
	try {
		writeFileSync(lock.path, lock.raw, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			// Another claimant filled the rename gap. The moved token is fenced:
			// its holder verifies the canonical token before and after any PID
			// mutation, so it cannot report ownership after losing this path.
			rmSync(quarantinePath, { force: true });
			return { retry: true };
		}
		// Do not erase the only copy of the moved record on an I/O failure.
		throw err;
	}

	if (movedRaw !== observedRaw) return restoreRacedClaimLock(lock, quarantinePath);
	rmSync(quarantinePath, { force: true });
	return { lock };
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
