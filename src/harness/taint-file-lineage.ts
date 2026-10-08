// ===========================================
// Tainted-file store (H3 option B5)
// ===========================================
// Actors exchange data through files as well as through spawn prompts and
// result messages. A file written by an actor whose level is above Public is
// recorded here with that level; a later read of it by ANY actor ratchets the
// reader to the recorded level (evaluator/taint-lineage-flow.ts). Without this
// a clean sibling could read what a tainted worker wrote and send it out.
//
// Bounded (oldest evicted first) and persisted in the session snapshot as
// `taint_files`, like the external-origin registry. No fingerprint: an entry
// keeps the path tainted until an operator clear, which is the fail-safe
// direction. Paths are canonical absolute paths.

import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { higherLevel, isSensitivityLevel } from "./taint-lineage.js";
import type { SensitivityLevel, SessionTrajectory } from "./types.js";

export const MAX_TAINTED_FILES = 2048;

/**
 * One canonical spelling for a path, so a write recorded as `/tmp/x` and a
 * read resolved as `/private/tmp/x` are the same entry (macOS symlinks every
 * temp root; `stage-operands.ts` realpaths its operands). The file itself may
 * not exist yet, so the PARENT directory is canonicalized and the basename
 * re-joined; an unresolvable parent leaves the path as given.
 */
export function canonicalTaintPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return join(realpathSync(dirname(path)), basename(path));
		} catch {
			return path;
		}
	}
}

export interface TaintedFile {
	/** Canonical absolute path (a file, or a directory a copy wrote into). */
	path: string;
	level: SensitivityLevel;
	/** Actor key of the writer that set the recorded level. */
	writer: string;
	at_step: number;
}

const STORE = new WeakMap<SessionTrajectory, Map<string, TaintedFile>>();

function filesOf(session: SessionTrajectory): Map<string, TaintedFile> {
	let files = STORE.get(session);
	if (!files) {
		files = new Map();
		STORE.set(session, files);
	}
	return files;
}

/** Record a write. Public writes are not recorded; an existing entry keeps the
 *  higher level and its writer. Returns true when the entry is new or rose. */
export function recordTaintedFile(session: SessionTrajectory, rec: TaintedFile): boolean {
	if (rec.level === "Public") return false;
	const files = filesOf(session);
	const path = canonicalTaintPath(rec.path);
	const prior = files.get(path);
	const next = prior && higherLevel(prior.level, rec.level) === prior.level ? prior : { ...rec, path };
	files.delete(path);
	files.set(path, next);
	if (files.size > MAX_TAINTED_FILES) {
		const oldest = files.keys().next().value;
		if (oldest !== undefined) files.delete(oldest);
	}
	return next !== prior;
}

function covers(dir: string, path: string): boolean {
	return path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/** Entries a read of `path` reaches: the path itself, files under it (a
 *  directory read), or a recorded directory that contains it. */
export function taintedFilesMatching(session: SessionTrajectory, rawPath: string): TaintedFile[] {
	const files = STORE.get(session);
	if (!files || files.size === 0) return [];
	const path = canonicalTaintPath(rawPath);
	return [...files.values()].filter((f) => f.path === path || covers(path, f.path) || covers(f.path, path));
}

export function taintedFileCount(session: SessionTrajectory): number {
	return STORE.get(session)?.size ?? 0;
}

/** Every entry, oldest first (for the textual fallback and for views). */
export function taintedFileEntries(session: SessionTrajectory): readonly TaintedFile[] {
	return [...(STORE.get(session)?.values() ?? [])];
}

/** Operator clear: every entry, or only those `writer` recorded. Returns the
 *  number dropped. */
export function clearTaintedFiles(session: SessionTrajectory, writer?: string): number {
	const files = STORE.get(session);
	if (!files) return 0;
	let dropped = 0;
	for (const [path, f] of [...files]) {
		if (writer !== undefined && f.writer !== writer) continue;
		files.delete(path);
		dropped++;
	}
	return dropped;
}

export function serializeTaintedFiles(session: SessionTrajectory): JsonObject[] {
	return taintedFileEntries(session).map((f) => ({ path: f.path, level: f.level, writer: f.writer, at_step: f.at_step }));
}

function readRow(v: unknown): TaintedFile | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o: Partial<Record<string, unknown>> = { ...v };
	if (typeof o.path !== "string" || !o.path.startsWith("/") || typeof o.writer !== "string") return null;
	if (!isSensitivityLevel(o.level) || o.level === "Public") return null;
	const step = typeof o.at_step === "number" && Number.isFinite(o.at_step) ? o.at_step : 0;
	return { path: o.path, level: o.level, writer: o.writer, at_step: step };
}

/** Hydrate the entries a snapshot carried, dropping malformed rows. An absent
 *  field (older snapshot) restores an empty table. Returns the rows kept. */
export function restoreTaintedFiles(session: SessionTrajectory, v: unknown): number {
	const files = filesOf(session);
	files.clear();
	if (!Array.isArray(v)) return 0;
	for (const row of v.map(readRow)) {
		if (row) files.set(row.path, row);
	}
	while (files.size > MAX_TAINTED_FILES) {
		const oldest = files.keys().next().value;
		if (oldest === undefined) break;
		files.delete(oldest);
	}
	return files.size;
}
