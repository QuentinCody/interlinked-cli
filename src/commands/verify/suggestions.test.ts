// ===========================================
// suggestions unit tests
// ===========================================

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuggestions } from "./suggestions.js";

let tempDir: string;
let counter = 0;

beforeEach(() => {
	tempDir = join(tmpdir(), `suggestions-test-${process.pid}-${++counter}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("runSuggestions", () => {
	it("returns empty map when given no files", () => {
		const r = runSuggestions({ files: [], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips test files entirely", () => {
		const file = join(tempDir, "foo.test.ts");
		writeFileSync(file, "describe('x', () => { it('y', () => {}); });\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("skips non-JS/TS files", () => {
		const file = join(tempDir, "foo.py");
		writeFileSync(file, "print('hello')\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 3, threshold: 0.5 });
		expect(r.size).toBe(0);
	});

	it("does NOT register silent-promise-swallow — promoted out of the suggestion pipeline", () => {
		// `silent-promise-swallow` was promoted to the default-warning
		// CHECK_REGISTRY pipeline (entries-warnings.ts → silent_promise_catch).
		// It now fires unconditionally on every PostToolUse and through
		// `runCodeQualityChecks`, so the scored suggestion path was removed
		// to avoid double-firing. Coverage of the detector itself lives in
		// `src/harness/checks/agent-safety.test.ts::checkSilentPromiseSwallow`.
		const file = join(tempDir, "swallow.ts");
		writeFileSync(file, "fetch('/api').catch(() => {});\n");
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 10, threshold: 0.5 });
		const allFindings = [...r.values()].flat();
		expect(allFindings.some((f) => f.check === "silent-promise-swallow")).toBe(false);
	});

	it("skips a file that cannot be read and still processes the rest of the batch", () => {
		// No such file — readFileSync throws ENOENT inside the loop. The
		// walker file that follows it in `files` must still be reached and
		// scored: proves the catch swallows the error and `continue`s
		// rather than the loop aborting on the first unreadable file.
		const missing = join(tempDir, "does-not-exist.ts");
		const walker = join(tempDir, "walker.ts");
		writeFileSync(
			walker,
			[
				"import { readdirSync, statSync } from 'node:fs';",
				"function walk(dir) {",
				"  for (const e of readdirSync(dir)) {",
				"    const p = dir + '/' + e;",
				"    if (statSync(p).isDirectory()) walk(p);",
				"  }",
				"}",
				"",
			].join("\n"),
		);
		const r = runSuggestions({
			files: [missing, walker],
			cwd: tempDir,
			limit: 10,
			threshold: 0.5,
		});
		expect(r.size).toBe(1);
		expect(r.has("does-not-exist.ts")).toBe(false);
		const allFindings = [...r.values()].flat();
		expect(allFindings.some((f) => f.check === "recursive-walker-lstat")).toBe(true);
	});

	it("registers recursive-walker-lstat at the DEFAULT threshold (proves it's not filtered out)", () => {
		const file = join(tempDir, "walker.ts");
		writeFileSync(
			file,
			[
				"import { readdirSync, statSync } from 'node:fs';",
				"function walk(dir) {",
				"  for (const e of readdirSync(dir)) {",
				"    const p = dir + '/' + e;",
				"    if (statSync(p).isDirectory()) walk(p);",
				"  }",
				"}",
				"",
			].join("\n"),
		);
		const r = runSuggestions({ files: [file], cwd: tempDir, limit: 10, threshold: 0.5 });
		const allFindings = [...r.values()].flat();
		expect(allFindings.some((f) => f.check === "recursive-walker-lstat")).toBe(true);
	});
});
