import { parseWire, wireNumber } from "../../lib/value-validation.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanJsonlTail, type TailScanBudget } from "./reverse-reader.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "il-query-rr-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, lines: string[], trailingNewline = true): string {
	const path = join(dir, name);
	writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
	return path;
}

function collect(path: string, budget: Partial<TailScanBudget> = {}) {
	const seen: Record<string, unknown>[] = [];
	const stats = scanJsonlTail(
		path,
		{ maxRecords: 100_000, maxBytes: 64 * 1024 * 1024, ...budget },
		(record) => {
			seen.push(record);
			return true;
		},
	);
	return { seen, stats };
}

describe("scanJsonlTail", () => {
	it("delivers records newest-first and reports a complete scan", () => {
		const path = writeLog("a.jsonl", [
			JSON.stringify({ i: 1 }),
			JSON.stringify({ i: 2 }),
			JSON.stringify({ i: 3 }),
		]);
		const { seen, stats } = collect(path);
		expect(seen.map((r) => r.i)).toEqual([3, 2, 1]);
		expect(stats.recordsParsed).toBe(3);
		expect(stats.malformedLines).toBe(0);
		expect(stats.truncated).toBe(false);
		expect(stats.bytesScanned).toBe(stats.fileBytes);
	});

	it("reassembles lines split across small chunk boundaries", () => {
		const lines = Array.from({ length: 200 }, (_, i) =>
			JSON.stringify({ i, pad: "x".repeat(1 + (i % 23)) }),
		);
		const path = writeLog("b.jsonl", lines);
		const { seen, stats } = collect(path, { chunkBytes: 37 });
		expect(seen).toHaveLength(200);
		expect(stats.malformedLines).toBe(0);
		expect(seen.map((r) => r.i)).toEqual(Array.from({ length: 200 }, (_, i) => 199 - i));
	});

	it("stops at maxRecords and marks the scan truncated", () => {
		const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i }));
		const path = writeLog("c.jsonl", lines);
		const { seen, stats } = collect(path, { maxRecords: 10 });
		expect(seen).toHaveLength(10);
		expect(seen[0]?.i).toBe(99);
		expect(stats.truncated).toBe(true);
		expect(stats.stopReason).toBe("records");
	});

	it("does not mark truncated when maxRecords exactly equals the record count", () => {
		const path = writeLog("d.jsonl", [JSON.stringify({ i: 1 }), JSON.stringify({ i: 2 })]);
		const { seen, stats } = collect(path, { maxRecords: 2 });
		expect(seen).toHaveLength(2);
		expect(stats.truncated).toBe(false);
		expect(stats.stopReason).toBeUndefined();
	});

	it("stops at the byte budget", () => {
		const lines = Array.from({ length: 100 }, (_, i) =>
			JSON.stringify({ i, pad: "y".repeat(100) }),
		);
		const path = writeLog("e.jsonl", lines);
		const { seen, stats } = collect(path, { chunkBytes: 1024, maxBytes: 2048 });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.length).toBeLessThan(100);
		expect(stats.truncated).toBe(true);
		expect(stats.stopReason).toBe("bytes");
		expect(stats.bytesScanned).toBeLessThanOrEqual(3 * 1024);
	});

	it("skips malformed lines, counts them, and keeps valid records", () => {
		const path = writeLog("f.jsonl", [
			JSON.stringify({ i: 1 }),
			"{not json",
			"[1,2,3]",
			JSON.stringify({ i: 2 }),
		]);
		const { seen, stats } = collect(path);
		expect(seen.map((r) => r.i)).toEqual([2, 1]);
		expect(stats.malformedLines).toBe(2);
	});

	it("stops when the handler returns false", () => {
		const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i }));
		const path = writeLog("g.jsonl", lines);
		const seen: number[] = [];
		const stats = scanJsonlTail(
			path,
			{ maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
			(record) => {
				seen.push(parseWire(record.i, wireNumber, "test JSON value"));
				return seen.length < 5;
			},
		);
		expect(seen).toEqual([49, 48, 47, 46, 45]);
		expect(stats.truncated).toBe(true);
		expect(stats.stopReason).toBe("caller");
	});

	it("returns zero stats for a missing file without throwing", () => {
		const { seen, stats } = collect(join(dir, "missing.jsonl"));
		expect(seen).toHaveLength(0);
		expect(stats.fileBytes).toBe(0);
		expect(stats.truncated).toBe(false);
	});

	it("parses the newest record when the file lacks a trailing newline", () => {
		const path = writeLog("h.jsonl", [JSON.stringify({ i: 1 }), JSON.stringify({ i: 2 })], false);
		const { seen } = collect(path);
		expect(seen.map((r) => r.i)).toEqual([2, 1]);
	});

	it("handles an empty file", () => {
		const path = writeLog("i.jsonl", [""], false);
		const { seen, stats } = collect(path);
		expect(seen).toHaveLength(0);
		expect(stats.recordsParsed).toBe(0);
		expect(stats.truncated).toBe(false);
	});
});
