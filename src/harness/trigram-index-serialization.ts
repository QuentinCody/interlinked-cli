// ===========================================
// Trigram Index — Serialization (Two-File v2 Format)
// ===========================================
// Extracted from ./trigram-index.ts to keep that file under the per-file
// line cap. These are free functions that take the TrigramIndex instance
// fields they operate on as EXPLICIT parameters; the corresponding class
// methods (save / load / loadMeta / stats) are thin delegates. Behavior is
// identical to the original inline implementations — code was moved, not
// changed.
//
// This module imports only types/primitives from ./trigram-primitives.js
// (never from ./trigram-index.js) so there is no runtime import cycle.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import {
	FLAG_LOWERCASE,
	FLAG_MASKS,
	fnv1a,
	INDEX_DIR_NAME,
	type IndexStats,
	LEGACY_INDEX_FILE_NAME,
	LOOKUP_FILE_NAME,
	MAGIC_LOOKUP,
	META_FILE_NAME,
	POSTINGS_FILE_NAME,
	type PostingList,
	popcount8,
	VERSION,
} from "./trigram-primitives.js";

/** Parsed index data produced by {@link loadIndex}, ready for the TrigramIndex constructor. */
interface ParsedIndexData {
	files: string[];
	postings: Map<number, PostingList>;
	stopTrigrams: Set<number>;
	baseCommit: string;
	builtAt: string;
}

/** Encode one posting list's file-id/loc-mask/next-mask triples into its packed 6-byte-per-entry buffer. */
function encodePostingEntry(posting: PostingList): Buffer {
	const count = posting.fileIds.length;
	const entryBuf = Buffer.alloc(count * 6);
	for (const [i, fileId] of posting.fileIds.entries()) {
		entryBuf.writeUInt32LE(fileId, i * 6);
		entryBuf.writeUInt8(nonNull(posting.locMasks[i]), i * 6 + 4);
		entryBuf.writeUInt8(nonNull(posting.nextMasks[i]), i * 6 + 5);
	}
	return entryBuf;
}

/**
 * Save the index to disk in .interlinked/index/.
 *
 * Two-file format:
 *   trigram.lookup  — header, file table, stop trigrams, sorted lookup entries
 *   trigram.postings — sequential posting entries (6 bytes each)
 *   meta.json — quick-access statistics
 *
 * The caller is responsible for merging the dirty layer (mergeDirty) before
 * invoking this so a complete snapshot is written.
 */
export function saveIndex(
	files: string[],
	postings: Map<number, PostingList>,
	stopTrigrams: Set<number>,
	baseCommit: string,
	builtAt: string,
	cwd: string,
	interlinkedDir?: string,
): void {
	const dir = interlinkedDir || join(cwd, ".interlinked");
	const indexDir = join(dir, INDEX_DIR_NAME);
	if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });

	// Sort trigrams by FNV-1a hash for lookup table
	const sortedEntries: Array<{
		packed: number;
		hash: number;
		posting: PostingList;
	}> = [];
	for (const [packed, posting] of postings) {
		sortedEntries.push({ packed, hash: fnv1a(packed), posting });
	}
	sortedEntries.sort((a, b) => {
		if (a.hash < b.hash) return -1;
		if (a.hash > b.hash) return 1;
		return 0;
	});

	// --- Build postings file ---
	const postingsChunks: Buffer[] = [];
	let totalPostings = 0;
	let currentOffset = 0;
	const lookupData: Array<{
		hash: number;
		packed: number;
		offset: number;
		count: number;
	}> = [];

	for (const entry of sortedEntries) {
		const count = entry.posting.fileIds.length;
		const entryBuf = encodePostingEntry(entry.posting);
		postingsChunks.push(entryBuf);

		lookupData.push({
			hash: entry.hash,
			packed: entry.packed,
			offset: currentOffset,
			count,
		});
		currentOffset += count * 6;
		totalPostings += count;
	}

	const postingsBuf = Buffer.concat(postingsChunks);
	writeFileSync(join(indexDir, POSTINGS_FILE_NAME), postingsBuf);

	// --- Build lookup file ---
	const lookupChunks: Buffer[] = [];

	// Header (28 bytes)
	const header = Buffer.alloc(28);
	header.writeUInt32LE(MAGIC_LOOKUP, 0);
	header.writeUInt32LE(VERSION, 4);
	header.writeUInt32LE(FLAG_LOWERCASE | FLAG_MASKS, 8);
	header.writeUInt32LE(files.length, 12);
	header.writeUInt32LE(postings.size, 16);
	header.writeUInt32LE(stopTrigrams.size, 20);
	header.writeUInt32LE(0, 24); // reserved
	lookupChunks.push(header);

	// Meta: base commit + builtAt
	const commitBuf = Buffer.from(baseCommit, "utf-8");
	const builtAtBuf = Buffer.from(builtAt, "utf-8");
	const metaBuf = Buffer.alloc(2 + commitBuf.length + builtAtBuf.length);
	metaBuf.writeUInt8(commitBuf.length, 0);
	commitBuf.copy(metaBuf, 1);
	metaBuf.writeUInt8(builtAtBuf.length, 1 + commitBuf.length);
	builtAtBuf.copy(metaBuf, 2 + commitBuf.length);
	lookupChunks.push(metaBuf);

	// File table
	for (const filePath of files) {
		const pathBuf = Buffer.from(filePath, "utf-8");
		const entry = Buffer.alloc(2 + pathBuf.length);
		entry.writeUInt16LE(pathBuf.length, 0);
		pathBuf.copy(entry, 2);
		lookupChunks.push(entry);
	}

	// Stop trigrams (sorted for deterministic output)
	const sortedStops = [...stopTrigrams].sort((a, b) => a - b);
	const stopBuf = Buffer.alloc(sortedStops.length * 4);
	for (const [i, stop] of sortedStops.entries()) {
		stopBuf.writeUInt32LE(stop, i * 4);
	}
	lookupChunks.push(stopBuf);

	// Lookup table entries (sorted by hash): [hash(4) + packed(4) + offset(4) + count(4)]
	const lookupTableBuf = Buffer.alloc(lookupData.length * 16);
	for (const [i, e] of lookupData.entries()) {
		lookupTableBuf.writeUInt32LE(e.hash, i * 16);
		lookupTableBuf.writeUInt32LE(e.packed, i * 16 + 4);
		lookupTableBuf.writeUInt32LE(e.offset, i * 16 + 8);
		lookupTableBuf.writeUInt32LE(e.count, i * 16 + 12);
	}
	lookupChunks.push(lookupTableBuf);

	const lookupBuf = Buffer.concat(lookupChunks);
	writeFileSync(join(indexDir, LOOKUP_FILE_NAME), lookupBuf);

	// --- Metadata JSON ---
	// Compute average mask saturation
	let totalLocBits = 0;
	let totalNextBits = 0;
	for (const posting of postings.values()) {
		for (const [i, locMask] of posting.locMasks.entries()) {
			totalLocBits += popcount8(locMask);
			totalNextBits += popcount8(nonNull(posting.nextMasks[i]));
		}
	}

	const meta: IndexStats = {
		fileCount: files.length,
		trigramCount: postings.size,
		stopTrigramCount: stopTrigrams.size,
		baseCommit: baseCommit,
		indexSizeBytes: lookupBuf.length + postingsBuf.length,
		builtAt: builtAt,
		lookupSizeBytes: lookupBuf.length,
		postingsSizeBytes: postingsBuf.length,
		avgLocMaskBits: totalPostings > 0 ? totalLocBits / totalPostings : 0,
		avgNextMaskBits: totalPostings > 0 ? totalNextBits / totalPostings : 0,
	};
	writeFileSync(join(indexDir, META_FILE_NAME), JSON.stringify(meta, null, 2));

	// Clean up legacy v1 file
	try {
		const legacyPath = join(indexDir, LEGACY_INDEX_FILE_NAME);
		if (existsSync(legacyPath)) {
			unlinkSync(legacyPath);
		}
	} catch (err) {
		void err; /* intentional: legacy file cleanup is non-fatal */
	}
}

/**
 * Load an index from disk.
 * Reads the v2 two-file format (trigram.lookup + trigram.postings).
 * Returns null if no v2 index found.
 *
 * Returns parsed data; the caller constructs the TrigramIndex.
 */
export function loadIndex(cwd: string, interlinkedDir?: string): ParsedIndexData | null {
	const dir = interlinkedDir || join(cwd, ".interlinked");
	const lookupPath = join(dir, INDEX_DIR_NAME, LOOKUP_FILE_NAME);
	const postingsPath = join(dir, INDEX_DIR_NAME, POSTINGS_FILE_NAME);

	if (!existsSync(lookupPath) || !existsSync(postingsPath)) return null;

	let lookupBuf: Buffer;
	let postingsBuf: Buffer;
	try {
		lookupBuf = readFileSync(lookupPath);
		postingsBuf = readFileSync(postingsPath);
	} catch {
		return null;
	}

	if (lookupBuf.length < 28) return null;

	const cursor: ReadCursor = { offset: 0 };

	const header = readLookupHeader(lookupBuf, cursor);
	if (header === null) return null;

	const meta = readLookupMeta(lookupBuf, cursor);
	if (meta === null) return null;

	const files = readFileTable(lookupBuf, cursor, header.fileCount);
	if (files === null) return null;

	const stopTrigrams = readStopTrigrams(lookupBuf, cursor, header.stopCount);
	if (stopTrigrams === null) return null;

	const postings = readPostings(lookupBuf, postingsBuf, cursor, header.trigramCount);
	if (postings === null) return null;

	return { files, postings, stopTrigrams, baseCommit: meta.baseCommit, builtAt: meta.builtAt };
}

/** Mutable read position shared by the {@link loadIndex} section readers. */
interface ReadCursor {
	offset: number;
}

/** Fixed-size lookup-file header counts. */
interface LookupHeader {
	fileCount: number;
	trigramCount: number;
	stopCount: number;
}

/** Read the 28-byte lookup header; null when magic or version does not match. */
function readLookupHeader(lookupBuf: Buffer, cursor: ReadCursor): LookupHeader | null {
	const magic = lookupBuf.readUInt32LE(cursor.offset);
	cursor.offset += 4;
	if (magic !== MAGIC_LOOKUP) return null;

	const version = lookupBuf.readUInt32LE(cursor.offset);
	cursor.offset += 4;
	if (version !== VERSION) return null;

	cursor.offset += 4; // flags — reserved, not read

	const fileCount = lookupBuf.readUInt32LE(cursor.offset);
	cursor.offset += 4;

	const trigramCount = lookupBuf.readUInt32LE(cursor.offset);
	cursor.offset += 4;

	const stopCount = lookupBuf.readUInt32LE(cursor.offset);
	cursor.offset += 4;

	cursor.offset += 4; // reserved — not read

	return { fileCount, trigramCount, stopCount };
}

/** Read the base-commit / builtAt meta strings that follow the header. */
function readLookupMeta(
	lookupBuf: Buffer,
	cursor: ReadCursor,
): { baseCommit: string; builtAt: string } | null {
	if (cursor.offset >= lookupBuf.length) return null;
	const commitLen = lookupBuf.readUInt8(cursor.offset);
	cursor.offset += 1;
	if (cursor.offset + commitLen > lookupBuf.length) return null;
	const baseCommit = lookupBuf.toString("utf-8", cursor.offset, cursor.offset + commitLen);
	cursor.offset += commitLen;

	let builtAt = new Date().toISOString();
	if (cursor.offset < lookupBuf.length) {
		const builtAtLen = lookupBuf.readUInt8(cursor.offset);
		cursor.offset += 1;
		if (cursor.offset + builtAtLen <= lookupBuf.length) {
			builtAt = lookupBuf.toString("utf-8", cursor.offset, cursor.offset + builtAtLen);
			cursor.offset += builtAtLen;
		}
	}

	return { baseCommit, builtAt };
}

/** Read the length-prefixed file-path table. */
function readFileTable(
	lookupBuf: Buffer,
	cursor: ReadCursor,
	fileCount: number,
): string[] | null {
	const files: string[] = [];
	for (let i = 0; i < fileCount; i++) {
		if (cursor.offset + 2 > lookupBuf.length) return null;
		const pathLen = lookupBuf.readUInt16LE(cursor.offset);
		cursor.offset += 2;
		if (cursor.offset + pathLen > lookupBuf.length) return null;
		files.push(lookupBuf.toString("utf-8", cursor.offset, cursor.offset + pathLen));
		cursor.offset += pathLen;
	}
	return files;
}

/** Read the stop-trigram set. */
function readStopTrigrams(
	lookupBuf: Buffer,
	cursor: ReadCursor,
	stopCount: number,
): Set<number> | null {
	const stopTrigrams = new Set<number>();
	for (let i = 0; i < stopCount; i++) {
		if (cursor.offset + 4 > lookupBuf.length) return null;
		stopTrigrams.add(lookupBuf.readUInt32LE(cursor.offset));
		cursor.offset += 4;
	}
	return stopTrigrams;
}

/** Read one posting list's entries out of the postings file. */
function readPostingEntries(
	postingsBuf: Buffer,
	postingOffset: number,
	count: number,
): PostingList | null {
	if (postingOffset + count * 6 > postingsBuf.length) return null;
	const fileIds = new Uint32Array(count);
	const locMasks = new Uint8Array(count);
	const nextMasks = new Uint8Array(count);
	for (let j = 0; j < count; j++) {
		const entryOffset = postingOffset + j * 6;
		fileIds[j] = postingsBuf.readUInt32LE(entryOffset);
		locMasks[j] = postingsBuf.readUInt8(entryOffset + 4);
		nextMasks[j] = postingsBuf.readUInt8(entryOffset + 5);
	}
	return { fileIds, locMasks, nextMasks };
}

/** Walk the lookup table entries and reconstruct postings from the postings file. */
function readPostings(
	lookupBuf: Buffer,
	postingsBuf: Buffer,
	cursor: ReadCursor,
	trigramCount: number,
): Map<number, PostingList> | null {
	const postings = new Map<number, PostingList>();
	for (let i = 0; i < trigramCount; i++) {
		if (cursor.offset + 16 > lookupBuf.length) return null;
		cursor.offset += 4; // hash — not read; packed lookup entry below carries the trigram key
		const packed = lookupBuf.readUInt32LE(cursor.offset);
		cursor.offset += 4;
		const postingOffset = lookupBuf.readUInt32LE(cursor.offset);
		cursor.offset += 4;
		const count = lookupBuf.readUInt32LE(cursor.offset);
		cursor.offset += 4;

		const posting = readPostingEntries(postingsBuf, postingOffset, count);
		if (posting === null) return null;
		postings.set(packed, posting);
	}
	return postings;
}

/**
 * Load just the metadata without parsing the full index.
 */
export function loadIndexMeta(cwd: string, interlinkedDir?: string): IndexStats | null {
	const dir = interlinkedDir || join(cwd, ".interlinked");
	const metaPath = join(dir, INDEX_DIR_NAME, META_FILE_NAME);
	try {
		return JSON.parse(readFileSync(metaPath, "utf-8"));
	} catch {
		return null;
	}
}

/** Compute index statistics from the in-memory index state. */
export function computeIndexStats(
	files: string[],
	postings: Map<number, PostingList>,
	stopTrigrams: Set<number>,
	baseCommit: string,
	builtAt: string,
): IndexStats {
	let lookupSizeBytes = 28; // header
	for (const f of files) lookupSizeBytes += 2 + Buffer.byteLength(f);
	lookupSizeBytes += stopTrigrams.size * 4;
	lookupSizeBytes += postings.size * 16; // lookup table entries

	let postingsSizeBytes = 0;
	let totalPostings = 0;
	let totalLocBits = 0;
	let totalNextBits = 0;
	for (const posting of postings.values()) {
		postingsSizeBytes += posting.fileIds.length * 6;
		totalPostings += posting.fileIds.length;
		for (const [i, locMask] of posting.locMasks.entries()) {
			totalLocBits += popcount8(locMask);
			totalNextBits += popcount8(nonNull(posting.nextMasks[i]));
		}
	}

	return {
		fileCount: files.length,
		trigramCount: postings.size,
		stopTrigramCount: stopTrigrams.size,
		baseCommit: baseCommit,
		indexSizeBytes: lookupSizeBytes + postingsSizeBytes,
		builtAt: builtAt,
		lookupSizeBytes,
		postingsSizeBytes,
		avgLocMaskBits: totalPostings > 0 ? totalLocBits / totalPostings : 0,
		avgNextMaskBits: totalPostings > 0 ? totalNextBits / totalPostings : 0,
	};
}
