// ===========================================
// Live session-state snapshot
// ===========================================
// Companion to `<id>.trajectory.json` (post-end archive). The `<id>.live.json`
// snapshot is rewritten atomically after every event so a harness restart
// mid-session can hydrate and resume without losing in-flight trajectory state
// (acknowledged checks, edit counts, fired reminders, TDD cycles, ...).
//
// Lifecycle:
//   - Per-event:    writeLiveSnapshot(...)        — atomic temp+rename
//   - First-event:  readLiveSnapshot(...)         — lazy hydrate on miss
//   - SessionEnd:   deleteLiveSnapshot(...)       — paired with trajectory write
//   - Startup:      sweepStaleLiveSnapshots(...)  — TTL purge of orphans
//
// All operations are best-effort — any I/O failure is logged by the caller and
// swallowed here. A missing snapshot is identical to a fresh session, which is
// the same fallback `recordEvent` already provides.

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { sanitizeSessionId } from "./session-paths.js";

const LIVE_SUFFIX = ".live.json";

/** Default orphan TTL: 48 h covers "I left this repo open over the weekend".
 *  Configurable via the `ttlMs` parameter. */
export const DEFAULT_LIVE_TTL_MS = 48 * 60 * 60 * 1000;

/** Resolve `.interlinked/sessions/` for a repo root, ensuring it exists. */
function ensureSessionsDir(cwd: string): string {
	const dir = join(cwd, ".interlinked", "sessions");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Resolve the on-disk path for a session's live snapshot, with traversal
 * protection. Returns null when the session_id can't be sanitized to a safe
 * filename — callers should treat that as "no snapshot available" without
 * crashing.
 */
export function liveSnapshotPath(cwd: string, sessionId: string): string | null {
	const safeId = sanitizeSessionId(sessionId);
	if (!safeId) return null;
	const sessDir = ensureSessionsDir(cwd);
	const target = join(sessDir, `${safeId}${LIVE_SUFFIX}`);
	const resolvedDir = resolve(sessDir);
	const resolvedTarget = resolve(target);
	if (resolvedTarget !== resolvedDir && !resolvedTarget.startsWith(resolvedDir + sep)) {
		return null;
	}
	return target;
}

/**
 * Atomically persist a session snapshot to disk. Write goes through a `.tmp`
 * sibling and a rename so a daemon crash mid-write can never leave a half-
 * written file the next hydrate would parse as garbage.
 */
export function writeLiveSnapshot(
	cwd: string,
	sessionId: string,
	snapshot: JsonObject,
): { ok: true } | { ok: false; error: Error } {
	const target = liveSnapshotPath(cwd, sessionId);
	if (!target) return { ok: false, error: new Error("invalid session_id for live snapshot") };
	const tmp = `${target}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
		renameSync(tmp, target);
		return { ok: true };
	} catch (err) {
		try {
			if (existsSync(tmp)) rmSync(tmp, { force: true });
		} catch {
			/* cleanup only — secondary failure, already in the error path */
		}
		return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

/**
 * Read a session's live snapshot. Returns null if the file is missing,
 * unreadable, or doesn't parse as a JSON object — callers fall back to the
 * fresh-session default.
 */
export function readLiveSnapshot(cwd: string, sessionId: string): JsonObject | null {
	const target = liveSnapshotPath(cwd, sessionId);
	if (!target || !existsSync(target)) return null;
	try {
		const raw = readFileSync(target, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		return isJsonObject(parsed)
			? (parsed)
			: null;
	} catch {
		return null;
	}
}

/** Remove a session's live snapshot. Idempotent — missing file is success. */
export function deleteLiveSnapshot(cwd: string, sessionId: string): void {
	const target = liveSnapshotPath(cwd, sessionId);
	if (!target) return;
	try {
		if (existsSync(target)) rmSync(target, { force: true });
	} catch {
		/* cleanup only — caller can't act on a delete failure */
	}
}

export interface SweepResult {
	scanned: number;
	removed: string[];
}

/**
 * Purge orphaned `<id>.live.json` files older than `ttlMs`. Called at daemon
 * startup so a long-dead session's snapshot doesn't accumulate. Files newer
 * than the TTL are left alone — a session that was active in the last 48 h
 * is treated as potentially still alive (the next event hydrates it).
 *
 * Returns absolute paths of removed files for telemetry. Best-effort: any
 * stat/rm failure on a single file is skipped silently.
 */
export function sweepStaleLiveSnapshots(
	cwd: string,
	ttlMs: number = DEFAULT_LIVE_TTL_MS,
): SweepResult {
	const dir = join(cwd, ".interlinked", "sessions");
	if (!existsSync(dir)) return { scanned: 0, removed: [] };
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return { scanned: 0, removed: [] };
	}
	const cutoff = Date.now() - ttlMs;
	const removed: string[] = [];
	let scanned = 0;
	for (const name of entries) {
		if (!name.endsWith(LIVE_SUFFIX)) continue;
		scanned++;
		const path = join(dir, name);
		try {
			const info = statSync(path);
			if (info.mtimeMs < cutoff) {
				rmSync(path, { force: true });
				removed.push(path);
			}
		} catch {
			/* cleanup only — file may have been removed concurrently */
		}
	}
	return { scanned, removed };
}
