import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionTrajectory } from "../types.js";
import { checkTestSignalErosion } from "./pre-tool-test-integrity.js";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "test-integrity-"));
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function session(written: string[] = []): SessionTrajectory {
	return { files_written: new Set(written) } as unknown as SessionTrajectory;
}

function write(relFile: string, content: string): { file_path: string; content: string } {
	return { file_path: join(cwd, relFile), content };
}

describe("checkTestSignalErosion (PreToolUse wiring)", () => {
	it("warns when a test-file edit removes assertions", () => {
		writeFileSync(join(cwd, "foo.test.ts"), `it("a", () => { expect(x).toBe(1); expect(y).toBe(2); });`);
		const w = checkTestSignalErosion(
			"Write",
			write("foo.test.ts", `it("a", () => { expect(x).toBe(1); });`),
			session(),
			cwd,
		);
		expect(w).toContain("[interlinked:test-integrity]");
		expect(w).toContain("1 assertion(s)");
	});

	it("strengthens the warning when the prod pair changed this session", () => {
		writeFileSync(join(cwd, "foo.test.ts"), `it("a", () => { expect(x).toBe(1); });\nit("b", () => { expect(y).toBe(2); });`);
		const w = checkTestSignalErosion(
			"Write",
			write("foo.test.ts", `it("a", () => { expect(x).toBe(1); });`),
			session([join(cwd, "foo.ts")]),
			cwd,
		);
		expect(w).toContain("its source changed earlier this session");
	});

	it("is silent when the edit adds coverage", () => {
		writeFileSync(join(cwd, "foo.test.ts"), `it("a", () => { expect(x).toBe(1); });`);
		expect(
			checkTestSignalErosion(
				"Write",
				write("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\nit("b", () => { expect(y).toBe(2); });`),
				session(),
				cwd,
			),
		).toBeNull();
	});

	it("is silent for a non-test file, a read, and a brand-new test file", () => {
		writeFileSync(join(cwd, "foo.ts"), "export const x = 1;");
		expect(checkTestSignalErosion("Write", write("foo.ts", "export const x = 2;"), session(), cwd)).toBeNull();
		expect(checkTestSignalErosion("Read", write("foo.test.ts", "x"), session(), cwd)).toBeNull();
		// brand-new test file (not on disk) — nothing to erode
		expect(checkTestSignalErosion("Write", write("new.test.ts", "it('a', () => {})"), session(), cwd)).toBeNull();
	});

	it("is silent when the on-disk test path cannot be read (EISDIR)", () => {
		// The test path exists (existsSync passes) but resolves to a directory,
		// not a file, so readFileSync throws — the catch must yield null rather
		// than letting the exception escape.
		mkdirSync(join(cwd, "foo.test.ts"), { recursive: true });
		expect(
			checkTestSignalErosion("Write", write("foo.test.ts", `it("a", () => { expect(x).toBe(1); });`), session(), cwd),
		).toBeNull();
	});
});
