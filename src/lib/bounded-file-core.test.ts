import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	closeFileQuietly,
	readFileRange,
	validateFileRange,
} from "./bounded-file-core.js";

describe("bounded file core", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-bounded-file-core-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("swallows a close error on an already-closed fd and leaves later I/O working", () => {
		const filePath = join(dir, "closed.bin");
		writeFileSync(filePath, "hello");
		const fd = openSync(filePath, "r");
		closeSync(fd); // fd is now invalid; a second close throws EBADF internally.
		let reachedAfterSwallow = false;
		closeFileQuietly(fd);
		reachedAfterSwallow = true;
		expect(reachedAfterSwallow).toBe(true);
		// A real, unrelated read still works — the swallowed error did not
		// corrupt any shared state.
		const bytes = readFileRange(filePath, 0, 5);
		expect(bytes.toString("utf-8")).toBe("hello");
	});

	it("rejects a non-integer offset with the exact range-error message", () => {
		expect(() => validateFileRange(1.5, 10)).toThrow(
			"file range offsets must be safe integers",
		);
	});

	it("rejects an end offset before the start with the exact range-error message", () => {
		expect(() => validateFileRange(10, 5)).toThrow("invalid file range [10, 5)");
	});

	it("refuses to materialize a range larger than the byte limit", () => {
		expect(() => readFileRange("/nonexistent/should-not-open", 0, 100, 10)).toThrow(
			"refusing to materialize 100 bytes (limit 10)",
		);
	});

	it("throws when the file ends before the requested range is satisfied", () => {
		const filePath = join(dir, "short.bin");
		writeFileSync(filePath, "abcde"); // 5 bytes on disk
		expect(() => readFileRange(filePath, 0, 10)).toThrow(
			"file ended while reading range [0, 10)",
		);
	});
});
