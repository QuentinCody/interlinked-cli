// ===========================================
// Bounded backward JSONL scan for `interlinked query`
// ===========================================
// Reads the newest records of an append-only JSONL log without loading the
// whole file: fixed-size blocks are read from EOF toward the head, complete
// lines are parsed newest-first, and the partial first line of each block is
// carried (as bytes, so multi-byte UTF-8 survives chunk cuts) into the next
// iteration. Budgets bound the scan on multi-hundred-MB logs — collection.jsonl
// is 400+ MB in this repo; a naive read hangs the caller. `truncated` reports
// whether a budget (or the caller) stopped the scan before the file head.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { nonNull } from "../../lib/non-null.js";

const NEWLINE = 0x0a;
const DEFAULT_CHUNK_BYTES = 1 << 20;
const EMPTY = Buffer.alloc(0);

export interface TailScanBudget {
	/** Stop after parsing this many records (matched or not by the caller). */
	maxRecords: number;
	/** Stop after scanning this many bytes back from the tail. */
	maxBytes: number;
	/** Block size for backward reads (test seam; default 1 MiB). */
	chunkBytes?: number;
}

type TailStopReason = "records" | "bytes" | "caller";

export interface TailScanStats {
	fileBytes: number;
	bytesScanned: number;
	recordsParsed: number;
	malformedLines: number;
	/** True when the scan ended before reaching the file head. */
	truncated: boolean;
	stopReason?: TailStopReason;
}

/** Receives records newest-first; return false to stop the scan early. */
type TailRecordHandler = (record: Record<string, unknown>) => boolean | undefined;

interface ScanState {
	stats: TailScanStats;
	stopped: boolean;
}

function emptyStats(): TailScanStats {
	return { fileBytes: 0, bytesScanned: 0, recordsParsed: 0, malformedLines: 0, truncated: false };
}

/** Scan a JSONL file backward from EOF within budget. Missing file → zero stats. */
export function scanJsonlTail(
	path: string,
	budget: TailScanBudget,
	onRecord: TailRecordHandler,
): TailScanStats {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return emptyStats();
	}
	try {
		return scanOpenFile(fd, budget, onRecord);
	} finally {
		closeSync(fd);
	}
}

function scanOpenFile(
	fd: number,
	budget: TailScanBudget,
	onRecord: TailRecordHandler,
): TailScanStats {
	const chunkBytes = budget.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	const stats = emptyStats();
	stats.fileBytes = fstatSync(fd).size;
	const state: ScanState = { stats, stopped: false };
	let end = stats.fileBytes;
	let carry: Buffer = EMPTY;

	while (end > 0 && !state.stopped) {
		if (stats.bytesScanned >= budget.maxBytes) {
			stats.stopReason = "bytes";
			state.stopped = true;
			break;
		}
		const start = Math.max(0, end - chunkBytes);
		const block = Buffer.alloc(end - start);
		readSync(fd, block, 0, block.length, start);
		stats.bytesScanned += block.length;
		const combined = carry.length > 0 ? Buffer.concat([block, carry]) : block;
		carry = processChunk(combined, start === 0, state, budget, onRecord);
		end = start;
	}

	stats.truncated = stats.stopReason !== undefined || end > 0 || carry.length > 0;
	return stats;
}

/**
 * Parse the complete lines of one chunk newest-first; return the incomplete
 * leading bytes (a line whose start lies in an earlier chunk) as the new carry.
 */
function processChunk(
	combined: Buffer,
	atHead: boolean,
	state: ScanState,
	budget: TailScanBudget,
	onRecord: TailRecordHandler,
): Buffer {
	const newlines: number[] = [];
	for (let i = 0; i < combined.length; i++) {
		if (combined[i] === NEWLINE) newlines.push(i);
	}
	if (newlines.length === 0) {
		if (!atHead) return Buffer.from(combined);
		deliverBounds(combined, [[0, combined.length]], state, budget, onRecord);
		return EMPTY;
	}

	// Segments newest-first: the tail after the last newline (newest, possibly
	// spanning into the later chunk via carry), then each inter-newline segment
	// right-to-left, then — only at the file head — the leading segment.
	const bounds: Array<[number, number]> = [
		[nonNull(newlines[newlines.length - 1]) + 1, combined.length],
	];
	for (let k = newlines.length - 1; k > 0; k--) {
		bounds.push([nonNull(newlines[k - 1]) + 1, nonNull(newlines[k])]);
	}
	if (atHead) bounds.push([0, nonNull(newlines[0])]);

	deliverBounds(combined, bounds, state, budget, onRecord);
	if (state.stopped || atHead) return EMPTY;
	return combined.subarray(0, nonNull(newlines[0]));
}

function deliverBounds(
	buf: Buffer,
	bounds: Array<[number, number]>,
	state: ScanState,
	budget: TailScanBudget,
	onRecord: TailRecordHandler,
): void {
	for (const [start, end] of bounds) {
		if (state.stopped) return;
		const line = buf.toString("utf-8", start, end).trim();
		if (!line) continue;
		if (state.stats.recordsParsed >= budget.maxRecords) {
			// Another real line exists beyond the budget — only now is it a cut.
			state.stats.stopReason = "records";
			state.stopped = true;
			return;
		}
		deliverLine(line, state, onRecord);
	}
}

function deliverLine(line: string, state: ScanState, onRecord: TailRecordHandler): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		state.stats.malformedLines++;
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		state.stats.malformedLines++;
		return;
	}
	state.stats.recordsParsed++;
	if (onRecord(parsed as Record<string, unknown>) === false) {
		state.stats.stopReason = "caller";
		state.stopped = true;
	}
}
