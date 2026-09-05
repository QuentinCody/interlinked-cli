import { createReadStream, statSync } from "node:fs";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { LineAccumulator, type FileLine, MAX_CAPTURED_JSONL_LINE_BYTES } from "../bounded-file-io.js";

export interface DataReadOptions {
    startOffset?: number;
    maxBytes?: number;
    maxLineBytes?: number;
    maxExpandedBytes?: number;
}
interface DataReadBounds { start: number; end: number; lineBytes: number; expansionLimit: number; }
const CHUNK_BYTES = 64 * 1024;
const DEFAULT_EXPANSION_LIMIT = 16 * 1024 * 1024 * 1024;

function validateMaterializationLimits(options: DataReadOptions): void {
    for (const limit of [options.maxLineBytes, options.maxExpandedBytes]) {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError("data materialization limits must be positive safe integers");
    }
}

function readBounds(options: DataReadOptions): DataReadBounds {
    validateMaterializationLimits(options);
    const start = options.startOffset ?? 0;
    const bytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new RangeError("data scan offsets and byte budgets must be nonnegative safe integers");
    }
    return {
        start, end: Math.min(Number.MAX_SAFE_INTEGER, start + bytes),
        lineBytes: options.maxLineBytes ?? MAX_CAPTURED_JSONL_LINE_BYTES,
        expansionLimit: options.maxExpandedBytes ?? DEFAULT_EXPANSION_LIMIT,
    };
}

function* chunkLines(chunk: Buffer, position: number, accumulator: LineAccumulator): Generator<FileLine> {
    let cursor = 0;
    for (;;) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline < 0) { accumulator.add(chunk.subarray(cursor)); return; }
        accumulator.add(chunk.subarray(cursor, newline));
        yield accumulator.finish(position + newline, position + newline + 1, true);
        cursor = newline + 1;
    }
}

async function* inputLines(input: Readable, bounds: DataReadBounds, initialPosition: number): AsyncGenerator<FileLine> {
    const accumulator = new LineAccumulator(bounds.start, bounds.lineBytes);
    let position = initialPosition;
    for await (const value of input) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const next = position + chunk.length;
        if (next > bounds.expansionLimit) throw new RangeError("data scan expanded-byte limit exceeded");
        const begin = Math.max(0, bounds.start - position);
        const stop = Math.min(chunk.length, bounds.end - position);
        if (stop > begin) yield* chunkLines(chunk.subarray(begin, stop), position + begin, accumulator);
        position = next;
        if (position >= bounds.end) break;
    }
    const observedEnd = Math.min(position, bounds.end);
    if (accumulator.start() < observedEnd) yield accumulator.finish(observedEnd, observedEnd, false);
}

/** Complete-line boundaries are the commit marker; offsets are in uncompressed bytes. */
export async function* readDataLines(path: string, options: DataReadOptions = {}): AsyncGenerator<FileLine> {
    const bounds = readBounds(options);
    const bytes = statSync(path).size;
    const compressed = path.endsWith(".gz");
    if (!compressed) bounds.expansionLimit = Number.MAX_SAFE_INTEGER;
    if (bytes === 0 || (!compressed && bounds.start >= bytes)) return;
    const start = compressed ? 0 : bounds.start;
    const raw = createReadStream(path, { start, end: bytes - 1, highWaterMark: CHUNK_BYTES });
    const input = compressed ? raw.pipe(createGunzip({ chunkSize: CHUNK_BYTES })) : raw;
    raw.on("error", (error) => { if (input !== raw) input.destroy(error); });
    try {
        yield* inputLines(input, bounds, start);
    } finally {
        input.destroy();
        raw.destroy();
    }
}
