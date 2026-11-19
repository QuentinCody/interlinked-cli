import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from "node:fs";

export const FILE_IO_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_MATERIALIZED_RANGE_BYTES = 16 * 1024 * 1024;
export const MAX_CAPTURED_JSONL_LINE_BYTES = 4 * 1024 * 1024;

export function closeFileQuietly(fd: number): void {
	try {
		closeSync(fd);
	} catch (error) {
		// The completed read/write result is more useful than a close error.
		void error;
	}
}

export function writeBufferFully(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		const written = writeSync(fd, data, offset, data.length - offset);
		if (written <= 0) throw new Error("write returned zero bytes");
		offset += written;
	}
}

export function validateFileRange(start: number, endExclusive: number): void {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive)) {
		throw new RangeError("file range offsets must be safe integers");
	}
	if (start < 0 || endExclusive < start) {
		throw new RangeError(`invalid file range [${start}, ${endExclusive})`);
	}
}

/** Read one explicitly bounded range, retrying short positional reads. */
export function readFileRange(
	path: string,
	start: number,
	endExclusive: number,
	maxBytes: number = MAX_MATERIALIZED_RANGE_BYTES,
): Buffer {
	validateFileRange(start, endExclusive);
	const length = endExclusive - start;
	if (length > maxBytes) {
		throw new RangeError(`refusing to materialize ${length} bytes (limit ${maxBytes})`);
	}
	const data = Buffer.allocUnsafe(length);
	const fd = openSync(path, "r");
	let offset = 0;
	try {
		while (offset < length) {
			const read = readSync(fd, data, offset, length - offset, start + offset);
			if (read <= 0) {
				throw new Error(`file ended while reading range [${start}, ${endExclusive})`);
			}
			offset += read;
		}
		return data;
	} finally {
		closeFileQuietly(fd);
	}
}

/** Read one bounded regular file. A size change during the read makes this observation unavailable. */
export function readBoundedTextFile(path: string, byteLimit: number): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > byteLimit) return null;
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let total = 0;
		while (total < buffer.length) {
			const bytes = readSync(fd, buffer, total, buffer.length - total, total);
			if (bytes === 0) break;
			total += bytes;
		}
		return total === stat.size ? buffer.toString("utf8", 0, total) : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeFileQuietly(fd);
	}
}
