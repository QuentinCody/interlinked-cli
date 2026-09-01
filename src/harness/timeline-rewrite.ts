// Bounded, concurrent-safe whole-file timeline reconstruction.

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	MAX_CAPTURED_JSONL_LINE_BYTES,
	readFileRange,
	scanFileLines,
} from "../lib/bounded-file-io.js";
import { sameFileIdentity, type FileIdentity } from "../lib/file-suffix-replacement.js";
import { assertNoPendingFileRotation } from "../lib/file-rotation-fence.js";
import { withFileMutationLock } from "../lib/file-mutation-lock.js";
import { isJsonObject } from "../lib/json-types.js";
import {
	dedupeTimeline,
	serializeRecord,
	sortTimeline,
	timelinePath,
} from "./timeline-record-utils.js";
import type { TimelineRecord } from "./transcript-record.js";

export const MAX_TIMELINE_REWRITE_CATCHUP_BYTES = 4 * 1024 * 1024;
export const MAX_TIMELINE_REWRITE_CATCHUPS = 8;
export const MAX_TIMELINE_REWRITE_BYTES = 64 * 1024 * 1024;
export const MAX_TIMELINE_REWRITE_RECORDS = 250_000;

export interface TimelineRewriteBasis {
	identity: FileIdentity | null;
	eof: number;
	mode: number | null;
}

interface TimelineRewriteOptions {
	afterBasisCaptured?: (() => void) | undefined;
}

export class TimelineRewriteConflictError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TimelineRewriteConflictError";
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

export function captureTimelineBasis(path: string): TimelineRewriteBasis {
	try {
		const stat = statSync(path);
		return {
			identity: { dev: stat.dev.toString(), ino: stat.ino.toString() },
			eof: stat.size,
			mode: stat.mode,
		};
	} catch (error) {
		if (isMissingFileError(error)) return { identity: null, eof: 0, mode: null };
		throw error;
	}
}

function isTimelineRecord(value: unknown): value is TimelineRecord {
	return (
		isJsonObject(value) &&
		value.schema === "timeline.v1" &&
		typeof value.ts === "string" &&
		typeof value.session === "string" &&
		typeof value.uuid === "string" &&
		typeof value.seq === "number" &&
		["user_prompt", "agent_message", "agent_thinking", "tool_use", "tool_result"].includes(
			String(value.category),
		) &&
		(value.role === "user" || value.role === "assistant")
	);
}

function parseTimelineRecordLine(line: string): TimelineRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new TimelineRewriteConflictError("timeline changed with a malformed JSONL row", {
			cause: error,
		});
	}
	if (!isTimelineRecord(parsed)) {
		throw new TimelineRewriteConflictError("timeline changed with an invalid timeline record");
	}
	return parsed;
}

function parseTimelineBytes(bytes: Buffer): TimelineRecord[] {
	if (bytes.length === 0) return [];
	const lines = bytes.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.filter((line) => line.trim().length > 0).map(parseTimelineRecordLine);
}

function readTimelineSnapshot(path: string, basis: TimelineRewriteBasis): TimelineRecord[] {
	if (basis.identity === null || basis.eof === 0) return [];
	if (basis.eof > MAX_TIMELINE_REWRITE_BYTES) {
		throw new TimelineRewriteConflictError(
			`refusing to rebuild ${basis.eof} timeline bytes (limit ${MAX_TIMELINE_REWRITE_BYTES})`,
		);
	}
	const out: TimelineRecord[] = [];
	scanFileLines(
		path,
		(line) => {
			if (!line.nonEmpty) return;
			if (line.oversized || line.text === undefined) {
				throw new TimelineRewriteConflictError(
					`timeline contains a row larger than ${MAX_CAPTURED_JSONL_LINE_BYTES} bytes`,
				);
			}
			out.push(parseTimelineRecordLine(line.text));
			if (out.length > MAX_TIMELINE_REWRITE_RECORDS) {
				throw new TimelineRewriteConflictError(
					`timeline contains more than ${MAX_TIMELINE_REWRITE_RECORDS} records`,
				);
			}
		},
		{ endExclusive: basis.eof, includeFinalLine: true },
	);
	return out;
}

function temporaryTimelinePath(path: string): string {
	return join(dirname(path), `.${basename(path)}.rewrite-${process.pid}-${randomUUID()}.tmp`);
}

export function assertTimelineMaterializationBounds(
	records: TimelineRecord[],
	source: string,
): void {
	if (records.length > MAX_TIMELINE_REWRITE_RECORDS) {
		throw new TimelineRewriteConflictError(
			`refusing ${records.length} ${source} records (limit ${MAX_TIMELINE_REWRITE_RECORDS})`,
		);
	}
	let bytes = 0;
	for (const record of records) {
		const lineBytes = Buffer.byteLength(serializeRecord(record)) + 1;
		if (lineBytes > MAX_CAPTURED_JSONL_LINE_BYTES) {
			throw new TimelineRewriteConflictError(
				`refusing a ${source} row larger than ${MAX_CAPTURED_JSONL_LINE_BYTES} bytes`,
			);
		}
		bytes += lineBytes;
		if (bytes > MAX_TIMELINE_REWRITE_BYTES) {
			throw new TimelineRewriteConflictError(
				`refusing ${bytes} serialized ${source} bytes (limit ${MAX_TIMELINE_REWRITE_BYTES})`,
			);
		}
	}
}

function writeBufferFully(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) throw new Error("timeline temporary write returned zero bytes");
		offset += written;
	}
}

function writePreparedTimeline(
	temporaryPath: string,
	records: TimelineRecord[],
	mode: number | null,
): void {
	assertTimelineMaterializationBounds(records, "timeline rewrite");
	unlinkIfPresent(temporaryPath);
	const fd = openSync(temporaryPath, "wx", mode ?? 0o666);
	try {
		for (const record of records) {
			writeBufferFully(fd, Buffer.from(`${serializeRecord(record)}\n`));
		}
	} finally {
		closeSync(fd);
	}
	if (mode !== null) chmodSync(temporaryPath, mode & 0o7777);
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
}

interface TimelineCatchup {
	bytes: Buffer;
	basis: TimelineRewriteBasis;
}

function validateAndReplaceOrCaptureTail(
	path: string,
	temporaryPath: string,
	basis: TimelineRewriteBasis,
): TimelineCatchup | null {
	return withFileMutationLock(path, () => {
		assertNoPendingFileRotation(path, "timeline");
		const current = captureTimelineBasis(path);
		if (basis.identity !== null) {
			if (current.identity === null || !sameFileIdentity(current.identity, basis.identity)) {
				throw new TimelineRewriteConflictError(
					"timeline inode changed while preparing the replacement",
				);
			}
		} else if (current.identity === null) {
			renameSync(temporaryPath, path);
			return null;
		}

		if (current.eof < basis.eof) {
			throw new TimelineRewriteConflictError(
				"timeline shrank while preparing the replacement",
			);
		}
		if (current.eof === basis.eof) {
			renameSync(temporaryPath, path);
			return null;
		}

		const appendedBytes = current.eof - basis.eof;
		if (appendedBytes > MAX_TIMELINE_REWRITE_CATCHUP_BYTES) {
			throw new TimelineRewriteConflictError(
				`refusing to hold the append lock while reading ${appendedBytes} timeline bytes`,
			);
		}
		return {
			bytes: readFileRange(
				path,
				basis.eof,
				current.eof,
				MAX_TIMELINE_REWRITE_CATCHUP_BYTES,
			),
			basis: current,
		};
	});
}

function finishTimelineRewrite(options: {
	path: string;
	temporaryPath: string;
	records: TimelineRecord[];
	basis: TimelineRewriteBasis;
}): number {
	let ordered = options.records;
	let basis = options.basis;
	writePreparedTimeline(options.temporaryPath, ordered, basis.mode);
	for (let catchups = 0; catchups <= MAX_TIMELINE_REWRITE_CATCHUPS; catchups++) {
		const tail = validateAndReplaceOrCaptureTail(options.path, options.temporaryPath, basis);
		if (tail === null) return ordered.length;
		if (catchups === MAX_TIMELINE_REWRITE_CATCHUPS) {
			throw new TimelineRewriteConflictError(
				`timeline stayed busy across ${MAX_TIMELINE_REWRITE_CATCHUPS} catch-ups`,
			);
		}
		ordered = dedupeTimeline(sortTimeline([...ordered, ...parseTimelineBytes(tail.bytes)]));
		assertTimelineMaterializationBounds(ordered, "caught-up timeline");
		basis = tail.basis;
		writePreparedTimeline(options.temporaryPath, ordered, basis.mode);
	}
	throw new TimelineRewriteConflictError("timeline rewrite did not converge");
}

/** Reconcile a full sorted/deduped backfill with the append-only timeline. */
export function writeTimeline(
	records: TimelineRecord[],
	cwd: string,
	options: TimelineRewriteOptions = {},
): number {
	const path = timelinePath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	assertTimelineMaterializationBounds(records, "backfill input");
	const basis = captureTimelineBasis(path);
	options.afterBasisCaptured?.();
	const ordered = dedupeTimeline(sortTimeline([...records, ...readTimelineSnapshot(path, basis)]));
	assertTimelineMaterializationBounds(ordered, "combined timeline");
	const temporaryPath = temporaryTimelinePath(path);
	try {
		return finishTimelineRewrite({ path, temporaryPath, records: ordered, basis });
	} finally {
		unlinkIfPresent(temporaryPath);
	}
}
