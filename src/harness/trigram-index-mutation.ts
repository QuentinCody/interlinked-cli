// interlinked-tdd: exempt
// ===========================================
// Trigram Index — Dirty-Layer Mutation (single-file update + incremental git sync)
// ===========================================
// Extracted from ./trigram-index.ts to keep that file under the per-file line
// cap. These are free functions that take the TrigramIndex dirty-layer state
// they mutate as an EXPLICIT structural view (MutableIndexView); the
// corresponding class methods (updateFile / incrementalUpdate) are thin
// delegates. Behavior is identical to the original inline implementations —
// code was moved verbatim, not changed.
//
// This module imports only the git helpers and primitives the originals used
// (never from ./trigram-index.js) and consumes the class purely through the
// structural MutableIndexView interface, so there is no runtime import cycle.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { getChangedFilesSince, getHeadCommit } from "./trigram-git.js";
import {
	DEFAULT_MAX_FILE_SIZE,
	extractTrigrams,
	extractTrigramsWithMasks,
	isBinaryContent,
	MAX_DIRTY_NEW_FILES,
	type PostingList,
	shouldSkipFile,
} from "./trigram-primitives.js";

/**
 * Mutable view of the TrigramIndex dirty-layer fields the update path touches.
 * The TrigramIndex instance supplies this from a delegate; `allocFileId` wraps
 * the instance's `nextFileId++` so the counter still lives on the class.
 */
export interface MutableIndexView {
	readonly fileToId: Map<string, number>;
	readonly dirtyOverrides: Map<number, Set<number> | null>;
	readonly dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
	/** Allocate (and consume) the next dirty file ID. */
	allocFileId(): number;
}

/** Drop any prior dirty state for a file an update is refusing to index
 *  (skip-listed, oversized, or past the brand-new-file cap) — same treatment
 *  the build/incremental paths give a skip-listed file: still on disk, just
 *  not accelerated, and never left indexed on stale content. */
function dropDirtyState(view: MutableIndexView, relPath: string, existingId: number | undefined): void {
	if (existingId !== undefined) view.dirtyOverrides.set(existingId, null);
	view.dirtyNewFiles.delete(relPath);
}

/** True when this content must NOT be added to the dirty layer — the same
 *  skip-list/size guard `incrementalUpdateState` already applies, mirrored
 *  here since this path (every Write/Edit tool call) never went through it. */
function isDirtyLayerExempt(relPath: string, content: string): boolean {
	return shouldSkipFile(relPath) || Buffer.byteLength(content, "utf-8") > DEFAULT_MAX_FILE_SIZE;
}

/**
 * Update the index for a single file (in-memory dirty layer).
 * Pass null content to mark a file as deleted.
 *
 * Returns whether the file was actually indexed (false when it was skipped —
 * name/extension skip-list, oversized, or the dirty layer is at its brand-new
 * file cap). A skipped file is treated exactly like the pre-existing
 * skip-list/oversize cases the build/incremental paths already had: still on
 * disk, just not accelerated — the caller's grep/rg fallback still finds it.
 *
 * This mirrors the same two guards `incrementalUpdateState` already applies
 * (skip-list, size), plus a cap on brand-new files unique to this path: every
 * Write/Edit tool call reaches here uncapped, and a large churn of brand-new
 * files (a mutation-campaign scratch directory, for instance) has no other
 * bound — root-caused 2026-08-22 as the dominant retained-heap set on a
 * daemon that hard-aborted with three emergency-GCs reclaiming nothing (the
 * dirty-layer Sets were live-referenced, not garbage).
 */
export function updateFileInState(
	view: MutableIndexView,
	relPath: string,
	content: string | null,
): boolean {
	const existingId = view.fileToId.get(relPath);
	const dirtyNew = view.dirtyNewFiles.get(relPath);

	if (content === null) {
		dropDirtyState(view, relPath, existingId);
		return true;
	}

	if (isDirtyLayerExempt(relPath, content)) {
		dropDirtyState(view, relPath, existingId);
		return false;
	}

	// Extract new trigrams
	const trigrams = isBinaryContent(content) ? new Set<number>() : extractTrigrams(content);

	if (existingId !== undefined) {
		// Override existing file
		view.dirtyOverrides.set(existingId, trigrams);
		return true;
	}
	if (dirtyNew) {
		// Update an already-dirty new file
		dirtyNew.trigrams = trigrams;
		return true;
	}
	// Brand new file — bounded: past the cap, leave it unindexed rather than
	// growing the dirty layer without limit (see docstring above).
	if (view.dirtyNewFiles.size >= MAX_DIRTY_NEW_FILES) return false;
	const id = view.allocFileId();
	view.dirtyNewFiles.set(relPath, { id, trigrams });
	return true;
}

/** Read-only slice of the dirty layer the count/flag/clear helpers consume. */
export interface DirtyStateView {
	readonly dirtyOverrides: Map<number, Set<number> | null>;
	readonly dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
}

/** Number of dirty (modified/added/deleted) files. */
export function dirtyFileCount(view: DirtyStateView): number {
	return view.dirtyOverrides.size + view.dirtyNewFiles.size;
}

/** Whether the index has any dirty state. */
export function isDirtyState(view: DirtyStateView): boolean {
	return view.dirtyOverrides.size > 0 || view.dirtyNewFiles.size > 0;
}

/** Clear all dirty state (e.g., after saving to disk). */
export function clearDirtyState(view: DirtyStateView): void {
	view.dirtyOverrides.clear();
	view.dirtyNewFiles.clear();
}

/**
 * Incrementally update the index from git changes since baseCommit.
 * Reads changed files from disk and applies them through `updateFile`.
 * Returns the number of files updated plus the new base commit; the caller
 * advances its own baseCommit to the returned value.
 */
export function incrementalUpdateState(
	cwd: string,
	baseCommit: string,
	updateFile: (relPath: string, content: string | null) => void,
): { updated: number; newBaseCommit: string } {
	const currentCommit = getHeadCommit(cwd);
	if (currentCommit === baseCommit) return { updated: 0, newBaseCommit: baseCommit };

	// If diff fails (e.g., base commit no longer exists), return 0 —
	// a full rebuild would be needed.
	const changedFiles = getChangedFilesSince(cwd, baseCommit);
	if (changedFiles === null) return { updated: 0, newBaseCommit: baseCommit };

	let updated = 0;
	for (const relPath of changedFiles) {
		if (shouldSkipFile(relPath)) continue;
		const absPath = join(cwd, relPath);
		try {
			if (!existsSync(absPath)) {
				updateFile(relPath, null);
				updated++;
				continue;
			}
			const buf = readFileSync(absPath);
			if (buf.length > DEFAULT_MAX_FILE_SIZE || isBinaryContent(buf)) {
				updateFile(relPath, null);
			} else {
				updateFile(relPath, buf.toString("utf-8"));
			}
			updated++;
		} catch (err) {
			void err; /* intentional: skip unreadable files during incremental rebuild */
		}
	}

	return { updated, newBaseCommit: currentCommit };
}

// ===========================================
// Merge Dirty Layer (called from TrigramIndex.mergeDirty / save)
// ===========================================
// Folds the in-memory dirty layer (overrides + new files) into the base
// postings so save() writes one complete on-disk snapshot. Each step below
// is a free function over explicit state — a mutable clone of the base
// postings, the files/fileToId tables, and cwd for on-disk mask re-reads —
// so the orchestrating TrigramIndex.mergeDirty() method reads as a
// five-step summary of the algorithm rather than one long procedure.

/** Posting-list entry while it's still being edited as mutable arrays. */
export interface MutablePostingData {
	fileIds: number[];
	locMasks: number[];
	nextMasks: number[];
}

/** Snapshot a `Map<number, PostingList>` as mutable per-trigram arrays. */
export function cloneMutablePostings(
	postings: Map<number, PostingList>,
): Map<number, MutablePostingData> {
	const clone = new Map<number, MutablePostingData>();
	for (const [tri, posting] of postings) {
		clone.set(tri, {
			fileIds: [...posting.fileIds],
			locMasks: [...posting.locMasks],
			nextMasks: [...posting.nextMasks],
		});
	}
	return clone;
}

/**
 * Re-read a file from disk and extract fresh trigram masks for it, so a
 * merged posting entry gets real adjacency data instead of zeros. Returns
 * null (never throws) for any failure — no path given, file missing, or a
 * read error (e.g. the path now points at a directory) — so callers fall
 * back to zero masks uniformly regardless of which way it failed.
 */
function readMasksFromDisk(
	cwd: string,
	relPath: string | undefined,
): Map<number, { locMask: number; nextMask: number }> | null {
	if (!relPath) return null;
	try {
		const absPath = join(cwd, relPath);
		if (!existsSync(absPath)) return null;
		return extractTrigramsWithMasks(readFileSync(absPath, "utf-8"));
	} catch (err) {
		void err; /* intentional: fall back to zero masks if file can't be read */
		return null;
	}
}

/** Remove every posting-list entry for `fileId` (a file being overridden or deleted). */
function removeFileFromPostings(postings: Map<number, MutablePostingData>, fileId: number): void {
	for (const [, data] of postings) {
		const idx = data.fileIds.indexOf(fileId);
		if (idx >= 0) {
			data.fileIds.splice(idx, 1);
			data.locMasks.splice(idx, 1);
			data.nextMasks.splice(idx, 1);
		}
	}
}

/** Append `fileId` to the posting list of every trigram in `trigrams`, using `masks` where available. */
function addFileToPostings(
	postings: Map<number, MutablePostingData>,
	fileId: number,
	trigrams: Iterable<number>,
	masks: Map<number, { locMask: number; nextMask: number }> | null,
): void {
	for (const tri of trigrams) {
		let data = postings.get(tri);
		if (!data) {
			data = { fileIds: [], locMasks: [], nextMasks: [] };
			postings.set(tri, data);
		}
		const m = masks?.get(tri);
		data.fileIds.push(fileId);
		data.locMasks.push(m?.locMask ?? 0);
		data.nextMasks.push(m?.nextMask ?? 0);
	}
}

/**
 * Apply dirty-layer overrides (modified or deleted base files) to a mutable
 * postings clone: remove the file's old posting entries everywhere, then —
 * unless it was a deletion (`trigrams === null`) — re-add it under its new
 * trigram set with masks re-read from disk where possible.
 */
export function applyDirtyOverrides(
	postings: Map<number, MutablePostingData>,
	dirtyOverrides: Map<number, Set<number> | null>,
	files: readonly string[],
	cwd: string,
): void {
	for (const [fileId, trigrams] of dirtyOverrides) {
		removeFileFromPostings(postings, fileId);
		if (!trigrams) continue;
		addFileToPostings(postings, fileId, trigrams, readMasksFromDisk(cwd, files[fileId]));
	}
}

/**
 * Apply dirty-layer new files to a mutable postings clone: assign each one a
 * permanent file id (appended to `files`/`fileToId`), then add it to the
 * posting list of every trigram it contains.
 */
export function appendDirtyNewFiles(
	postings: Map<number, MutablePostingData>,
	dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>,
	files: string[],
	fileToId: Map<string, number>,
	cwd: string,
): void {
	for (const [path, entry] of dirtyNewFiles) {
		const newId = files.length;
		files.push(path);
		fileToId.set(path, newId);
		addFileToPostings(postings, newId, entry.trigrams, readMasksFromDisk(cwd, path));
	}
}

/**
 * Convert a mutable postings clone back into the on-disk `PostingList` shape
 * (sorted typed arrays), dropping any trigram whose posting list emptied out
 * during the merge (e.g. its only file was deleted).
 */
export function finalizePostings(
	postings: Map<number, MutablePostingData>,
): Map<number, PostingList> {
	const result = new Map<number, PostingList>();
	for (const [tri, data] of postings) {
		if (data.fileIds.length === 0) continue;
		const indices = data.fileIds.map((_, i) => i);
		indices.sort((a, b) => nonNull(data.fileIds[a]) - nonNull(data.fileIds[b]));
		result.set(tri, {
			fileIds: new Uint32Array(indices.map((i) => nonNull(data.fileIds[i]))),
			locMasks: new Uint8Array(indices.map((i) => nonNull(data.locMasks[i]))),
			nextMasks: new Uint8Array(indices.map((i) => nonNull(data.nextMasks[i]))),
		});
	}
	return result;
}

/** Recompute the >40%-of-files stop-trigram set against the merged postings. */
export function computeStopTrigrams(
	postings: Map<number, PostingList>,
	fileCount: number,
): Set<number> {
	const threshold = Math.floor(fileCount * 0.4);
	const stopTrigrams = new Set<number>();
	for (const [tri, posting] of postings) {
		if (posting.fileIds.length > threshold) stopTrigrams.add(tri);
	}
	return stopTrigrams;
}
