import {
	existsSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { QUALITY_WARNING_SPOOL_DIR } from "../../lib/post-tool-warning-spool-client.js";
import type { HarnessEvent } from "../types.js";

export { QUALITY_WARNING_SPOOL_DIR };

interface PostToolWarningSpoolHandle {
	readonly token: string;
	readonly sessionId: string;
	readonly markerPath: string;
	readonly readyPath: string;
	/** False for an older hook that did not supply a delivery token. */
	readonly requested: boolean;
	readonly ownsMarker: boolean;
	closed: boolean;
}

interface WarningSpoolRecord {
	version: 1;
	token: string;
	session_id: string;
	produced_at: string;
	warnings: string[];
}

function validDeliveryPid(value: number | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validDeliveryToken(value: string | undefined): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
}

function warningSpoolSessionId(event: HarnessEvent): string {
	return typeof event.session_id === "string" ? event.session_id : "";
}

/**
 * Claim one request-owned active marker. `wx` is load-bearing: a duplicate or
 * replayed delivery token never grants cleanup ownership to the second run.
 */
export function beginPostToolWarningSpool(
	interlinkedDir: string,
	event: HarnessEvent,
): PostToolWarningSpoolHandle {
	const requestedToken = validDeliveryToken(event.post_delivery_token)
		? event.post_delivery_token
		: null;
	const requested = requestedToken !== null;
	const token = requestedToken ?? `missing-${randomUUID()}`;
	const sessionId = warningSpoolSessionId(event);
	const spoolDir = join(interlinkedDir, QUALITY_WARNING_SPOOL_DIR);
	const markerPath = join(spoolDir, `${token}.active.json`);
	const readyPath = join(spoolDir, `${token}.ready.json`);
	let ownsMarker = false;
	if (!requested) {
		return {
			token,
			sessionId,
			markerPath,
			readyPath,
			requested: false,
			ownsMarker: false,
			closed: false,
		};
	}
	try {
		if (!existsSync(spoolDir)) mkdirSync(spoolDir, { recursive: true });
		if (!existsSync(readyPath)) {
			writeFileSync(
				markerPath,
				JSON.stringify({
					version: 1,
					token,
					session_id: sessionId,
					started_at: new Date().toISOString(),
					producer_pid: process.pid,
					client_pid: validDeliveryPid(event.post_delivery_pid)
						? event.post_delivery_pid
						: undefined,
				}),
				{ encoding: "utf-8", flag: "wx", mode: 0o600 },
			);
			ownsMarker = true;
		}
	} catch {
		// Persistence is a late-delivery aid. The synchronous harness response
		// remains authoritative when the local spool cannot be claimed.
	}
	return {
		token,
		sessionId,
		markerPath,
		readyPath,
		requested: true,
		ownsMarker,
		closed: false,
	};
}

function removeOwnedMarker(handle: PostToolWarningSpoolHandle): void {
	if (!handle.ownsMarker) return;
	try {
		unlinkSync(handle.markerPath);
	} catch {
		// A missing marker is harmless. Crucially, no other request's path is
		// ever unlinked here.
	}
}

/**
 * Atomically publish warnings for a possibly timed-out hook. Warning results
 * retain this request's marker until the synchronous client acknowledges it
 * or a liveness-aware late drain claims it; clean results release it here.
 * No request ever unlinks another token's marker.
 */
export function completePostToolWarningSpool(
	handle: PostToolWarningSpoolHandle,
	warnings: readonly string[],
): void {
	if (handle.closed) return;
	handle.closed = true;
	let tempPath: string | null = null;
	let published = false;
	try {
		if (!handle.ownsMarker || warnings.length === 0) return;
		const record: WarningSpoolRecord = {
			version: 1,
			token: handle.token,
			session_id: handle.sessionId,
			produced_at: new Date().toISOString(),
			warnings: [...warnings],
		};
		tempPath = `${handle.readyPath}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(tempPath, JSON.stringify(record), {
			encoding: "utf-8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(tempPath, handle.readyPath);
		tempPath = null;
		published = true;
	} finally {
		if (tempPath) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Best-effort cleanup of an unpublished temp file.
			}
		}
		// A warning record keeps the marker until the synchronous hook acks it,
		// or a later PreTool drain proves that hook process is gone and claims
		// both files. Clean/error paths release it here because no delivery is
		// pending. This closes the direct-response/late-drain duplicate window.
		if (!published) removeOwnedMarker(handle);
	}
}
