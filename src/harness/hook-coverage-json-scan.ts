import { closeSync, openSync, readSync } from "node:fs";

/** One top-level member of a ledger file, scanned without building one string for the file.
 * The elements of each history array are delivered one at a time; every other member is
 * parsed whole (they are the bounded current state). V8 caps one string at 0x1fffffe8
 * characters, so a reader that parses the whole file cannot load a large legacy ledger. */
export type ElementSink = (key: string, value: unknown, text: string) => void;
export interface LedgerScan { current: Record<string, unknown>; arrays: string[] }

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const QUOTE = 0x22, BACKSLASH = 0x5c, COMMA = 0x2c, COLON = 0x3a;
const OPEN_OBJECT = 0x7b, CLOSE_OBJECT = 0x7d, OPEN_ARRAY = 0x5b, CLOSE_ARRAY = 0x5d;

function isSpace(byte: number): boolean { return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09; }
function isScalarEnd(byte: number): boolean { return byte === COMMA || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY || isSpace(byte); }

/** Bytes of one JSON value. Strings are skipped with native searches; structural bytes are ASCII,
 * so scanning UTF-8 bytes is safe and multibyte characters split across chunks are rejoined. */
class ValueCapture {
    private pieces: Buffer[] = [];
    private start = 0;
    private depth = 0;
    private inString = false;
    private escaped = false;
    private scalar = false;

    /** Returns the index after the opening byte the capture consumed. */
    begin(chunk: Buffer, index: number): number {
        const byte = chunk[index]!;
        this.pieces = []; this.start = index; this.escaped = false;
        this.scalar = byte !== OPEN_OBJECT && byte !== OPEN_ARRAY && byte !== QUOTE;
        this.inString = byte === QUOTE;
        this.depth = this.scalar || this.inString ? 0 : 1;
        return this.scalar ? index : index + 1;
    }

    /** Returns the end index (exclusive) when the value completes in this chunk, else -1. */
    advance(chunk: Buffer, from: number): number {
        const search = { backslash: -2 };
        let index = from;
        while (index < chunk.length) {
            if (this.inString) {
                index = this.skipString(chunk, index, search);
                if (!this.inString && this.depth === 0) return this.finish(chunk, index);
                continue;
            }
            const end = this.structural(chunk, index);
            if (end !== -1) return this.finish(chunk, end);
            index++;
        }
        return -1;
    }

    /** Keeps the unfinished value's bytes from this chunk; the next chunk continues at 0. */
    carry(chunk: Buffer): void {
        this.pieces.push(chunk.subarray(this.start));
        this.start = 0;
    }

    /** Moves past string bytes with native searches. The next backslash is cached per chunk,
     * so a long string without escapes costs one search, not one per quote. */
    private skipString(chunk: Buffer, index: number, search: { backslash: number }): number {
        if (this.escaped) { this.escaped = false; return index + 1; }
        if (search.backslash !== -1 && search.backslash < index) search.backslash = chunk.indexOf(BACKSLASH, index);
        const quote = chunk.indexOf(QUOTE, index);
        if (search.backslash !== -1 && (quote === -1 || search.backslash < quote)) { this.escaped = true; return search.backslash + 1; }
        if (quote === -1) return chunk.length;
        this.inString = false;
        return quote + 1;
    }

    /** Applies one byte outside a string; returns the value's end index when it closes. */
    private structural(chunk: Buffer, index: number): number {
        const byte = chunk[index]!;
        if (this.scalar) return isScalarEnd(byte) ? index : -1;
        if (byte === QUOTE) this.inString = true;
        else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) this.depth++;
        else if ((byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) && --this.depth === 0) return index + 1;
        return -1;
    }

    private finish(chunk: Buffer, end: number): number {
        this.pieces.push(chunk.subarray(this.start, end));
        return end;
    }

    text(): string {
        const bytes = this.pieces.length === 1 ? this.pieces[0]! : Buffer.concat(this.pieces);
        this.pieces = [];
        return bytes.toString("utf8");
    }
}

type Phase = "start" | "first-key" | "key" | "colon" | "value" | "first-element" | "element" | "after-element" | "after-member" | "done" | "capture";
type Purpose = "key" | "member" | "element";

class LedgerScanner {
    private phase: Phase = "start";
    private purpose: Purpose = "key";
    private key = "";
    private offset = 0;
    private readonly capture = new ValueCapture();
    private readonly members = new Map<string, unknown>();
    private readonly arrays: string[] = [];

    constructor(private readonly historyKeys: ReadonlySet<string>, private readonly sink: ElementSink) {}

    feed(chunk: Buffer): void {
        let index = 0;
        while (index < chunk.length) {
            if (this.phase === "capture") {
                const end = this.capture.advance(chunk, index);
                if (end === -1) break;
                index = end;
                this.complete(this.offset + end);
                continue;
            }
            const byte = chunk[index]!;
            index = isSpace(byte) ? index + 1 : this.step(chunk, index, byte);
        }
        if (this.phase === "capture") this.capture.carry(chunk);
        this.offset += chunk.length;
    }

    finish(): LedgerScan {
        if (this.phase !== "done") throw this.error(this.offset, "file is truncated");
        return { current: Object.fromEntries(this.members), arrays: this.arrays };
    }

    private error(position: number, reason: string): Error {
        return new Error(`Malformed hook coverage ledger at byte ${position}: ${reason}`);
    }

    private expect(byte: number, wanted: number, position: number, label: string): void {
        if (byte !== wanted) throw this.error(position, `expected '${label}'`);
    }

    private begin(chunk: Buffer, index: number, purpose: Purpose): number {
        const byte = chunk[index]!;
        if (byte === COMMA || byte === COLON || byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) throw this.error(this.offset + index, "expected a value");
        this.purpose = purpose; this.phase = "capture";
        return this.capture.begin(chunk, index);
    }

    /** One structural byte between values; returns the next index. */
    private step(chunk: Buffer, index: number, byte: number): number {
        const position = this.offset + index;
        switch (this.phase) {
            case "start": this.expect(byte, OPEN_OBJECT, position, "{"); this.phase = "first-key"; return index + 1;
            case "first-key": if (byte === CLOSE_OBJECT) { this.phase = "done"; return index + 1; }
                this.expect(byte, QUOTE, position, "\""); return this.begin(chunk, index, "key");
            case "key": this.expect(byte, QUOTE, position, "\""); return this.begin(chunk, index, "key");
            case "colon": this.expect(byte, COLON, position, ":"); this.phase = "value"; return index + 1;
            case "value": return this.value(chunk, index, byte);
            case "first-element": if (byte === CLOSE_ARRAY) { this.phase = "after-member"; return index + 1; }
                return this.begin(chunk, index, "element");
            case "element": return this.begin(chunk, index, "element");
            case "after-element": this.separator(byte, position, CLOSE_ARRAY, "element"); return index + 1;
            case "after-member": this.separator(byte, position, CLOSE_OBJECT, "key"); return index + 1;
            default: throw this.error(position, "trailing data after the ledger object");
        }
    }

    private value(chunk: Buffer, index: number, byte: number): number {
        if (byte !== OPEN_ARRAY || !this.historyKeys.has(this.key)) return this.begin(chunk, index, "member");
        this.arrays.push(this.key);
        this.phase = "first-element";
        return index + 1;
    }

    private separator(byte: number, position: number, close: number, next: "element" | "key"): void {
        if (byte === COMMA) this.phase = next;
        else if (byte === close) this.phase = close === CLOSE_ARRAY ? "after-member" : "done";
        else throw this.error(position, `expected ',' or '${close === CLOSE_ARRAY ? "]" : "}"}'`);
    }

    private complete(position: number): void {
        const text = this.capture.text();
        let value: unknown;
        try { value = JSON.parse(text); }
        catch (error) { throw this.error(position, `invalid JSON value (${String(error)})`); }
        if (this.purpose === "key") {
            this.key = String(value);
            if (this.members.has(this.key) || this.arrays.includes(this.key)) throw this.error(position, `duplicate key ${JSON.stringify(this.key)}`);
            this.phase = "colon";
        } else if (this.purpose === "member") {
            this.members.set(this.key, value);
            this.phase = "after-member";
        } else {
            this.sink(this.key, value, text);
            this.phase = "after-element";
        }
    }
}

/** Reads `path` in chunks. Throws a byte-positioned error on malformed input. */
export function scanLedgerFile(path: string, historyKeys: ReadonlySet<string>, sink: ElementSink, chunkBytes = DEFAULT_CHUNK_BYTES): LedgerScan {
    const scanner = new LedgerScanner(historyKeys, sink);
    const descriptor = openSync(path, "r");
    try {
        for (;;) {
            const chunk = Buffer.allocUnsafe(chunkBytes);
            const read = readSync(descriptor, chunk, 0, chunkBytes, null);
            if (read === 0) break;
            scanner.feed(read === chunkBytes ? chunk : chunk.subarray(0, read));
        }
    } finally { closeSync(descriptor); }
    return scanner.finish();
}
