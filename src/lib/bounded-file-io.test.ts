import {
	closeSync,
	existsSync,
	ftruncateSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync) };
});
import {
	countNonEmptyFileLines,
	findLineBoundaryAtOrBefore,
	findTailStartForLines,
	gzipFileRange,
	MAX_MATERIALIZED_RANGE_BYTES,
	readFirstNonEmptyFileLine,
	scanFileLines,
	sha256File,
	tornTailPrefix,
} from "./bounded-file-io.js";

describe("bounded file I/O", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "bounded-io-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("reads just the final byte to separate a new record after a torn tail", () => {
		const path = join(tmp, "journal.jsonl");
		expect(tornTailPrefix(path)).toBe("");
		writeFileSync(path, "");
		expect(tornTailPrefix(path)).toBe("");
		const size = 64 * 1024;
		writeFileSync(path, Buffer.alloc(size, 0x61));
		expect(tornTailPrefix(path)).toBe("\n");
		expect(vi.mocked(readSync).mock.calls.at(-1)?.slice(2)).toEqual([0, 1, size - 1]);
		writeFileSync(path, "terminated\n");
		expect(tornTailPrefix(path)).toBe("");
	});

	it.each(["hash", "scan", "tail"])("closes any acquired descriptor when %s buffer allocation rejects its size", operation => {
		const path = join(tmp, "input.jsonl");
		writeFileSync(path, "record\n");
		const invoke = () => {
			if (operation === "hash") sha256File(path, NaN);
			else if (operation === "scan") scanFileLines(path, () => {}, { chunkBytes: NaN });
			else findTailStartForLines(path, 1, NaN);
		};
		expect(invoke).toThrow();
		for (const acquired of vi.mocked(openSync).mock.results) {
			if (acquired.type === "return") expect(() => fstatSync(acquired.value)).toThrow(/EBADF/);
		}
	});

	it("scans records and boundaries correctly across tiny chunks", () => {
		const path = join(tmp, "activity.jsonl");
		writeFileSync(path, "  \nalpha\n\nβeta\nlast");
		const lines: string[] = [];
		scanFileLines(
			path,
			(line) => {
				if (line.nonEmpty && line.text !== undefined) lines.push(line.text);
			},
			{ chunkBytes: 3 },
		);

		expect(lines).toEqual(["alpha", "βeta", "last"]);
		expect(countNonEmptyFileLines(path, 2)).toBe(3);
		expect(readFirstNonEmptyFileLine(path)).toBe("alpha");
		expect(findLineBoundaryAtOrBefore(path, 12, true)).toEqual({
			offset: 10,
			records: 3,
		});
	});

	it("finds a byte-exact suffix containing the requested final records", () => {
		const path = join(tmp, "activity.jsonl");
		writeFileSync(path, "a\n\nb\nc\n");
		const start = findTailStartForLines(path, 2, 2);
		expect(readFileSync(path).subarray(start).toString("utf8")).toBe("b\nc\n");
	});

	it("hashes the same file identically across different bounded chunk sizes", () => {
		const path = join(tmp, "segment.jsonl.gz");
		writeFileSync(path, "abc");
		expect(sha256File(path, 1)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(sha256File(path, 4096)).toBe(sha256File(path, 1));
	});

	it("removes a newly claimed partial gzip after a source failure so retry can succeed", () => {
		const unreadableSource = join(tmp, "source-dir");
		const destination = join(tmp, "segment.jsonl.gz");
		mkdirSync(unreadableSource);

		expect(() =>
			gzipFileRange(
				unreadableSource,
				0,
				MAX_MATERIALIZED_RANGE_BYTES + 1,
				destination,
				1024,
			),
		).toThrow();
		expect(existsSync(destination)).toBe(false);

		const validSource = join(tmp, "source.jsonl");
		writeFileSync(validSource, "retry\n");
		const retried = gzipFileRange(validSource, 0, 6, destination);
		expect(retried.claimed).toBe(true);
		expect(gunzipSync(readFileSync(destination)).toString("utf8")).toBe("retry\n");
	});

	it("decodes a streamed range larger than the materialization ceiling losslessly", () => {
		const source = join(tmp, "large-sparse.jsonl");
		const destination = join(tmp, "large-sparse.jsonl.gz");
		const size = MAX_MATERIALIZED_RANGE_BYTES + 3;
		const fd = openSync(source, "w");
		try {
			ftruncateSync(fd, size);
			writeSync(fd, Buffer.from("end"), 0, 3, size - 3);
		} finally {
			closeSync(fd);
		}

		const result = gzipFileRange(source, 0, size, destination, 1024 * 1024);
		const decoded = gunzipSync(readFileSync(destination));
		expect(result.claimed).toBe(true);
		expect(decoded.length).toBe(size);
		expect(decoded.subarray(-3).toString("utf8")).toBe("end");
	});
});
