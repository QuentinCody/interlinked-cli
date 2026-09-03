import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeReadFile } from "./safe-read-file.js";

describe("safeReadFile", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "safe-read-file-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: returns the file's utf-8 content when it exists and is readable", () => {
		const abs = join(dir, "file.txt");
		writeFileSync(abs, "hello world");
		expect(safeReadFile(abs)).toBe("hello world");
	});

	it("N1: returns null when the path does not exist", () => {
		const abs = join(dir, "missing.txt");
		expect(safeReadFile(abs)).toBeNull();
	});

	it("N2: returns null when the path is a directory (read throws EISDIR)", () => {
		expect(safeReadFile(dir)).toBeNull();
	});
});
