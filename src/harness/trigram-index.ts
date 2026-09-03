// ===========================================
// Trigram Index v2 — Fast regex search via inverted index
// ===========================================
// Indexes a codebase by breaking file content into overlapping 3-character
// sequences (trigrams) and building an inverted index: trigram → file IDs.
// At query time, decompose a search pattern into trigrams, intersect posting
// lists, and return only the files that could possibly match — typically
// reducing a full-repo grep to scanning a handful of files.
//
// v2 enhancements (inspired by Cursor's fast regex search blog post):
//   - Probabilistic masks: locMask (position bloom) + nextMask (next-char bloom)
//     per posting entry for adjacency verification and 3.5-gram selectivity
//   - Two-file layout: trigram.lookup (header + lookup table) + trigram.postings
//     (sequential posting data) for future lazy/mmap loading
//   - Hash-based keys: FNV-1a hashes in on-disk lookup table for binary search
//   - Early termination: stop intersection when candidate set is small enough
//   - Adjacency filtering: verify consecutive query trigrams are adjacent in files
//
// Design decisions:
//   - Lowercase all trigrams (case-insensitive index, never misses a match)
//   - Skip binary files (null byte in first 8KB)
//   - Skip oversized files (configurable, default 1MB)
//   - Filter "stop trigrams" that appear in > 40% of files (useless for filtering)
//   - Dirty layer for in-memory updates without full rebuild
//
// Primitives (encoding, extraction, binary detection, skip rules, on-disk
// format constants, bit helpers) live in ./trigram-primitives.ts. Git-based
// file discovery lives in ./trigram-git.ts. This file holds the TrigramIndex
// class — build/query/dirty-layer/serialization — that composes them.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { getHeadCommit, getTrackedFiles } from "./trigram-git.js";
import {
	appendDirtyNewFiles,
	applyDirtyOverrides,
	clearDirtyState,
	cloneMutablePostings,
	computeStopTrigrams,
	dirtyFileCount,
	finalizePostings,
	incrementalUpdateState,
	isDirtyState,
	type MutableIndexView,
	updateFileInState,
} from "./trigram-index-mutation.js";
import {
	type QueryView,
	queryCandidatePaths as queryCandidatePathsImpl,
	queryIndex,
} from "./trigram-index-query.js";
import {
	computeIndexStats,
	loadIndex,
	loadIndexMeta,
	saveIndex,
} from "./trigram-index-serialization.js";
import {
	DEFAULT_MAX_FILE_SIZE,
	DEFAULT_STOP_THRESHOLD,
	extractTrigramsWithMasks,
	type IndexBuildOptions,
	type IndexStats,
	isBinaryContent,
	type PostingList,
	shouldSkipFile,
} from "./trigram-primitives.js";

// Re-export the primitives so existing importers of ./trigram-index.js keep
// working unchanged (public API is preserved across the decomposition).
export {
	extractTrigrams,
	isBinaryContent,
	isControlChar,
	type PostingList,
	packTrigram,
	shouldSkipFile,
	trigramToString,
	unpackTrigram,
} from "./trigram-primitives.js";

/** One file's extracted trigram masks, keyed by packed trigram. */
interface RawFileEntry {
	path: string;
	masks: Map<number, { locMask: number; nextMask: number }>;
}

/**
 * Read one candidate file as text, or return null when it must be skipped:
 * unreadable, larger than `maxFileSize`, or binary.
 */
function readIndexableContent(absPath: string, maxFileSize: number): string | null {
	try {
		const stat = readFileSync(absPath);
		if (stat.length > maxFileSize) return null;
		if (isBinaryContent(stat)) return null;
		return stat.toString("utf-8");
	} catch {
		return null; // unreadable file, skip
	}
}

/**
 * Read each candidate file from disk, apply the skip/oversize/binary rules,
 * and extract per-file trigram masks plus a running trigram→file-count tally
 * (input to the stop-trigram cutoff). Split out of `build()` because this is
 * the one loop that mixes a try/catch, a nested for-of, and four independent
 * skip conditions — by far its most deeply nested block.
 */
function collectFileEntries(
	cwd: string,
	filePaths: string[],
	maxFileSize: number,
	totalFiles: number,
	onProgress?: (indexed: number, total: number) => void,
): { fileEntries: RawFileEntry[]; trigramCounts: Map<number, number> } {
	const fileEntries: RawFileEntry[] = [];
	const trigramCounts = new Map<number, number>(); // trigram → number of files containing it

	for (let i = 0; i < filePaths.length; i++) {
		const relPath = nonNull(filePaths[i]);
		if (shouldSkipFile(relPath)) continue;

		const content = readIndexableContent(join(cwd, relPath), maxFileSize);
		if (content === null) continue;

		const masks = extractTrigramsWithMasks(content);
		if (masks.size === 0) continue;

		fileEntries.push({ path: relPath, masks });

		// Count how many files each trigram appears in
		for (const tri of masks.keys()) {
			trigramCounts.set(tri, (trigramCounts.get(tri) || 0) + 1);
		}

		if (onProgress) {
			onProgress(fileEntries.length, totalFiles);
		}
	}

	return { fileEntries, trigramCounts };
}

/**
 * Invert the per-file trigram masks into the on-disk posting-list shape,
 * dropping stop trigrams. A file's ID is its index in `fileEntries`.
 */
function buildPostingLists(
	fileEntries: RawFileEntry[],
	stopTrigrams: Set<number>,
): Map<number, PostingList> {
	const builder = new Map<
		number,
		{ fileIds: number[]; locMasks: number[]; nextMasks: number[] }
	>();

	for (let fileId = 0; fileId < fileEntries.length; fileId++) {
		const { masks } = nonNull(fileEntries[fileId]);
		for (const [tri, m] of masks) {
			if (stopTrigrams.has(tri)) continue;
			let entry = builder.get(tri);
			if (!entry) {
				entry = { fileIds: [], locMasks: [], nextMasks: [] };
				builder.set(tri, entry);
			}
			entry.fileIds.push(fileId);
			entry.locMasks.push(m.locMask);
			entry.nextMasks.push(m.nextMask);
		}
	}

	// Convert to typed arrays for compactness
	const postings = new Map<number, PostingList>();
	for (const [tri, data] of builder) {
		postings.set(tri, {
			fileIds: new Uint32Array(data.fileIds),
			locMasks: new Uint8Array(data.locMasks),
			nextMasks: new Uint8Array(data.nextMasks),
		});
	}
	return postings;
}

// ===========================================
// TrigramIndex Class
// ===========================================

export class TrigramIndex {
	/** File paths indexed by file ID (array index = file ID) */
	readonly files: string[];
	/** Reverse lookup: path → file ID */
	private fileToId: Map<string, number>;
	/** Inverted index: trigram → posting list with masks */
	private postings: Map<number, PostingList>;
	/** Trigrams too common to be useful for filtering */
	private stopTrigrams: Set<number>;
	/** Git commit the index was built from */
	baseCommit: string;
	/** When the index was built */
	builtAt: string;
	/** Working directory */
	readonly cwd: string;

	// --- Dirty layer ---
	/** Files with overridden trigram sets (fileId → trigrams, null = deleted) */
	private dirtyOverrides: Map<number, Set<number> | null>;
	/** New files added since base index (path → { id, trigrams }) */
	private dirtyNewFiles: Map<string, { id: number; trigrams: Set<number> }>;
	/** Next file ID for dirty new files */
	private nextFileId: number;

	constructor(
		files: string[],
		postings: Map<number, PostingList>,
		stopTrigrams: Set<number>,
		baseCommit: string,
		cwd: string,
		builtAt?: string,
	) {
		this.files = files;
		this.fileToId = new Map();
		for (let i = 0; i < files.length; i++) {
			this.fileToId.set(nonNull(files[i]), i);
		}
		this.postings = postings;
		this.stopTrigrams = stopTrigrams;
		this.baseCommit = baseCommit;
		this.cwd = cwd;
		this.builtAt = builtAt || new Date().toISOString();

		// Dirty layer
		this.dirtyOverrides = new Map();
		this.dirtyNewFiles = new Map();
		this.nextFileId = files.length;
	}

	// ===========================================
	// Building
	// ===========================================

	/**
	 * Build a full index from the working directory.
	 * Uses `git ls-files` for file discovery (respects .gitignore).
	 */
	static build(options: IndexBuildOptions = {}): TrigramIndex {
		const cwd = resolve(options.cwd || process.cwd());
		const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
		const stopThreshold = options.stopThreshold ?? DEFAULT_STOP_THRESHOLD;

		// Get file list
		const filePaths = getTrackedFiles(cwd);
		const totalFiles = filePaths.length;

		// Extract trigrams per file (with masks for enhanced postings)
		const { fileEntries, trigramCounts } = collectFileEntries(
			cwd,
			filePaths,
			maxFileSize,
			totalFiles,
			options.onProgress,
		);

		// Determine stop trigrams
		const fileCount = fileEntries.length;
		const stopCutoff = Math.floor(fileCount * stopThreshold);
		const stopTrigrams = new Set<number>();
		for (const [tri, count] of trigramCounts) {
			if (count > stopCutoff) {
				stopTrigrams.add(tri);
			}
		}

		// Build inverted index with masks (excluding stop trigrams)
		const files = fileEntries.map((entry) => entry.path);
		const postings = buildPostingLists(fileEntries, stopTrigrams);

		// Get base commit
		const baseCommit = getHeadCommit(cwd);

		return new TrigramIndex(files, postings, stopTrigrams, baseCommit, cwd);
	}

	// ===========================================
	// Querying
	// ===========================================

	/** Query the index for file IDs containing all required (non-stop) trigrams. */
	query(requiredTrigrams: number[], trigramSequences?: number[][]): Set<number> {
		return queryIndex(this.view(), requiredTrigrams, trigramSequences);
	}

	/** Query and return candidate file paths (relative to cwd). */
	queryCandidatePaths(requiredTrigrams: number[], trigramSequences?: number[][]): string[] {
		return queryCandidatePathsImpl(this.view(), requiredTrigrams, trigramSequences);
	}

	/** Shared structural view fed to the query + mutation free functions (no back-import). */
	private view(): QueryView & MutableIndexView {
		return {
			files: this.files,
			postings: this.postings,
			stopTrigrams: this.stopTrigrams,
			fileToId: this.fileToId,
			dirtyOverrides: this.dirtyOverrides,
			dirtyNewFiles: this.dirtyNewFiles,
			allocFileId: () => this.nextFileId++,
		};
	}

	/** Get the total number of indexed files (base + dirty new) */
	get totalFiles(): number {
		return this.files.length + this.dirtyNewFiles.size;
	}

	// ===========================================
	// Dirty Layer
	// ===========================================

	/**
	 * Update the index for a single file (in-memory dirty layer).
	 * Pass null content to mark a file as deleted. Returns false when the
	 * file was skip-listed, oversized, or past the dirty-layer's brand-new
	 * file cap — see `updateFileInState`'s docstring.
	 */
	updateFile(relPath: string, content: string | null): boolean {
		return updateFileInState(this.view(), relPath, content);
	}

	/** Get the number of dirty (modified/added/deleted) files */
	get dirtyFileCount(): number {
		return dirtyFileCount(this.view());
	}

	/** Check if the index has any dirty state */
	get isDirty(): boolean {
		return isDirtyState(this.view());
	}

	/** Clear all dirty state (e.g., after saving to disk) */
	clearDirty(): void {
		clearDirtyState(this.view());
	}

	/**
	 * Merge dirty layer into the base index so save() writes a complete snapshot.
	 * After merging, dirty state is cleared and the base index reflects all edits.
	 * Re-reads files from disk to compute proper masks for merged entries.
	 */
	mergeDirty(): void {
		if (!this.isDirty) return;

		// Steps live in ./trigram-index-mutation.ts as free functions over
		// explicit state: clone the base postings mutably, fold in overrides
		// and new files (each re-reading disk masks where possible), then
		// convert back to the on-disk PostingList shape and recompute the
		// stop-trigram set against the merged result.
		const mutablePostings = cloneMutablePostings(this.postings);
		applyDirtyOverrides(mutablePostings, this.dirtyOverrides, this.files, this.cwd);
		appendDirtyNewFiles(mutablePostings, this.dirtyNewFiles, this.files, this.fileToId, this.cwd);

		this.postings = finalizePostings(mutablePostings);
		this.stopTrigrams = computeStopTrigrams(this.postings, this.files.length);

		this.nextFileId = this.files.length;
		this.clearDirty();
	}

	// ===========================================
	// Incremental Update
	// ===========================================

	/**
	 * Incrementally update the index from git changes since baseCommit.
	 * Reads changed files from disk and updates the dirty layer.
	 * Returns the number of files updated.
	 */
	incrementalUpdate(): number {
		const { updated, newBaseCommit } = incrementalUpdateState(
			this.cwd,
			this.baseCommit,
			(relPath, content) => this.updateFile(relPath, content),
		);
		this.baseCommit = newBaseCommit;
		return updated;
	}

	// ===========================================
	// Serialization — Two-File v2 Format
	// ===========================================
	// Logic lives in ./trigram-index-serialization.ts (free functions taking
	// the relevant instance fields as explicit parameters). These methods are
	// thin delegates that preserve the original public signatures and behavior.

	/**
	 * Save the index to disk in .interlinked/index/.
	 *
	 * Two-file format:
	 *   trigram.lookup  — header, file table, stop trigrams, sorted lookup entries
	 *   trigram.postings — sequential posting entries (6 bytes each)
	 *   meta.json — quick-access statistics
	 */
	save(interlinkedDir?: string): void {
		// Merge dirty layer into base index so we save a complete snapshot
		this.mergeDirty();
		saveIndex(
			this.files,
			this.postings,
			this.stopTrigrams,
			this.baseCommit,
			this.builtAt,
			this.cwd,
			interlinkedDir,
		);
	}

	/**
	 * Load an index from disk.
	 * Reads the v2 two-file format (trigram.lookup + trigram.postings).
	 * Returns null if no v2 index found.
	 */
	static load(cwd: string, interlinkedDir?: string): TrigramIndex | null {
		const parsed = loadIndex(cwd, interlinkedDir);
		if (parsed === null) return null;
		return new TrigramIndex(
			parsed.files,
			parsed.postings,
			parsed.stopTrigrams,
			parsed.baseCommit,
			cwd,
			parsed.builtAt,
		);
	}

	/**
	 * Load just the metadata without parsing the full index.
	 */
	static loadMeta(cwd: string, interlinkedDir?: string): IndexStats | null {
		return loadIndexMeta(cwd, interlinkedDir);
	}

	/** Get index statistics */
	stats(): IndexStats {
		return computeIndexStats(
			this.files,
			this.postings,
			this.stopTrigrams,
			this.baseCommit,
			this.builtAt,
		);
	}
}
