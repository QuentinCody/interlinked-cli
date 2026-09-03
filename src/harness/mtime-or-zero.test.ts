import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mtimeOrZero } from "./mtime-or-zero.js";

describe("mtimeOrZero", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mtime-or-zero-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("P1: returns the file's mtimeMs when it exists (must fire)", () => {
		const path = join(dir, "present.txt");
		writeFileSync(path, "hello");
		expect(mtimeOrZero(path)).toBeGreaterThan(0);
	});

	it("N1: returns 0 for a missing path (must not throw)", () => {
		expect(mtimeOrZero(join(dir, "absent.txt"))).toBe(0);
	});
});
