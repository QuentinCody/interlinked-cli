// interlinked-tdd: exempt
// ===========================================
// Trigram Index — Query Path (intersection + adjacency + candidate resolution)
// ===========================================
// Extracted from ./trigram-index.ts to keep that file under the per-file
// line cap. These are free functions that take the TrigramIndex query-time
// state they operate on as an EXPLICIT structural view (QueryView); the
// corresponding class methods (query / queryCandidatePaths) are thin
// delegates. Behavior is identical to the original inline implementations —
// code was moved verbatim, not changed.
//
// This module imports only types/primitives from ./trigram-primitives.js
// (never from ./trigram-index.js) and consumes the class purely through the
// structural QueryView interface, so there is no runtime import cycle.

import { nonNull } from "../lib/non-null.js";
import {
	binarySearchU32,
	EARLY_TERMINATION_THRESHOLD,
	nextCharBit,
	type PostingList,
} from "./trigram-primitives.js";

/**
 * Read-only view of the TrigramIndex fields the query path needs. The
 * TrigramIndex instance satisfies this structurally (no import of the class),
 * keeping the dependency one-directional.
 */
export interface QueryView {
	readonly files: string[];
	readonly postings: Map<number, PostingList>;
	readonly stopTrigrams: Set<number>;
	readonly dirtyOverrides: Map<number, Set<number> | null>;
	readonly dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
}

/**
 * Query the index with a set of required trigrams.
 * Returns file IDs that contain ALL non-stop trigrams.
 * If all trigrams are stop trigrams or none provided, returns all files.
 *
 * @param requiredTrigrams - Trigrams that must all appear in matching files
 * @param trigramSequences - Ordered sequences of consecutive trigrams for adjacency checking
 */
export function queryIndex(
	view: QueryView,
	requiredTrigrams: number[],
	trigramSequences?: number[][],
): Set<number> {
	// Filter out stop trigrams — they match too many files to be useful
	const usable = requiredTrigrams.filter((t) => !view.stopTrigrams.has(t));

	if (usable.length === 0) {
		// No usable trigrams — every file is a candidate
		return getAllFileIds(view);
	}

	// Sort by posting list size (smallest first) for fastest intersection
	usable.sort((a, b) => getPostingSize(view, a) - getPostingSize(view, b));

	let result: Set<number> | null = null;

	for (const tri of usable) {
		const step = stepQuery(view, tri, result);
		result = step.result;
		if (step.action === "return") return result; // definitive miss or early exit
		if (step.action === "break") break; // candidate set small enough, further intersection unlikely to help
	}

	result = result ?? getAllFileIds(view);

	// Adjacency filtering using probabilistic masks
	if (trigramSequences && trigramSequences.length > 0 && result.size > 0) {
		const filtered = filterByAdjacency(view, result, trigramSequences);
		// Only use filtered result if it's non-empty (avoid false-negative wipeout)
		if (filtered.size > 0) {
			result = filtered;
		}
	}

	return result;
}

/**
 * Process one required trigram against the running result set: fetch its
 * candidates, intersect (or seed) into the accumulator, and report what the
 * caller's loop should do next. Mirrors the original inline per-trigram body
 * of queryIndex verbatim, just under a name instead of at loop depth.
 */
function stepQuery(
	view: QueryView,
	tri: number,
	result: Set<number> | null,
): { result: Set<number>; action: "continue" | "break" | "return" } {
	const candidates = getCandidatesForTrigram(view, tri);

	if (candidates.size === 0) {
		return { result: new Set(), action: "return" }; // definitive miss — no file has this trigram
	}

	const next = result === null ? candidates : intersectResult(result, candidates);

	if (next.size === 0) {
		return { result: next, action: "return" }; // early exit
	}

	// Early termination: candidate set small enough, further intersection unlikely to help
	if (next.size <= EARLY_TERMINATION_THRESHOLD) {
		return { result: next, action: "break" };
	}

	return { result: next, action: "continue" };
}

/** Intersect `result` with `candidates` in place. Snapshot first so the
 * delete never mutates the Set we are iterating. */
function intersectResult(result: Set<number>, candidates: Set<number>): Set<number> {
	for (const id of [...result]) {
		if (!candidates.has(id)) {
			result.delete(id);
		}
	}
	return result;
}

/**
 * Query and return candidate file paths (relative to cwd).
 */
export function queryCandidatePaths(
	view: QueryView,
	requiredTrigrams: number[],
	trigramSequences?: number[][],
): string[] {
	const ids = queryIndex(view, requiredTrigrams, trigramSequences);
	const paths: string[] = [];
	for (const id of ids) {
		const p = getFilePath(view, id);
		if (p) paths.push(p);
	}
	return paths;
}

// ===========================================
// Adjacency Filtering
// ===========================================

/**
 * Filter candidates by verifying that consecutive trigrams in query sequences
 * are actually adjacent in the file (using locMask and nextMask bloom filters).
 */
function filterByAdjacency(
	view: QueryView,
	candidates: Set<number>,
	sequences: number[][],
): Set<number> {
	const filtered = new Set<number>();
	for (const fileId of candidates) {
		if (passesAdjacencyCheck(view, fileId, sequences)) {
			filtered.add(fileId);
		}
	}
	return filtered;
}

function passesAdjacencyCheck(view: QueryView, fileId: number, sequences: number[][]): boolean {
	for (const seq of sequences) {
		if (seq.length < 2) continue; // single trigram, no adjacency to check

		for (let i = 0; i < seq.length - 1; i++) {
			const triA = nonNull(seq[i]);
			const triB = nonNull(seq[i + 1]);

			// Skip check for stop trigrams (no masks available)
			if (view.stopTrigrams.has(triA) || view.stopTrigrams.has(triB)) continue;

			const masksA = getMasksForFile(view, triA, fileId);
			const masksB = getMasksForFile(view, triB, fileId);
			if (!masksA || !masksB) continue; // not in base postings, skip

			// Position adjacency: rotate A's locMask left by 1, must overlap with B's
			const rotated = ((masksA.locMask << 1) | (masksA.locMask >>> 7)) & 0xff;
			if ((rotated & masksB.locMask) === 0) return false;

			// Next-char check: the 3rd char of triB should be in A's nextMask
			const thirdCharOfB = triB & 0xff; // lowest byte = 3rd character
			if ((masksA.nextMask & nextCharBit(thirdCharOfB)) === 0) return false;
		}
	}
	return true;
}

/**
 * Look up the locMask and nextMask for a specific (trigram, fileId) pair.
 * Returns null if the trigram is not in the base postings for this file.
 */
function getMasksForFile(
	view: QueryView,
	trigram: number,
	fileId: number,
): { locMask: number; nextMask: number } | null {
	// Check dirty override first
	if (view.dirtyOverrides.has(fileId)) {
		// Dirty files don't have masks — skip adjacency for them
		return null;
	}

	// Check dirty new files
	for (const entry of view.dirtyNewFiles.values()) {
		if (entry.id === fileId) return null; // dirty new file, no masks
	}

	// Check base postings
	const posting = view.postings.get(trigram);
	if (!posting) return null;

	const idx = binarySearchU32(posting.fileIds, fileId);
	if (idx < 0) return null;

	return { locMask: nonNull(posting.locMasks[idx]), nextMask: nonNull(posting.nextMasks[idx]) };
}

// ===========================================
// Query Helpers
// ===========================================

/** Get file path for a file ID */
export function getFilePath(view: QueryView, id: number): string | undefined {
	if (id < view.files.length) {
		return view.files[id];
	}
	// Check dirty new files
	for (const [path, entry] of view.dirtyNewFiles) {
		if (entry.id === id) return path;
	}
	return undefined;
}

/** Get all file IDs (base + dirty, excluding deleted) */
export function getAllFileIds(view: QueryView): Set<number> {
	const ids = new Set<number>();
	for (let i = 0; i < view.files.length; i++) {
		if (view.dirtyOverrides.get(i) !== null || !view.dirtyOverrides.has(i)) {
			ids.add(i);
		}
	}
	for (const entry of view.dirtyNewFiles.values()) {
		ids.add(entry.id);
	}
	return ids;
}

/** Get candidates for a single trigram, merging base + dirty */
function getCandidatesForTrigram(view: QueryView, trigram: number): Set<number> {
	const candidates = new Set<number>();

	// Add from base posting list (skipping overridden files)
	const basePostings = view.postings.get(trigram);
	if (basePostings) {
		for (const id of basePostings.fileIds) {
			if (view.dirtyOverrides.has(id)) continue; // handled below
			candidates.add(id);
		}
	}

	// Handle dirty overrides: files whose trigrams have been recomputed
	for (const [id, trigrams] of view.dirtyOverrides) {
		if (trigrams === null) continue; // deleted file
		if (trigrams.has(trigram)) candidates.add(id);
	}

	// Handle dirty new files
	for (const entry of view.dirtyNewFiles.values()) {
		if (entry.trigrams.has(trigram)) candidates.add(entry.id);
	}

	return candidates;
}

/** Get posting list size (for sort order optimization) */
function getPostingSize(view: QueryView, trigram: number): number {
	const base = view.postings.get(trigram);
	return base ? base.fileIds.length : 0;
}
