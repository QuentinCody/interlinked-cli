// ===========================================
// Trigram Index — Primitives & Encoding
// ===========================================
// Pure, freestanding building blocks for the trigram index: constants, the
// on-disk format magic, trigram packing/extraction, binary detection, skip-file
// rules, and the small bit-twiddling helpers. None of these touch TrigramIndex
// instance state — they are shared by the class (in trigram-index.ts) and by
// regex-trigrams.ts / the test fixtures.
//
// Design decisions (carried over from the index header):
//   - Lowercase all trigrams (case-insensitive index, never misses a match)
//   - Skip binary files (null byte in first 8KB)
//   - Skip oversized files (configurable, default 1MB)
//   - Filter "stop trigrams" that appear in > 40% of files (useless for filtering)

import { nonNull } from "../lib/non-null.js";

// ===========================================
// Constants
// ===========================================

export const MAGIC_LOOKUP = 0x54524c4b; // "TRLK"
export const VERSION = 2;
export const FLAG_LOWERCASE = 1;
export const FLAG_MASKS = 2;
export const DEFAULT_MAX_FILE_SIZE = 1_048_576; // 1MB
export const DEFAULT_STOP_THRESHOLD = 0.4; // 40% of files
/** Ceiling on brand-new files the in-memory dirty layer accumulates before a
 *  full `save()`/rebuild folds them into the base index. Unbounded growth here
 *  was root-caused 2026-08-22: a mutation-campaign scratch churn of ~19k files
 *  (each Write/Edit call adding a live-referenced Set<number> of trigrams that
 *  no idle/emergency shrink path ever clears) pinned a daemon's old_space at
 *  ~1.8GB until it hard-aborted. Past this cap, a brand-new file is treated
 *  like any other skip-listed file: still on disk, just not accelerated —
 *  the existing full-`rg` fallback (unindexed candidate) already covers it. */
export const MAX_DIRTY_NEW_FILES = 3000;
export const EARLY_TERMINATION_THRESHOLD = 20;
export const INDEX_DIR_NAME = "index";
export const LOOKUP_FILE_NAME = "trigram.lookup";
export const POSTINGS_FILE_NAME = "trigram.postings";
export const LEGACY_INDEX_FILE_NAME = "trigram.bin";
export const META_FILE_NAME = "meta.json";

// Files that are never worth indexing (lock files, minified, source maps)
const SKIP_BASENAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"Cargo.lock",
	"Gemfile.lock",
	"poetry.lock",
	"composer.lock",
	"go.sum",
]);

const SKIP_EXTENSIONS = new Set([".min.js", ".min.css", ".map", ".wasm", ".pb", ".pyc"]);

// ===========================================
// Hash Functions
// ===========================================

/** FNV-1a hash of a packed trigram (for on-disk lookup table sorting) */
export function fnv1a(packed: number): number {
	let hash = 0x811c9dc5;
	hash ^= (packed >> 16) & 0xff;
	hash = Math.imul(hash, 0x01000193);
	hash ^= (packed >> 8) & 0xff;
	hash = Math.imul(hash, 0x01000193);
	hash ^= packed & 0xff;
	hash = Math.imul(hash, 0x01000193);
	return hash >>> 0;
}

/** Bloom filter bit for a character code (golden ratio hash, top 3 bits → 0..7) */
export function nextCharBit(charCode: number): number {
	return 1 << ((Math.imul(charCode, 0x9e3779b9) >>> 29) & 7);
}

// ===========================================
// Trigram Encoding
// ===========================================

/** Pack 3 ASCII char codes into a uint32: (c0 << 16) | (c1 << 8) | c2 */
export function packTrigram(c0: number, c1: number, c2: number): number {
	return ((c0 & 0xff) << 16) | ((c1 & 0xff) << 8) | (c2 & 0xff);
}

/** Unpack a uint32 trigram into 3 char codes */
export function unpackTrigram(packed: number): [number, number, number] {
	return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

/** Convert a packed trigram to a human-readable string */
export function trigramToString(packed: number): string {
	const [a, b, c] = unpackTrigram(packed);
	return String.fromCharCode(a, b, c);
}

// ===========================================
// Trigram Extraction
// ===========================================

/**
 * Extract all unique lowercase trigrams from a string.
 * Returns a Set of packed uint32 trigram values.
 */
export function extractTrigrams(content: string): Set<number> {
	const trigrams = new Set<number>();
	const len = content.length;
	if (len < 3) return trigrams;

	// Pre-lowercase the entire content for consistent extraction
	const lower = content.toLowerCase();

	for (let i = 0; i <= len - 3; i++) {
		const c0 = lower.charCodeAt(i);
		const c1 = lower.charCodeAt(i + 1);
		const c2 = lower.charCodeAt(i + 2);

		// Skip trigrams containing control characters (except tab=9, newline=10, CR=13)
		if (isControlChar(c0) || isControlChar(c1) || isControlChar(c2)) continue;

		// Skip non-ASCII trigrams — code search is overwhelmingly ASCII,
		// and clamping (& 0xFF) produces collisions (e.g., CJK chars map
		// to the same byte as Latin-1 chars). Skipping is safe: the index
		// returns more candidates (conservative), never fewer.
		if (c0 > 0x7f || c1 > 0x7f || c2 > 0x7f) continue;

		trigrams.add(packTrigram(c0, c1, c2));
	}

	return trigrams;
}

/**
 * Extract all unique lowercase trigrams with position and next-char masks.
 * Returns a Map: packed trigram → { locMask, nextMask }.
 * Used during build() to populate enhanced posting lists.
 */
/** Bloom bit for the character right after a trigram at position `i`, or 0 if
 *  there is no next character or it's non-ASCII/control (extracted from
 *  extractTrigramsWithMasks to flatten its loop body). */
function nextCharBitAt(lower: string, i: number, len: number): number {
	if (i + 3 >= len) return 0;
	const nc = lower.charCodeAt(i + 3);
	if (nc > 0x7f || isControlChar(nc)) return 0;
	return nextCharBit(nc);
}

export function extractTrigramsWithMasks(
	content: string,
): Map<number, { locMask: number; nextMask: number }> {
	const result = new Map<number, { locMask: number; nextMask: number }>();
	const len = content.length;
	if (len < 3) return result;

	const lower = content.toLowerCase();

	for (let i = 0; i <= len - 3; i++) {
		const c0 = lower.charCodeAt(i);
		const c1 = lower.charCodeAt(i + 1);
		const c2 = lower.charCodeAt(i + 2);

		if (isControlChar(c0) || isControlChar(c1) || isControlChar(c2)) continue;
		if (c0 > 0x7f || c1 > 0x7f || c2 > 0x7f) continue;

		const packed = packTrigram(c0, c1, c2);
		const locBit = 1 << (i & 7); // position mod 8
		const nBit = nextCharBitAt(lower, i, len);

		const existing = result.get(packed);
		if (existing) {
			existing.locMask |= locBit;
			existing.nextMask |= nBit;
		} else {
			result.set(packed, { locMask: locBit, nextMask: nBit });
		}
	}

	return result;
}

export function isControlChar(code: number): boolean {
	return code < 0x09 || (code > 0x0d && code < 0x20);
}

/**
 * Detect binary content by checking for null bytes in the first 8KB.
 */
export function isBinaryContent(content: string | Buffer): boolean {
	const check = typeof content === "string" ? content.slice(0, 8192) : content.subarray(0, 8192);
	if (typeof check === "string") {
		for (let i = 0; i < check.length; i++) {
			if (check.charCodeAt(i) === 0) return true;
		}
	} else {
		for (let i = 0; i < check.length; i++) {
			if (check[i] === 0) return true;
		}
	}
	return false;
}

/** Check if a filename should be skipped based on name/extension */
export function shouldSkipFile(filePath: string): boolean {
	const base = filePath.split("/").pop() || "";
	if (SKIP_BASENAMES.has(base)) return true;
	for (const ext of SKIP_EXTENSIONS) {
		if (base.endsWith(ext)) return true;
	}
	return false;
}

// ===========================================
// Types
// ===========================================

export interface IndexBuildOptions {
	/** Working directory (default: process.cwd()) */
	cwd?: string;
	/** Maximum file size to index in bytes (default: 1MB) */
	maxFileSize?: number;
	/** Trigrams in more than this fraction of files are stop trigrams (default: 0.4) */
	stopThreshold?: number;
	/** Progress callback: (indexed: number, total: number) => void */
	onProgress?: (indexed: number, total: number) => void;
}

export interface IndexStats {
	fileCount: number;
	trigramCount: number;
	stopTrigramCount: number;
	baseCommit: string;
	indexSizeBytes: number;
	builtAt: string;
	/** Breakdown: lookup file size */
	lookupSizeBytes?: number;
	/** Breakdown: postings file size */
	postingsSizeBytes?: number;
	/** Average locMask bits set per posting entry */
	avgLocMaskBits?: number;
	/** Average nextMask bits set per posting entry */
	avgNextMaskBits?: number;
}

/** A posting list with probabilistic masks for adjacency verification */
export interface PostingList {
	/** Sorted array of file IDs containing this trigram */
	fileIds: Uint32Array;
	/** Per-entry bloom filter of positions (mod 8) where trigram appears */
	locMasks: Uint8Array;
	/** Per-entry bloom filter of characters following the trigram */
	nextMasks: Uint8Array;
}

// ===========================================
// Bit / Search Helpers
// ===========================================

/** Binary search in a sorted Uint32Array. Returns index or -1. */
export function binarySearchU32(arr: Uint32Array, target: number): number {
	let lo = 0;
	let hi = arr.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const val = nonNull(arr[mid]);
		if (val < target) lo = mid + 1;
		else if (val > target) hi = mid - 1;
		else return mid;
	}
	return -1;
}

/** Count the number of set bits in a byte */
export function popcount8(v: number): number {
	let n = v & 0xff;
	n = n - ((n >> 1) & 0x55);
	n = (n & 0x33) + ((n >> 2) & 0x33);
	return (n + (n >> 4)) & 0x0f;
}
