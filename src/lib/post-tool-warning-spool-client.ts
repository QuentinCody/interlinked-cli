import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

export const QUALITY_WARNING_SPOOL_DIR = "quality-warning-spool";
const LEGACY_PENDING_WARNINGS_FILE = "pending-quality-warnings.json";
const DRAIN_LOCK_FILE = ".drain.lock";
const READY_TTL_MS = 24 * 60 * 60 * 1000;
const READY_GRACE_MS = 250;
const DRAIN_LOCK_TTL_MS = 75 * 1000;

interface QualityWarningRecord {
	version: 1;
	token: string;
	session_id: string;
	produced_at: string;
	warnings: string[];
}

interface QualityWarningActiveRecord {
	version: 1;
	token: string;
	session_id: string;
	started_at: string | null;
	client_pid: number | null;
}

function validDeliveryToken(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

function parseRecord(raw: string): QualityWarningRecord | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (record.version !== 1 || !validDeliveryToken(record.token)) return null;
		if (typeof record.session_id !== "string" || typeof record.produced_at !== "string") {
			return null;
		}
		if (
			!Array.isArray(record.warnings) ||
			record.warnings.length === 0 ||
			!record.warnings.every((warning) => typeof warning === "string")
		) {
			return null;
		}
		return {
			version: 1,
			token: record.token,
			session_id: record.session_id,
			produced_at: record.produced_at,
			warnings: record.warnings,
		};
	} catch {
		return null;
	}
}

function parseActiveRecord(raw: string): QualityWarningActiveRecord | null {
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
		const record = value as Record<string, unknown>;
		if (record.version !== 1 || !validDeliveryToken(record.token)) return null;
		if (typeof record.session_id !== "string") return null;
		const clientPid =
			typeof record.client_pid === "number" &&
			Number.isSafeInteger(record.client_pid) &&
			record.client_pid > 0
				? record.client_pid
				: null;
		return {
			version: 1,
			token: record.token,
			session_id: record.session_id,
			started_at: typeof record.started_at === "string" ? record.started_at : null,
			client_pid: clientPid,
		};
	} catch {
		return null;
	}
}

function spoolDir(dataDir: string): string {
	return join(dataDir, QUALITY_WARNING_SPOOL_DIR);
}

function spoolFiles(dataDir: string, suffix: string): string[] {
	const dir = spoolDir(dataDir);
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => name.endsWith(suffix))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

function claim(path: string): string | null {
	const claimed = `${path}.claim-${process.pid}-${randomUUID()}`;
	try {
		renameSync(path, claimed);
		return claimed;
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

function acquireDrainLease(dataDir: string): string | null {
	const dir = spoolDir(dataDir);
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	} catch {
		return null;
	}
	const lockPath = join(dir, DRAIN_LOCK_FILE);
	for (let attempt = 0; attempt < 2; attempt++) {
		const ownerToken = `${process.pid}-${randomUUID()}`;
		try {
			writeFileSync(
				lockPath,
				JSON.stringify({ pid: process.pid, at: Date.now(), owner_token: ownerToken }),
				{ encoding: "utf-8", flag: "wx", mode: 0o600 },
			);
			return ownerToken;
		} catch {
			// Inspect the existing holder below.
		}

		let stale = false;
		try {
			const holder: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
			if (holder !== null && typeof holder === "object" && !Array.isArray(holder)) {
				const row = holder as Record<string, unknown>;
				stale =
					typeof row.pid === "number" &&
					typeof row.at === "number" &&
					!processAlive(row.pid) &&
					Date.now() - row.at > 1000;
			} else {
				stale = Date.now() - statSync(lockPath).mtimeMs > DRAIN_LOCK_TTL_MS;
			}
		} catch {
			try {
				stale = Date.now() - statSync(lockPath).mtimeMs > DRAIN_LOCK_TTL_MS;
			} catch {
				return null;
			}
		}
		if (!stale) return null;

		const staleClaim = `${lockPath}.stale-${randomUUID()}`;
		try {
			renameSync(lockPath, staleClaim);
			try {
				unlinkSync(staleClaim);
			} catch {
				// Best-effort stale-lock cleanup.
			}
		} catch {
			return null;
		}
	}
	return null;
}

function releaseDrainLease(dataDir: string, ownerToken: string): void {
	const lockPath = join(spoolDir(dataDir), DRAIN_LOCK_FILE);
	try {
		const holder: unknown = JSON.parse(readFileSync(lockPath, "utf-8"));
		if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return;
		const row = holder as Record<string, unknown>;
		if (row.owner_token !== ownerToken || row.pid !== process.pid) return;
		const claimed = `${lockPath}.release-${ownerToken}`;
		renameSync(lockPath, claimed);
		try {
			unlinkSync(claimed);
		} catch {
			// Best-effort release cleanup.
		}
	} catch {
		// Another owner or an already-released lease.
	}
}

function consumeLegacyWarnings(dataDir: string): string[] {
	const claimed = claim(join(dataDir, LEGACY_PENDING_WARNINGS_FILE));
	if (!claimed) return [];
	try {
		const value: unknown = JSON.parse(readFileSync(claimed, "utf-8"));
		return Array.isArray(value)
			? value.filter((warning): warning is string => typeof warning === "string")
			: [];
	} catch {
		return [];
	} finally {
		try {
			unlinkSync(claimed);
		} catch {
			// Best-effort migration cleanup.
		}
	}
}

function removeTokenFile(dataDir: string, token: string, suffix: string): void {
	const claimed = claim(join(spoolDir(dataDir), `${token}.${suffix}.json`));
	if (!claimed) return;
	try {
		unlinkSync(claimed);
	} catch {
		// Best-effort acknowledgement/claim cleanup.
	}
}

function tokenFromReadyPath(path: string): string | null {
	const suffix = ".ready.json";
	const name = basename(path);
	if (!name.endsWith(suffix)) return null;
	const token = name.slice(0, -suffix.length);
	return validDeliveryToken(token) ? token : null;
}

function activeRecordAgeMs(
	path: string,
	record: QualityWarningActiveRecord | null,
	nowMs: number,
): number {
	const startedMs = record?.started_at ? Date.parse(record.started_at) : Number.NaN;
	if (Number.isFinite(startedMs)) return nowMs - startedMs;
	try {
		return nowMs - statSync(path).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function staleActiveRecord(
	path: string,
	record: QualityWarningActiveRecord | null,
	nowMs: number,
): boolean {
	const ageMs = activeRecordAgeMs(path, record, nowMs);
	if (ageMs < -READY_GRACE_MS || ageMs > READY_TTL_MS) return true;
	if (ageMs < READY_GRACE_MS) return false;
	if (!record || record.client_pid === null) return true;
	return !processAlive(record.client_pid);
}

/** Remove abandoned request markers without touching a live hook's marker. */
function sweepStaleActiveRecords(paths: readonly string[], nowMs: number): void {
	for (const path of paths) {
		let record: QualityWarningActiveRecord | null = null;
		try {
			record = parseActiveRecord(readFileSync(path, "utf-8"));
		} catch {
			// A missing or unreadable record is handled by the stale decision below.
		}
		if (!staleActiveRecord(path, record, nowMs)) continue;
		const claimed = claim(path);
		if (!claimed) continue;
		try {
			unlinkSync(claimed);
		} catch {
			// Best-effort cleanup of an abandoned marker.
		}
	}
}

function activeRequestOwnsDelivery(
	paths: readonly string[],
	sessionId: string,
	nowMs: number,
): boolean {
	return paths.some((path) => {
		try {
			const record = parseActiveRecord(readFileSync(path, "utf-8"));
			if (!record || record.session_id !== sessionId) return false;
			const ageMs = activeRecordAgeMs(path, record, nowMs);
			if (ageMs > READY_TTL_MS || ageMs < -READY_GRACE_MS) return false;
			if (record.client_pid !== null) return processAlive(record.client_pid);
			return ageMs < READY_GRACE_MS;
		} catch {
			return false;
		}
	});
}

function hasYoungReadyRecord(
	paths: readonly string[],
	sessionId: string,
	nowMs: number,
): boolean {
	return paths.some((path) => {
		try {
			const record = parseRecord(readFileSync(path, "utf-8"));
			if (!record || record.session_id !== sessionId) return false;
			const ageMs = nowMs - Date.parse(record.produced_at);
			return Number.isFinite(ageMs) && ageMs >= -READY_GRACE_MS && ageMs < READY_GRACE_MS;
		} catch {
			return false;
		}
	});
}

function consumeReadyRecords(
	dataDir: string,
	paths: readonly string[],
	sessionId: string,
	nowMs: number,
	warnings: Set<string>,
): void {
	for (const path of paths) {
		const read = readReadyRecord(path, nowMs);
		if (skipReadyRecord(read, sessionId)) continue;

		const claimed = claim(path);
		if (!claimed) continue;
		absorbClaimedReadyRecord(claimed, read.stale, sessionId, warnings);
		const claimedToken = read.record?.token ?? tokenFromReadyPath(path);
		if (claimedToken) removeTokenFile(dataDir, claimedToken, "active");
	}
}

interface ReadyRecordRead {
	record: QualityWarningRecord | null;
	ageMs: number;
	stale: boolean;
}

/** Read one ready record and derive its age plus staleness verdict. */
function readReadyRecord(path: string, nowMs: number): ReadyRecordRead {
	let record: QualityWarningRecord | null = null;
	try {
		record = parseRecord(readFileSync(path, "utf-8"));
	} catch {
		// The malformed record is claimed and discarded by the caller.
	}
	const producedMs = record ? Date.parse(record.produced_at) : Number.NaN;
	const ageMs = nowMs - producedMs;
	const stale = !Number.isFinite(producedMs) || ageMs > READY_TTL_MS || ageMs < -READY_GRACE_MS;
	return { record, ageMs, stale };
}

/** A fresh record belonging to another session, or still inside its grace window, is left alone. */
function skipReadyRecord(read: ReadyRecordRead, sessionId: string): boolean {
	if (read.record && !read.stale && read.record.session_id !== sessionId) return true;
	if (read.record && !read.stale && read.ageMs < READY_GRACE_MS) return true;
	return false;
}

/** Merge a claimed record's warnings when it is still this session's, then delete it. */
function absorbClaimedReadyRecord(
	claimed: string,
	stale: boolean,
	sessionId: string,
	warnings: Set<string>,
): void {
	try {
		const claimedRecord = parseRecord(readFileSync(claimed, "utf-8"));
		if (claimedRecord && !stale && claimedRecord.session_id === sessionId) {
			for (const warning of claimedRecord.warnings) warnings.add(warning);
		}
	} catch {
		// Corrupt records are discarded, never replayed.
	} finally {
		try {
			unlinkSync(claimed);
		} catch {
			// Best-effort claimed-record cleanup.
		}
	}
}

function consumeLegacyAfterModern(
	dataDir: string,
	hadModernRecords: boolean,
	warnings: Set<string>,
): void {
	if (!hadModernRecords) {
		for (const warning of consumeLegacyWarnings(dataDir)) warnings.add(warning);
		return;
	}
	if (warnings.size > 0) consumeLegacyWarnings(dataDir);
}

function hasPendingSpoolWork(dataDir: string): boolean {
	return (
		spoolFiles(dataDir, ".ready.json").length > 0 ||
		spoolFiles(dataDir, ".active.json").length > 0 ||
		existsSync(join(dataDir, LEGACY_PENDING_WARNINGS_FILE))
	);
}

/** Remove the token's ready record after its synchronous response arrived. */
export function acknowledgeSynchronousPostToolResult(
	dataDir: string,
	token: string,
	directWarnings: readonly string[],
): string[] {
	if (validDeliveryToken(token)) {
		removeTokenFile(dataDir, token, "ready");
		removeTokenFile(dataDir, token, "active");
	}
	// A rolling-upgrade old daemon may have written this same response to the
	// unscoped legacy file. Claim it so it cannot replay, but never merge it:
	// without a token/session, extra text may belong to another request.
	consumeLegacyWarnings(dataDir);
	return [...new Set(directWarnings)];
}

/**
 * Atomically claim this session's late warnings. A live originating hook (or
 * a young pid-less compatibility record) retains first-delivery ownership;
 * the reader defers instead of waiting, so a PreTool call never freezes.
 */
export function drainLatePostToolWarnings(
	dataDir: string,
	sessionId: string,
	nowMs = Date.now(),
): string[] {
	if (!hasPendingSpoolWork(dataDir)) return [];
	const lease = acquireDrainLease(dataDir);
	if (!lease) return [];
	const warnings = new Set<string>();
	try {
		const readyPaths = spoolFiles(dataDir, ".ready.json");
		sweepStaleActiveRecords(spoolFiles(dataDir, ".active.json"), nowMs);
		const activeForSession = activeRequestOwnsDelivery(
			spoolFiles(dataDir, ".active.json"),
			sessionId,
			nowMs,
		);
		const youngForSession = hasYoungReadyRecord(readyPaths, sessionId, nowMs);
		// A same-session PostTool request still owns the first-delivery right.
		// Defer the whole drain rather than consuming a legacy duplicate now and
		// replaying the request-owned record on the next PreTool invocation.
		if (activeForSession || youngForSession) return [];

		consumeReadyRecords(dataDir, readyPaths, sessionId, nowMs, warnings);
		// The old shared file has no session identity. Consume it only when there
		// are no modern records, or when this invocation claimed a same-session
		// modern record whose warning can be de-duplicated by value.
		consumeLegacyAfterModern(dataDir, readyPaths.length > 0, warnings);
		return [...warnings];
	} finally {
		releaseDrainLease(dataDir, lease);
	}
}
