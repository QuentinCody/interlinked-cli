// ===========================================
// Bounded file I/O for append-only JSONL logs
// ===========================================
// Large Interlinked logs routinely exceed V8's maximum string length. These
// helpers keep reads and writes below fixed byte ceilings while preserving the
// byte offsets used by sync cursors and compaction manifests.

import { createHash } from "node:crypto";
import { openSync, readSync, statSync } from "node:fs";
import {
	closeFileQuietly,
	FILE_IO_CHUNK_BYTES,
	MAX_CAPTURED_JSONL_LINE_BYTES,
	validateFileRange,
} from "./bounded-file-core.js";

export {
	FILE_IO_CHUNK_BYTES,
	MAX_CAPTURED_JSONL_LINE_BYTES,
	MAX_MATERIALIZED_RANGE_BYTES,
	readFileRange,
} from "./bounded-file-core.js";
export { copyFileRange, gzipFileRange } from "./bounded-file-transfer.js";

const NEWLINE = 0x0a;

/** SHA-256 a file with fixed-size reads. Compaction uses this to prove that a
 * final-named segment left by an interrupted publication is byte-for-byte the
 * segment described by its durable rotation claim before adopting it. */
export function sha256File(
	path: string,
	chunkBytes: number = FILE_IO_CHUNK_BYTES,
): string {
	const fileSize = statSync(path).size;
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, Math.max(1, fileSize))));
	const hash = createHash("sha256");
	let position = 0;
	try {
		while (position < fileSize) {
			const requested = Math.min(buffer.length, fileSize - position);
			const read = readSync(fd, buffer, 0, requested, position);
			if (read <= 0) throw new Error(`file ended while hashing at byte ${position}`);
			hash.update(buffer.subarray(0, read));
			position += read;
		}
		return hash.digest("hex");
	} finally {
		closeFileQuietly(fd);
	}
}

function isAsciiWhitespace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

interface FileLine {
	start: number;
	end: number;
	nextOffset: number;
	complete: boolean;
	nonEmpty: boolean;
	oversized: boolean;
	text?: string;
}

interface ScanFileLinesOptions {
	startOffset?: number;
	endExclusive?: number;
	chunkBytes?: number;
	maxCapturedLineBytes?: number;
	includeFinalLine?: boolean;
}

class LineAccumulator {
	private captured: Buffer[] = [];
	private capturedBytes = 0;
	private nonEmpty = false;
	private oversized = false;

	constructor(
		private lineStart: number,
		private readonly captureLimit: number,
	) {}

	add(piece: Buffer): void {
		if (!this.nonEmpty) {
			for (const byte of piece) {
				if (!isAsciiWhitespace(byte)) {
					this.nonEmpty = true;
					break;
				}
			}
		}
		if (this.captureLimit <= 0 || this.oversized || piece.length === 0) return;
		if (this.capturedBytes + piece.length > this.captureLimit) {
			this.oversized = true;
			this.captured = [];
			this.capturedBytes = 0;
			return;
		}
		this.captured.push(Buffer.from(piece));
		this.capturedBytes += piece.length;
	}

	finish(end: number, nextOffset: number, complete: boolean): FileLine {
		const text =
			this.captureLimit > 0 && !this.oversized
				? Buffer.concat(this.captured, this.capturedBytes).toString("utf8")
				: undefined;
		const line: FileLine = {
			start: this.lineStart,
			end,
			nextOffset,
			complete,
			nonEmpty: this.nonEmpty,
			oversized: this.captureLimit > 0 && this.oversized,
			...(text !== undefined ? { text } : {}),
		};
		this.lineStart = nextOffset;
		this.captured = [];
		this.capturedBytes = 0;
		this.nonEmpty = false;
		this.oversized = false;
		return line;
	}

	start(): number {
		return this.lineStart;
	}
}

function visitLineChunk(
	buffer: Buffer,
	read: number,
	position: number,
	accumulator: LineAccumulator,
	visitor: (line: FileLine) => boolean | void,
): boolean {
	let cursor = 0;
	while (cursor < read) {
		const newline = buffer.indexOf(NEWLINE, cursor);
		if (newline < 0 || newline >= read) {
			accumulator.add(buffer.subarray(cursor, read));
			return true;
		}
		accumulator.add(buffer.subarray(cursor, newline));
		const absoluteNewline = position + newline;
		if (visitor(accumulator.finish(absoluteNewline, absoluteNewline + 1, true)) === false) {
			return false;
		}
		cursor = newline + 1;
	}
	return true;
}

/**
 * Walk newline-delimited records with fixed-size reads. `visitor` may return
 * false to stop immediately after the current record. Oversized lines still
 * report their offsets but never become one enormous JavaScript string.
 */
export function scanFileLines(
	path: string,
	visitor: (line: FileLine) => boolean | void,
	options: ScanFileLinesOptions = {},
): void {
	const fileSize = statSync(path).size;
	const startOffset = options.startOffset ?? 0;
	const endExclusive = Math.min(options.endExclusive ?? fileSize, fileSize);
	validateFileRange(startOffset, endExclusive);
	if (startOffset >= endExclusive) return;

	const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? FILE_IO_CHUNK_BYTES));
	const captureLimit = Math.max(
		0,
		Math.floor(options.maxCapturedLineBytes ?? MAX_CAPTURED_JSONL_LINE_BYTES),
	);
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, endExclusive - startOffset));
	const accumulator = new LineAccumulator(startOffset, captureLimit);
	let position = startOffset;
	let keepGoing = true;
	try {
		while (position < endExclusive && keepGoing) {
			const requested = Math.min(buffer.length, endExclusive - position);
			const read = readSync(fd, buffer, 0, requested, position);
			if (read <= 0) throw new Error(`file ended while scanning at byte ${position}`);
			keepGoing = visitLineChunk(buffer, read, position, accumulator, visitor);
			position += read;
		}
		if (
			keepGoing &&
			(options.includeFinalLine ?? true) &&
			accumulator.start() < endExclusive
		) {
			visitor(accumulator.finish(endExclusive, endExclusive, false));
		}
	} finally {
		closeFileQuietly(fd);
	}
}

/** Exact non-blank JSONL line count without constructing any line strings. */
export function countNonEmptyFileLines(
	path: string,
	chunkBytes: number = FILE_IO_CHUNK_BYTES,
): number {
	let count = 0;
	scanFileLines(
		path,
		(line) => {
			if (line.nonEmpty) count++;
		},
		{ chunkBytes, maxCapturedLineBytes: 0 },
	);
	return count;
}

/** First complete non-blank line, bounded by `maxBytes`; undefined if absent/oversized. */
export function readFirstNonEmptyFileLine(
	path: string,
	maxBytes: number = MAX_CAPTURED_JSONL_LINE_BYTES,
): string | undefined {
	const fileSize = statSync(path).size;
	const endExclusive = Math.min(fileSize, maxBytes);
	let first: string | undefined;
	scanFileLines(
		path,
		(line) => {
			if (!line.nonEmpty) return;
			if (line.complete || endExclusive === fileSize) first = line.text;
			return false;
		},
		{
			endExclusive,
			maxCapturedLineBytes: maxBytes,
			includeFinalLine: endExclusive === fileSize,
		},
	);
	return first;
}

interface LineBoundary {
	offset: number;
	records: number;
}

/** Largest newline boundary at/before `limit`, plus physical records before it. */
export function findLineBoundaryAtOrBefore(
	path: string,
	limit: number,
	allowEofBoundary: boolean,
): LineBoundary {
	const fileSize = statSync(path).size;
	const endExclusive = Math.max(0, Math.min(fileSize, Math.floor(limit)));
	let offset = 0;
	let seen = 0;
	let records = 0;
	if (endExclusive <= 0) return { offset, records };
	scanFileLines(
		path,
		(line) => {
			if (!line.complete) return;
			seen++;
			if (line.nextOffset <= endExclusive && (allowEofBoundary || line.nextOffset < fileSize)) {
				offset = line.nextOffset;
				records = seen;
			}
		},
		{ endExclusive, maxCapturedLineBytes: 0, includeFinalLine: false },
	);
	return { offset, records };
}

interface TailScanState {
	/** Whether the record after the byte under inspection has any non-blank content. */
	nonEmpty: boolean;
	/** Non-blank records counted so far, scanning backwards from EOF. */
	found: number;
}

/**
 * Scans one chunk backwards, counting non-blank records into `state`.
 * Returns the chunk-relative start offset of the `maxLines`-th record, or -1 if not reached.
 */
function scanChunkBackwardForTailStart(
	chunk: Buffer,
	length: number,
	state: TailScanState,
	maxLines: number,
): number {
	for (let i = length - 1; i >= 0; i--) {
		const byte = chunk[i] as number;
		if (byte !== NEWLINE) {
			if (!isAsciiWhitespace(byte)) state.nonEmpty = true;
			continue;
		}
		if (state.nonEmpty && ++state.found >= maxLines) return i + 1;
		state.nonEmpty = false;
	}
	return -1;
}

/** Byte offset that retains the final `maxLines` non-blank records. */
export function findTailStartForLines(
	path: string,
	maxLines: number,
	chunkBytes: number = FILE_IO_CHUNK_BYTES,
): number {
	if (maxLines <= 0) return statSync(path).size;
	const fileSize = statSync(path).size;
	if (fileSize <= 0) return 0;
	const fd = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(Math.min(Math.max(1, chunkBytes), fileSize));
	let position = fileSize;
	const state: TailScanState = { nonEmpty: false, found: 0 };
	try {
		while (position > 0) {
			const requested = Math.min(buffer.length, position);
			position -= requested;
			const read = readSync(fd, buffer, 0, requested, position);
			if (read !== requested) throw new Error(`short read while scanning tail at byte ${position}`);
			const tailStart = scanChunkBackwardForTailStart(buffer, read, state, maxLines);
			if (tailStart >= 0) return position + tailStart;
		}
		return 0;
	} finally {
		closeFileQuietly(fd);
	}
}
