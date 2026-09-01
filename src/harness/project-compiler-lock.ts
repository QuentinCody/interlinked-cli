// ===========================================
// Cross-process project compiler lease
// ===========================================
// Atomic lock directories serialize compiler processes across independent
// daemons and CLI processes. The owner PID makes a crash-released lock
// recoverable; the process-start identity distinguishes PID reuse, and the
// random token prevents a stale releaser deleting a newer owner's lease.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	FileMutationLockTimeoutError,
	withFileMutationLock,
} from "../lib/file-mutation-lock.js";

const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const LOCK_POLL_MS = 25;
const LOCK_ROOT = join(tmpdir(), "interlinked-project-compiler-leases-v1");
/** Backstop for legacy/uninspectable owners. All workloads using this shared
 * lease have bounded minute-scale timeouts; a full day is deliberately much
 * longer, while still preventing a recycled live PID from starving the lane
 * forever when stable process identity cannot be recovered. */
export const PROJECT_LEASE_HARD_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface CrossProcessCompilerLease {
	release: () => void;
}

interface CrossProcessCompilerLeaseOptions {
	/** Test seam for the observe-then-retire race. Production leaves absent. */
	beforeRetireObserved?: () => void;
}

interface LockOwner {
	pid: number;
	token: string;
	project: string;
	createdAt: string;
	/** OS-derived process start identity. Missing is accepted for v1 lockfile
	 * compatibility and falls back to the hard maximum age. */
	processIdentity?: string;
}

function optionalProcessIdentity(record: Record<string, unknown>): string | null | undefined {
	if (!("processIdentity" in record)) return undefined;
	return typeof record.processIdentity === "string" && record.processIdentity.length > 0
		? record.processIdentity
		: null;
}

export function canonicalProjectRoot(projectRoot: string): string {
	const absolute = resolve(projectRoot);
	try {
		return realpathSync.native(absolute);
	} catch {
		return absolute;
	}
}

function lockPath(projectKey: string): string {
	const digest = createHash("sha256").update(projectKey).digest("hex");
	return join(LOCK_ROOT, `${digest}.lock`);
}

function parseLockOwner(raw: string): LockOwner | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		// SAFETY: the object guard above permits field inspection; every returned
		// field is validated independently before the value crosses this boundary.
		const record = value as Record<string, unknown>;
		if (!Number.isSafeInteger(record.pid) || typeof record.pid !== "number" || record.pid <= 0) {
			return null;
		}
		if (typeof record.token !== "string" || record.token.length === 0) return null;
		if (typeof record.project !== "string" || record.project.length === 0) return null;
		if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
			return null;
		}
		const processIdentity = optionalProcessIdentity(record);
		if (processIdentity === null) return null;
		const owner: LockOwner = {
			pid: record.pid,
			token: record.token,
			project: record.project,
			createdAt: record.createdAt,
		};
		if (processIdentity !== undefined) owner.processIdentity = processIdentity;
		return owner;
	} catch {
		return null;
	}
}

function linuxProcessIdentity(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd < 0) return null;
		// Fields after the command begin at proc(5)'s field 3. Start time is
		// field 22, therefore index 19 in this suffix. Include the boot id because
		// start ticks repeat after a reboot while /tmp may survive in some hosts.
		const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fields[19];
		if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null;
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
		if (bootId.length === 0) return null;
		return `linux:${bootId}:${startTicks}`;
	} catch {
		return null;
	}
}

function psProcessIdentity(pid: number): string | null {
	try {
		const started = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1_000,
		}).trim();
		return started.length > 0 ? `ps:${started}` : null;
	} catch {
		return null;
	}
}

function processIdentity(pid: number): string | null {
	return process.platform === "linux" ? linuxProcessIdentity(pid) : psProcessIdentity(pid);
}

const OWN_PROCESS_IDENTITY = processIdentity(process.pid);

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockAgeMs(path: string): number {
	try {
		return Math.max(0, Date.now() - statSync(path).mtimeMs);
	} catch {
		return 0;
	}
}

function ownerAgeMs(path: string, owner: LockOwner): number {
	return Math.max(lockAgeMs(path), Math.max(0, Date.now() - Date.parse(owner.createdAt)));
}

interface LockOwnerObservation {
	raw: string | null;
	owner: LockOwner | null;
	mtimeMs: number | null;
}

function observeLockOwner(path: string): LockOwnerObservation {
	let raw: string | null = null;
	try {
		raw = readFileSync(join(path, "owner.json"), "utf-8");
	} catch {
		/* missing or unreadable owner stays null */
	}
	let mtimeMs: number | null = null;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		/* a concurrently retired path is not the observed lock */
	}
	return { raw, owner: raw === null ? null : parseLockOwner(raw), mtimeMs };
}

function sameLockObservation(
	left: LockOwnerObservation,
	right: LockOwnerObservation,
): boolean {
	return left.raw === right.raw && left.mtimeMs === right.mtimeMs;
}

function liveOwnerStillOwns(path: string, owner: LockOwner): boolean {
	if (ownerAgeMs(path, owner) >= PROJECT_LEASE_HARD_MAX_AGE_MS) return false;
	if (owner.processIdentity === undefined) return true;
	const currentIdentity = processIdentity(owner.pid);
	return currentIdentity === null || currentIdentity === owner.processIdentity;
}

function moveAsideStaleLock(path: string): boolean {
	const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(path, stalePath);
		rmSync(stalePath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function reclaimStaleLock(
	path: string,
	options: CrossProcessCompilerLeaseOptions,
): boolean {
	const observation = observeLockOwner(path);
	const { owner } = observation;
	// mkdir and owner.json publication are two operations. A concurrent reader
	// can observe either a missing file or temporarily incomplete metadata. Do
	// not steal either form of a freshly-created lock from its live initializer.
	if (!owner && lockAgeMs(path) < LOCK_INITIALIZATION_GRACE_MS) return false;
	if (owner && processIsAlive(owner.pid) && liveOwnerStillOwns(path, owner)) return false;
	options.beforeRetireObserved?.();
	// Staleness was decided from a snapshot. Re-read immediately before the
	// rename so an external writer that replaced the observed owner is never
	// retired as though it were the stale predecessor.
	if (!sameLockObservation(observation, observeLockOwner(path))) return false;
	return moveAsideStaleLock(path);
}

function makeRelease(path: string, token: string): () => void {
	let released = false;
	const release = (): void => {
		if (released) return;
		try {
			const completed = withFileMutationLock(
				path,
				() => {
					const current = parseLockOwner(readFileSync(join(path, "owner.json"), "utf-8"));
					if (current?.token !== token || current.pid !== process.pid) return true;
					const releasePath = `${path}.release-${process.pid}-${token}`;
					renameSync(path, releasePath);
					rmSync(releasePath, { recursive: true, force: true });
					return true;
				},
				{ waitMs: 2_000 },
			);
			released = completed;
		} catch {
			// A transient mutation-fence failure leaves `released` false so the
			// idempotent callback may be retried. Never remove a lock whose token
			// could not be verified as ours.
			void 0;
		}
	};
	return release;
}

function createLease(projectKey: string, path: string): CrossProcessCompilerLease {
	const token = randomUUID();
	mkdirSync(path);
	const owner: LockOwner = {
		pid: process.pid,
		token,
		project: projectKey,
		createdAt: new Date().toISOString(),
	};
	if (OWN_PROCESS_IDENTITY !== null) owner.processIdentity = OWN_PROCESS_IDENTITY;
	try {
		writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx" });
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
	const release = makeRelease(path, token);
	return { release };
}

/** Attempt once (plus one stale-owner recovery) without waiting. */
export function tryAcquireCrossProcessCompilerLease(
	projectKey: string,
	options: CrossProcessCompilerLeaseOptions = {},
): CrossProcessCompilerLease | null {
	mkdirSync(LOCK_ROOT, { recursive: true });
	const path = lockPath(projectKey);
	try {
		return withFileMutationLock(
			path,
			() => {
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						return createLease(projectKey, path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						if (!reclaimStaleLock(path, options)) return null;
					}
				}
				return null;
			},
			// This public primitive is deliberately nonqueueing. The async caller
			// retries until its own deadline; synchronous PostTool work defers.
			{ waitMs: 0 },
		);
	} catch (error) {
		if (error instanceof FileMutationLockTimeoutError) return null;
		throw error;
		}
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolveWait, rejectWait) => {
		const finish = (): void => {
			signal?.removeEventListener("abort", onAbort);
			resolveWait();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			rejectWait(new Error("compiler admission aborted"));
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Wait boundedly for another process's project lease to clear. */
export async function acquireCrossProcessCompilerLease(
	projectKey: string,
	deadline: number,
	signal?: AbortSignal,
): Promise<CrossProcessCompilerLease | null> {
	while (!signal?.aborted) {
		const lease = tryAcquireCrossProcessCompilerLease(projectKey);
		if (lease) return lease;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return null;
		await waitForRetry(Math.min(LOCK_POLL_MS, remaining), signal);
	}
	return null;
}
