// ===========================================
// Cross-process serialization for append-only files
// ===========================================
// Append writers and the rare pathname-replacing maintenance commands share
// this lock. The critical sections stay deliberately small: one append, or one
// bounded suffix copy + rename. A writer never falls through and writes around
// contention; timeout is an explicit failure the caller must handle.

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	type FileMutationProcessIdentity,
	readFileMutationProcessIdentity,
} from "./file-mutation-lock-identity.js";
import { isJsonObject } from "./json-types.js";

const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_RETRY_MS = 5;
const DEFAULT_STALE_MS = 10 * 60_000;
const LEGACY_IDENTITY_SKEW_MS = 2_000;
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface LockOwner {
	pid: number;
	token: string;
	acquired_at_ms: number;
	boot_id?: string;
	process_start_id?: string;
}

interface FileMutationLockOptions {
	waitMs?: number;
	retryMs?: number;
	staleMs?: number;
	clock?: () => number;
	tokenFactory?: () => string;
	/** Test seam for the stale-observation race; production leaves absent. */
	beforeRetireObserved?: () => void;
	/** Test seam for process identity failures; production uses OS identity. */
	identityProvider?: (pid: number) => FileMutationProcessIdentity;
}

interface FileMutationLease {
	lockPath: string;
	ownerPath: string;
	owner: LockOwner;
}

interface LockObservation {
	entries: string[];
	legacy: boolean;
	owner: LockOwner | null;
	ownerPath: string | null;
}

export class FileMutationLockTimeoutError extends Error {
	constructor(readonly lockPath: string, options?: ErrorOptions) {
		super(`timed out waiting for append/rotation lock ${lockPath}`, options);
		this.name = "FileMutationLockTimeoutError";
	}
}

export function fileMutationLockPath(path: string): string {
	return `${path}.interlinked-mutation.lock`;
}

function validToken(token: string): boolean {
	return /^[a-zA-Z0-9._-]{1,128}$/.test(token);
}

export function fileMutationLockOwnerPath(path: string, token: string): string {
	if (!validToken(token)) throw new TypeError("file-mutation lock token is not path-safe");
	return join(fileMutationLockPath(path), `owner-${token}.json`);
}

function parseOwnerIdentity(
	value: Record<string, unknown>,
): Pick<LockOwner, "boot_id" | "process_start_id"> | null {
	const identity: Pick<LockOwner, "boot_id" | "process_start_id"> = {};
	for (const key of ["boot_id", "process_start_id"] as const) {
		if (!(key in value)) continue;
		const field = value[key];
		if (typeof field !== "string" || field.length === 0) return null;
		identity[key] = field;
	}
	return identity;
}

function parseOwner(value: unknown): LockOwner | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
	if (typeof value.token !== "string" || !validToken(value.token)) return null;
	if (
		typeof value.acquired_at_ms !== "number" ||
		!Number.isFinite(value.acquired_at_ms) ||
		value.acquired_at_ms <= 0
	) return null;
	const identity = parseOwnerIdentity(value);
	if (!identity) return null;
	return {
		pid: value.pid,
		token: value.token,
		acquired_at_ms: value.acquired_at_ms,
		...identity,
	};
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function readOwner(ownerPath: string): LockOwner | null {
	try {
		return parseOwner(JSON.parse(readFileSync(ownerPath, "utf8")));
	} catch {
		return null;
	}
}

function observeLock(path: string, lockPath: string): LockObservation | null {
	let entries: string[];
	try {
		entries = readdirSync(lockPath).sort();
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		if (errorCode(error) === "ENOTDIR") {
			return { entries: [], legacy: true, owner: readOwner(lockPath), ownerPath: lockPath };
		}
		return { entries: [], legacy: false, owner: null, ownerPath: null };
	}
	if (entries.length !== 1) return { entries, legacy: false, owner: null, ownerPath: null };
	const entry = entries[0];
	if (!entry?.startsWith("owner-") || !entry.endsWith(".json")) {
		return { entries, legacy: false, owner: null, ownerPath: null };
	}
	const ownerPath = join(lockPath, entry);
	const owner = readOwner(ownerPath);
	const tokenFromName = entry.slice("owner-".length, -".json".length);
	if (!owner || owner.token !== tokenFromName) {
		return { entries, legacy: false, owner: null, ownerPath: null };
	}
	if (fileMutationLockOwnerPath(path, owner.token) !== ownerPath) {
		return { entries, legacy: false, owner: null, ownerPath: null };
	}
	return { entries, legacy: false, owner, ownerPath };
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function observedIdentity(
	provider: (pid: number) => FileMutationProcessIdentity,
	pid: number,
): FileMutationProcessIdentity {
	try {
		return provider(pid);
	} catch {
		return {
			bootId: null,
			bootStartedAtMs: null,
			processStartId: null,
			processStartedAtMs: null,
		};
	}
}

function ownerIdentityIsStale(
	owner: LockOwner,
	identity: FileMutationProcessIdentity,
): boolean {
	if (owner.boot_id && identity.bootId && owner.boot_id !== identity.bootId) return true;
	if (
		owner.process_start_id &&
		identity.processStartId &&
		owner.process_start_id !== identity.processStartId
	) return true;
	// Only the complete matching tuple is definitive. A transient probe failure
	// can publish a boot-only or start-only owner; after PID reuse that partial
	// record still needs the conservative process/boot epoch fallback below.
	if (owner.boot_id && owner.process_start_id) return false;
	if (
		identity.bootStartedAtMs !== null &&
		owner.acquired_at_ms + LEGACY_IDENTITY_SKEW_MS < identity.bootStartedAtMs
	) return true;
	return (
		identity.processStartedAtMs !== null &&
		owner.acquired_at_ms + LEGACY_IDENTITY_SKEW_MS < identity.processStartedAtMs
	);
}

function ownerIsAbandoned(
	owner: LockOwner,
	identityProvider: (pid: number) => FileMutationProcessIdentity,
): boolean {
	if (!processIsAlive(owner.pid)) return true;
	return ownerIdentityIsStale(owner, observedIdentity(identityProvider, owner.pid));
}

function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
	return (
		left !== null &&
		right !== null &&
		left.pid === right.pid &&
		left.token === right.token &&
		left.acquired_at_ms === right.acquired_at_ms &&
		left.boot_id === right.boot_id &&
		left.process_start_id === right.process_start_id
	);
}

function lockAgeMs(lockPath: string, observation: LockObservation, now: number): number {
	if (observation.owner) return Math.max(0, now - observation.owner.acquired_at_ms);
	try {
		return Math.max(0, now - statSync(lockPath).mtimeMs);
	} catch {
		return 0;
	}
}

function unlinkObservedEntries(lockPath: string, observation: LockObservation): boolean {
	const first = observation.ownerPath ?? observation.entries[0];
	if (!first) return true;
	const firstPath = observation.ownerPath ?? join(lockPath, first);
	if (observation.owner && !sameOwner(readOwner(firstPath), observation.owner)) return false;
	try {
		unlinkSync(firstPath);
	} catch {
		// Another recoverer retired the observed token. It owns recovery; never
		// continue on to a successor lock directory.
		return false;
	}
	for (const entry of observation.entries) {
		const entryPath = join(lockPath, entry);
		if (entryPath === firstPath) continue;
		try {
			unlinkSync(entryPath);
		} catch {
			return false;
		}
	}
	return true;
}

function removeEmptyLockDirectory(lockPath: string): boolean {
	try {
		rmdirSync(lockPath);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return true;
		// ENOTEMPTY means a new token appeared. Do not touch it.
		return false;
	}
}

function removeObservedLock(lockPath: string, observation: LockObservation): boolean {
	if (!unlinkObservedEntries(lockPath, observation)) return false;
	// A rolling-upgrade legacy lock is the file at lockPath itself. Once that
	// exact file is gone, never rmdir the path: it may now be a successor dir.
	if (observation.legacy) return true;
	return removeEmptyLockDirectory(lockPath);
}

/** Recover a lock only when its owner is dead, or its record is malformed and
 * old enough that it cannot still be in the atomic publication syscall. A
 * valid live owner is never reaped merely because a waiter is impatient. */
interface RecoverLockOptions {
	path: string;
	lockPath: string;
	staleMs: number;
	now: number;
	identityProvider: (pid: number) => FileMutationProcessIdentity;
	beforeRetireObserved?: () => void;
}

function recoverAbandonedLock(options: RecoverLockOptions): boolean {
	const observation = observeLock(options.path, options.lockPath);
	if (!observation) return true;
	const abandonedOwner =
		observation.owner !== null && ownerIsAbandoned(observation.owner, options.identityProvider);
	const malformedAndStale =
		observation.owner === null &&
		lockAgeMs(options.lockPath, observation, options.now) >= options.staleMs;
	if (!abandonedOwner && !malformedAndStale) return false;
	options.beforeRetireObserved?.();
	return removeObservedLock(options.lockPath, observation);
}

function sleep(ms: number): void {
	Atomics.wait(SLEEP_WORD, 0, 0, Math.max(1, ms));
}

function releaseOwnedLock(lease: FileMutationLease): void {
	if (!sameOwner(readOwner(lease.ownerPath), lease.owner)) return;
	try {
		unlinkSync(lease.ownerPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	removeEmptyLockDirectory(lease.lockPath);
}

function tryCreateLease(
	path: string,
	lockPath: string,
	owner: LockOwner,
): FileMutationLease | null {
	try {
		mkdirSync(lockPath);
	} catch (error) {
		if (errorCode(error) === "EEXIST") return null;
		throw error;
	}
	const ownerPath = fileMutationLockOwnerPath(path, owner.token);
	try {
		writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx" });
		return { lockPath, ownerPath, owner };
	} catch (error) {
		removeEmptyLockDirectory(lockPath);
		// A stale recoverer can retire the empty directory between mkdir and the
		// owner write. The caller retries; it never enters without a durable owner.
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

function acquireFileMutationLock(
	path: string,
	options: FileMutationLockOptions,
): FileMutationLease {
	const lockPath = fileMutationLockPath(path);
	const waitMs = Math.max(0, options.waitMs ?? DEFAULT_WAIT_MS);
	const retryMs = Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS);
	const staleMs = Math.max(1, options.staleMs ?? DEFAULT_STALE_MS);
	const clock = options.clock ?? Date.now;
	const startedAt = clock();
	const token = (options.tokenFactory ?? randomUUID)();
	if (!validToken(token)) throw new TypeError("file-mutation lock token is not path-safe");
	const identityProvider =
		options.identityProvider ?? ((pid: number) => readFileMutationProcessIdentity(pid, clock()));
	const identity = observedIdentity(identityProvider, process.pid);
	const owner: LockOwner = {
		pid: process.pid,
		token,
		acquired_at_ms: startedAt,
		...(identity.bootId ? { boot_id: identity.bootId } : {}),
		...(identity.processStartId ? { process_start_id: identity.processStartId } : {}),
	};

	while (true) {
		const lease = tryCreateLease(path, lockPath, owner);
		if (lease) return lease;
		if (
			recoverAbandonedLock({
				path,
				lockPath,
				staleMs,
				now: clock(),
				identityProvider,
				...(options.beforeRetireObserved
					? { beforeRetireObserved: options.beforeRetireObserved }
					: {}),
			})
		) continue;
		if (clock() - startedAt >= waitMs) {
			throw new FileMutationLockTimeoutError(lockPath);
		}
		sleep(retryMs);
	}
}

/** Run one synchronous critical section under an exclusive cross-process
 * lock. The on-disk PID/token makes ownership auditable and prevents a process
 * from releasing a successor's lock. */
export function withFileMutationLock<T>(
	path: string,
	action: () => T,
	options: FileMutationLockOptions = {},
): T {
	const lease = acquireFileMutationLock(path, options);
	try {
		return action();
	} finally {
		releaseOwnedLock(lease);
	}
}

/** Append while participating in pathname replacement. Contention never
 * degrades to an unlocked append. */
export function appendFileWithMutationLock(
	path: string,
	data: string | Uint8Array,
	options: FileMutationLockOptions = {},
): void {
	withFileMutationLock(path, () => appendFileSync(path, data), options);
}
