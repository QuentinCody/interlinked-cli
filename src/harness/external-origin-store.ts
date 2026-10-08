// ===========================================
// External-origin file store (per session) and its snapshot form
// ===========================================
// The storage half of evaluator/external-origin-files.ts: which files a public,
// unauthenticated fetch wrote in this session, each with the fingerprint
// (size, mtime, inode) it had when recorded. It lives in this light module so
// the session snapshot codec (session-state.ts) can persist it without
// importing the Bash parser.
//
// Persistence (2026-10-05): the entries ride in `<id>.live.json` as
// `external_origin_files`. A daemon restart used to forget them, and a fetched
// page then ratcheted to Confidential. On reload every entry's fingerprint is
// checked against the file on disk; an entry whose file changed or vanished
// while the daemon was down is dropped (fail safe: the file is local again).
// The 120-second freshness window governs RECORDING only, never reload.
// Snapshots without the field hydrate to an empty registry.

import { type Stats, statSync } from "node:fs";
import type { JsonObject } from "../lib/json-types.js";
import type { SessionTrajectory } from "./types.js";

export const EXTERNAL_ORIGIN_MAX_FILES = 512;

export interface ExternalOriginFile {
	/** Canonical absolute path. */
	path: string;
	/** The public URL the content came from (redacted, ≤ 120 chars). */
	source: string;
	size: number;
	mtimeMs: number;
	ino: number;
	/** Epoch ms when the entry was recorded. */
	recorded_at: number;
}

const REGISTRY = new WeakMap<SessionTrajectory, ExternalOriginFile[]>();

export function statRegularFile(p: string): Stats | null {
	try {
		const st = statSync(p);
		return st.isFile() ? st : null;
	} catch {
		return null;
	}
}

/** True while the file on disk still has the fingerprint the entry recorded. */
export function fingerprintMatches(entry: ExternalOriginFile): boolean {
	const st = statRegularFile(entry.path);
	return st !== null && st.size === entry.size && st.mtimeMs === entry.mtimeMs && st.ino === entry.ino;
}

export function externalOriginEntries(session: SessionTrajectory): readonly ExternalOriginFile[] {
	return REGISTRY.get(session) ?? [];
}

/** Replace the session's entries, keeping the newest `EXTERNAL_ORIGIN_MAX_FILES`. */
export function setExternalOriginEntries(session: SessionTrajectory, entries: readonly ExternalOriginFile[]): void {
	REGISTRY.set(session, entries.slice(-EXTERNAL_ORIGIN_MAX_FILES));
}

/** The snapshot form of the session's entries (JSON-safe copies). */
export function serializeExternalOrigins(session: SessionTrajectory): JsonObject[] {
	return externalOriginEntries(session).map((e) => ({
		path: e.path,
		source: e.source,
		size: e.size,
		mtimeMs: e.mtimeMs,
		ino: e.ino,
		recorded_at: e.recorded_at,
	}));
}

function finite(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readEntry(v: unknown): ExternalOriginFile | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o: Partial<Record<string, unknown>> = { ...v };
	const [size, mtimeMs, ino, recordedAt] = [finite(o.size), finite(o.mtimeMs), finite(o.ino), finite(o.recorded_at)];
	if (typeof o.path !== "string" || !o.path.startsWith("/") || typeof o.source !== "string") return null;
	if (size === null || mtimeMs === null || ino === null || recordedAt === null) return null;
	return { path: o.path, source: o.source, size, mtimeMs, ino, recorded_at: recordedAt };
}

/**
 * Hydrate: restore the entries a snapshot carried, dropping every malformed
 * entry and every entry whose file no longer matches its fingerprint. Returns
 * the number of entries kept.
 */
export function restoreExternalOrigins(session: SessionTrajectory, v: unknown): number {
	if (!Array.isArray(v)) return 0;
	const kept: ExternalOriginFile[] = [];
	for (const item of v) {
		const entry = readEntry(item);
		if (entry && fingerprintMatches(entry)) kept.push(entry);
	}
	setExternalOriginEntries(session, kept);
	return externalOriginEntries(session).length;
}
