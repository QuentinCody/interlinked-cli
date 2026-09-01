// Bounded archived/live line readers for audit-chain verification.

import {
	closeSync,
	createReadStream,
	existsSync,
	openSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
import { createGunzip, gunzipSync } from "node:zlib";
import { getDataDir } from "./config.js";

const READ_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_ARCHIVE_BYTES = 16 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_AUDIT_LINE_BYTES = 16 * 1024 * 1024;

function assertAuditLineLength(bytes: number): void {
	if (bytes > MAX_AUDIT_LINE_BYTES) {
		throw new RangeError(`audit line exceeds ${MAX_AUDIT_LINE_BYTES} bytes`);
	}
}

interface ArchivedSegmentPointer {
	file: string;
	path: string;
}

function readBoundedFileSync(path: string, maxBytes: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const bounded = Buffer.allocUnsafe(maxBytes + 1);
		let offset = 0;
		while (offset < bounded.length) {
			const read = readSync(fd, bounded, offset, bounded.length - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		if (offset > maxBytes) {
			throw new RangeError(`compressed segment exceeds ${maxBytes} bytes`);
		}
		return bounded.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

/** Evidence the verifier was supposed to read and could not. */
export class ArchiveEvidenceError extends Error {}

class ManifestReadError extends ArchiveEvidenceError {
	constructor(
		readonly manifest: string,
		cause: unknown,
		options: ErrorOptions = { cause },
	) {
		super(
			`archive manifest ${manifest} unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
			options,
		);
	}
}

class SegmentReadError extends ArchiveEvidenceError {
	constructor(
		readonly segment: string,
		cause: unknown,
		options: ErrorOptions = { cause },
	) {
		super(
			`archive segment ${segment} unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
			options,
		);
	}
}

function* iterateBufferLines(buffer: Buffer): Generator<string> {
	let start = 0;
	for (let index = 0; index < buffer.length; index++) {
		if (buffer[index] !== 0x0a) continue;
		yield buffer.toString("utf-8", start, index);
		start = index + 1;
	}
	if (start < buffer.length) yield buffer.toString("utf-8", start);
}

/** Stream a file's lines via bounded chunk reads. */
export function* iterateFileLines(
	path: string,
	chunkBytes: number = READ_CHUNK_BYTES,
): Generator<string> {
	const fd = openSync(path, "r");
	try {
		const chunk = Buffer.allocUnsafe(chunkBytes);
		let carry = Buffer.alloc(0);
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read <= 0) break;
			const data = Buffer.concat([carry, chunk.subarray(0, read)]);
			let start = 0;
			for (let index = 0; index < data.length; index++) {
				if (data[index] !== 0x0a) continue;
				assertAuditLineLength(index - start);
				yield data.toString("utf-8", start, index);
				start = index + 1;
			}
			carry = data.subarray(start);
			assertAuditLineLength(carry.length);
		}
		if (carry.length > 0) yield carry.toString("utf-8");
	} finally {
		closeSync(fd);
	}
}

/** SAFETY: manifest.json is disk-controlled JSON — its shape is `unknown` at
 *  compile time regardless of what a naive type annotation would claim, so
 *  every field is narrowed with `typeof`/`Array.isArray` before use. */
function auditSegmentSeq(segment: unknown): number {
	if (segment === null || typeof segment !== "object") return 0;
	const seq = (segment as { seq?: unknown }).seq;
	return typeof seq === "number" ? seq : 0;
}

function readArchivedSegmentPointers(cwd: string): ArchivedSegmentPointer[] {
	const dir = join(getDataDir(cwd), "archive");
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) return [];
	// JSON.parse's result is `unknown` in substance no matter what shape we'd
	// like it to be — a hand-edited or corrupted manifest can hand back
	// anything, so `parsed` stays unknown and every field below is narrowed
	// before use instead of trusted from a declared type.
	let parsed: unknown;
	try {
		const manifest = readBoundedFileSync(manifestPath, MAX_SYNC_ARCHIVE_BYTES);
		parsed = JSON.parse(manifest.toString("utf-8"));
	} catch (error) {
		throw new ManifestReadError(manifestPath, error, { cause: error });
	}
	// SAFETY: parsed is unknown disk-controlled JSON; narrowed via typeof
	// before the field read.
	const segmentsField =
		parsed !== null && typeof parsed === "object"
			? (parsed as { segments?: unknown }).segments
			: undefined;
	if (!Array.isArray(segmentsField)) {
		throw new ManifestReadError(manifestPath, "segments is not an array");
	}
	const segments = [...segmentsField].sort((a: unknown, b: unknown) => auditSegmentSeq(a) - auditSegmentSeq(b));
	return segments.map((segment, index) => {
		// SAFETY: segment is unknown disk-controlled JSON; narrowed via typeof
		// before the field read.
		const file =
			segment !== null && typeof segment === "object"
				? (segment as { file?: unknown }).file
				: undefined;
		if (typeof file !== "string") {
			throw new ManifestReadError(manifestPath, `segment entry ${index} has no file`);
		}
		return { file, path: join(dir, file) };
	});
}

function* iterateArchivedAuditLines(cwd: string): Generator<string> {
	for (const segment of readArchivedSegmentPointers(cwd)) {
		let unzipped: Buffer;
		try {
			const compressed = readBoundedFileSync(segment.path, MAX_SYNC_ARCHIVE_BYTES);
			unzipped = gunzipSync(compressed, { maxOutputLength: MAX_SYNC_ARCHIVE_BYTES });
		} catch (error) {
			throw new SegmentReadError(segment.file, error, { cause: error });
		}
		for (const line of iterateBufferLines(unzipped)) {
			if (line.trim()) yield line;
		}
	}
}

async function* iterateReadableLines(
	readable: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
	let carry = Buffer.alloc(0);
	for await (const value of readable) {
		const chunk = typeof value === "string" ? Buffer.from(value) : value;
		const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
		let start = 0;
		for (let index = 0; index < data.length; index++) {
			if (data[index] !== 0x0a) continue;
			assertAuditLineLength(index - start);
			yield data.toString("utf-8", start, index);
			start = index + 1;
		}
		carry = Buffer.from(data.subarray(start));
		assertAuditLineLength(carry.length);
	}
	if (carry.length > 0) yield carry.toString("utf-8");
}

async function* iterateGzipFileLines(path: string): AsyncGenerator<string> {
	const source = createReadStream(path, { highWaterMark: STREAM_CHUNK_BYTES });
	const gunzip = createGunzip({ chunkSize: STREAM_CHUNK_BYTES });
	const forwardSourceError = (error: Error): void => {
		gunzip.destroy(error);
	};
	source.once("error", forwardSourceError);
	source.pipe(gunzip);
	try {
		for await (const line of iterateReadableLines(gunzip)) yield line;
	} finally {
		source.off("error", forwardSourceError);
		source.destroy();
		gunzip.destroy();
	}
}

async function* iteratePlainFileLines(path: string): AsyncGenerator<string> {
	const source = createReadStream(path, { highWaterMark: STREAM_CHUNK_BYTES });
	try {
		for await (const line of iterateReadableLines(source)) yield line;
	} finally {
		source.destroy();
	}
}

async function* iterateArchivedAuditLinesStreaming(cwd: string): AsyncGenerator<string> {
	for (const segment of readArchivedSegmentPointers(cwd)) {
		try {
			for await (const line of iterateGzipFileLines(segment.path)) {
				if (line.trim()) yield line;
			}
		} catch (error) {
			throw new SegmentReadError(segment.file, error, { cause: error });
		}
	}
}

export function* iterateAllAuditLines(cwd: string, livePath: string): Generator<string> {
	yield* iterateArchivedAuditLines(cwd);
	if (existsSync(livePath)) yield* iterateFileLines(livePath);
}

export async function* iterateAllAuditLinesStreaming(
	cwd: string,
	livePath: string,
): AsyncGenerator<string> {
	yield* iterateArchivedAuditLinesStreaming(cwd);
	if (existsSync(livePath)) yield* iteratePlainFileLines(livePath);
}
