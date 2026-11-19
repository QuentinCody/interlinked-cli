// Bounded copy/compression operations for exact file ranges.

import {
	chmodSync,
	openSync,
	readSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import {
	closeFileQuietly,
	FILE_IO_CHUNK_BYTES,
	MAX_MATERIALIZED_RANGE_BYTES,
	readFileRange,
	validateFileRange,
	writeBufferFully,
} from "./bounded-file-core.js";

export interface GzipRangeResult {
	claimed: boolean;
	gzipBytes: number;
}

function gzipLargeRange(
	path: string,
	start: number,
	endExclusive: number,
	destinationFd: number | null,
	chunkBytes: number,
): number {
	const buffer = Buffer.allocUnsafe(Math.min(Math.max(1, chunkBytes), endExclusive - start));
	const sourceFd = openSync(path, "r");
	let position = start;
	let gzipBytes = 0;
	try {
		while (position < endExclusive) {
			const requested = Math.min(buffer.length, endExclusive - position);
			const read = readSync(sourceFd, buffer, 0, requested, position);
			if (read <= 0) throw new Error(`file ended while compressing at byte ${position}`);
			const compressed = gzipSync(buffer.subarray(0, read));
			if (destinationFd !== null) writeBufferFully(destinationFd, compressed);
			gzipBytes += compressed.length;
			position += read;
		}
		return gzipBytes;
	} finally {
		closeFileQuietly(sourceFd);
	}
}

function claimDestination(path: string | undefined, mode: number): number | null | false {
	if (!path) return null;
	try {
		return openSync(path, "wx", mode);
	} catch (error) {
		// SAFETY: Node filesystem failures expose the optional POSIX error code
		// through the documented NodeJS.ErrnoException shape.
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

function finishDestinationClaim(
	fd: number | null,
	path: string | undefined,
	completed: boolean,
): void {
	if (fd === null) return;
	closeFileQuietly(fd);
	if (completed || !path) return;
	try {
		unlinkSync(path);
	} catch (error) {
		// SAFETY: Node filesystem failures expose the optional POSIX error code
		// through the documented NodeJS.ErrnoException shape.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Gzip a byte range without holding it all in memory. */
export function gzipFileRange(
	path: string,
	start: number,
	endExclusive: number,
	destinationPath?: string,
	chunkBytes: number = FILE_IO_CHUNK_BYTES,
): GzipRangeResult {
	validateFileRange(start, endExclusive);
	const length = endExclusive - start;
	const sourceMode = statSync(path).mode & 0o7777;
	if (length <= MAX_MATERIALIZED_RANGE_BYTES) {
		const compressed = gzipSync(readFileRange(path, start, endExclusive));
		if (destinationPath) {
			try {
				writeFileSync(destinationPath, compressed, { flag: "wx", mode: sourceMode });
				chmodSync(destinationPath, sourceMode);
			} catch (error) {
				// SAFETY: Node filesystem failures expose the optional POSIX error code
				// through the documented NodeJS.ErrnoException shape.
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					return { claimed: false, gzipBytes: 0 };
				}
				throw error;
			}
		}
		return { claimed: true, gzipBytes: compressed.length };
	}

	const destinationFd = claimDestination(destinationPath, sourceMode);
	if (destinationFd === false) return { claimed: false, gzipBytes: 0 };
	let completed = false;
	try {
		const result = {
			claimed: true,
			gzipBytes: gzipLargeRange(path, start, endExclusive, destinationFd, chunkBytes),
		};
		if (destinationPath) chmodSync(destinationPath, sourceMode);
		completed = true;
		return result;
	} finally {
		finishDestinationClaim(destinationFd, destinationPath, completed);
	}
}

function copyLargeRange(
	sourcePath: string,
	destinationPath: string,
	start: number,
	endExclusive: number,
	chunkBytes: number,
	sourceMode: number,
): void {
	const buffer = Buffer.allocUnsafe(Math.min(Math.max(1, chunkBytes), endExclusive - start));
	const sourceFd = openSync(sourcePath, "r");
	let destinationFd: number | null = null;
	let position = start;
	try {
		destinationFd = openSync(destinationPath, "w", sourceMode);
		while (position < endExclusive) {
			const requested = Math.min(buffer.length, endExclusive - position);
			const read = readSync(sourceFd, buffer, 0, requested, position);
			if (read <= 0) throw new Error(`file ended while copying at byte ${position}`);
			writeBufferFully(destinationFd, buffer.subarray(0, read));
			position += read;
		}
	} finally {
		closeFileQuietly(sourceFd);
		if (destinationFd !== null) closeFileQuietly(destinationFd);
	}
}

/** Copy an exact range to a new path with bounded memory. */
export function copyFileRange(
	sourcePath: string,
	destinationPath: string,
	start: number,
	endExclusive: number,
	chunkBytes: number = FILE_IO_CHUNK_BYTES,
): void {
	validateFileRange(start, endExclusive);
	const length = endExclusive - start;
	const sourceMode = statSync(sourcePath).mode & 0o7777;
	if (length <= MAX_MATERIALIZED_RANGE_BYTES) {
		writeFileSync(destinationPath, readFileRange(sourcePath, start, endExclusive), {
			mode: sourceMode,
		});
		chmodSync(destinationPath, sourceMode);
		return;
	}
	copyLargeRange(sourcePath, destinationPath, start, endExclusive, chunkBytes, sourceMode);
	chmodSync(destinationPath, sourceMode);
}
