import { describe, expect, it } from "vitest";
import { detectHomedirWriteEscape, detectWriteWithoutMkdir } from "./fs-write-safety.js";

const TS = "src/lib/foo.ts";

// Basis for the write_without_mkdir expectations below: the module header
// (fs-write-safety.ts:1-27) and the doc comments on each helper.

describe("detectWriteWithoutMkdir — known-directory suppression is exact", () => {
	it("flags a concat write into a plain variable when no directory is known to exist", () => {
		// Header 3-8: a string literal containing `/` is a nested path. With no
		// mkdtemp/bare-mkdir name in the file, nothing suppresses it.
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function save(base: string) {",
			"  writeFileSync(base + '/note.txt', 'x');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.map((m) => m.line)).toEqual([3]);
	});

	it("flags join(other, sub, file) when only an unrelated name is a known directory", () => {
		// isSingleSegmentIntoKnownDir doc (112-119): suppress only a segment placed
		// directly inside a KNOWN directory. `cwd` is not known.
		const code = [
			"import { mkdtempSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"import { tmpdir } from 'node:os';",
			"function setup(cwd: string) {",
			"  const dir = mkdtempSync(join(tmpdir(), 'x-'));",
			"  writeFileSync(join(cwd, 'sub', 'f.txt'), 'x');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.map((m) => m.line)).toEqual([6]);
	});

	it("flags a template-literal write two segments below a known directory", () => {
		// Doc 112-119: "A second segment below `dir` still can [ENOENT]".
		const code = [
			"import { mkdtempSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"import { tmpdir } from 'node:os';",
			"function setup() {",
			"  const dir = mkdtempSync(join(tmpdir(), 'x-'));",
			"  writeFileSync(`${dir}/sub/f.txt`, 'x');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.map((m) => m.line)).toEqual([6]);
	});

	it("treats join(dir, <expr containing an array literal with commas>) as exactly two arguments", () => {
		// countTopLevelArgs doc (147-150): counts TOP-LEVEL arguments; commas inside
		// a bracketed sub-expression do not add arguments.
		const code = [
			"import { mkdtempSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"import { tmpdir } from 'node:os';",
			"function setup() {",
			"  const dir = mkdtempSync(join(tmpdir(), 'x-'));",
			"  writeFileSync(join(dir, ['a', 'b'][0]), 'x');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});
});

describe("detectWriteWithoutMkdir — path-argument analysis", () => {
	it("flags join(a, b) with exactly two arguments (header: join with >=2 arguments)", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  writeFileSync(join(cwd, 'out.json'), 'x');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS).map((m) => m.line)).toEqual([4]);
	});

	it("sees a join() whose first argument is longer than 30 characters", () => {
		// hasNestedPathArg inspects the argument window after the write's `(`;
		// a long identifier must not hide the second join argument.
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(aVeryLongBaseDirectoryNameForTheOutputRoot: string) {",
			"  writeFileSync(join(aVeryLongBaseDirectoryNameForTheOutputRoot, 'result.json'), 'x');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS).map((m) => m.line)).toEqual([4]);
	});

	it("does not throw when the write call's open paren is on a later line than its name", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, data: string) {",
			"  writeFileSync",
			"    (join(cwd, 'out', 'r.json'), data);",
			"}",
		].join("\n");
		expect(() => detectWriteWithoutMkdir(code, TS)).not.toThrow();
	});
});

describe("detectWriteWithoutMkdir — guard scope", () => {
	it("does not count an existsSync in the condition that opens the write's own block as a prior guard", () => {
		// findEnclosingFunctionStartLine (203-210, inline 221): the body starts on
		// the line AFTER the opening brace, and the scan covers body lines before
		// the write only.
		const code = [
			"import { existsSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, data: string) {",
			"  if (!existsSync(cwd)) {",
			"    writeFileSync(join(cwd, 'out', 'r.json'), data);",
			"  }",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS).map((m) => m.line)).toEqual([5]);
	});

	it("finds the function scope from lines above the write even when the write line itself opens a block", () => {
		// The enclosing-function walk starts from the line before the write, so a
		// `{` on the write's own line is not mistaken for the function start.
		const code = [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, ok: boolean, data: string) {",
			"  mkdirSync(join(cwd, 'out'), { recursive: true });",
			"  if (ok) { writeFileSync(join(cwd, 'out', 'r.json'), data);",
			"  }",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("accepts `recursive` on the 4th line of a multi-line mkdirSync call", () => {
		// hasPriorGuardInLines doc (236-238): recursive may appear "up to 5
		// subsequent lines" after the opener.
		const code = [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, data: string) {",
			"  mkdirSync(",
			"    join(cwd, 'out'),",
			"    {",
			"      recursive: true,",
			"    },",
			"  );",
			"  writeFileSync(join(cwd, 'out', 'r.json'), data);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not accept an unrelated `recursive` word eight lines after a non-recursive mkdirSync", () => {
		// Same doc: the look-ahead is bounded (~5 lines), not open-ended.
		const filler = Array.from({ length: 7 }, (_, i) => `  const filler${i} = ${i};`);
		const code = [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, data: string) {",
			"  mkdirSync(join(cwd, 'out'));",
			...filler,
			"  const recursive = true;",
			"  writeFileSync(join(cwd, 'out', 'r.json'), data);",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.map((m) => m.line)).toEqual([13]);
	});

	it("does not treat a guard on the write's own line as a PRIOR guard", () => {
		// hasPriorGuardInLines doc (231-232): scan covers lines before the write
		// (exclusive end).
		const code = [
			"import { existsSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  writeFileSync(join(cwd, 'out', 'r.json'), existsSync(cwd) ? 'a' : 'b');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS).map((m) => m.line)).toEqual([4]);
	});
});

describe("detectWriteWithoutMkdir — reporting contract", () => {
	it("reports one finding per line even when a line holds two unguarded writes", () => {
		// Return doc (271-272): one InlineMatch per reported line.
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  writeFileSync(join(cwd, 'a', 'x'), 1); writeFileSync(join(cwd, 'b', 'y'), 2);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toHaveLength(1);
	});

	it("caps findings at 10 per file (header: Max 10 findings per file)", () => {
		const writes = Array.from(
			{ length: 12 },
			(_, i) => `  writeFileSync(join(cwd, 'out', 'f${i}.json'), d);`,
		);
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, d: string) {",
			...writes,
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toHaveLength(10);
	});

	it("truncates the reported text to 150 characters", () => {
		// Return doc (271-272): "truncated to 150 chars".
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			`  writeFileSync(join(cwd, 'out', '${"x".repeat(200)}'), d);`,
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toHaveLength(150);
	});

	it("reports the trimmed source line (no leading indentation)", () => {
		// Return doc (271-272): "raw line content, trimmed".
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string, d: string) {",
			"      writeFileSync(join(cwd, 'out', 'f.json'), d);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)[0]?.text).toBe(
			"writeFileSync(join(cwd, 'out', 'f.json'), d);",
		);
	});
});

describe("detectHomedirWriteEscape — taint windows and exemptions", () => {
	it("taints a name declared across several lines when the home source is on a later line", () => {
		// statementEndLine doc (350-352): the statement ends where its brackets balance.
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function save(data: string) {",
			"  const target = join(",
			"    'a',",
			"    'b',",
			"    homedir(),",
			"    'c',",
			"  );",
			"  writeFileSync(target, data);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, "src/lib/save.ts").map((m) => m.line)).toEqual([11]);
	});

	it("does not taint a name by a home source on a LATER, independent statement", () => {
		// statementEndLine doc: a balanced one-line declaration is its own statement.
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function save(cwd: string, data: string) {",
			"  const out = join(cwd, 'x.json');",
			"  const h = homedir();",
			"  writeFileSync(out, data);",
			"  return h;",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, "src/lib/save.ts")).toEqual([]);
	});

	it("exempts __mocks__ directories like other test-support paths", () => {
		// HOME_TEST_PATH_RE doc (347-348): test paths are the sandbox's job.
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"export function log(row: string) {",
			"  appendFileSync(join(homedir(), '.tool', 'log.jsonl'), row);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, "src/lib/log.ts")).toHaveLength(1);
		expect(detectHomedirWriteEscape(code, "src/__mocks__/log.ts")).toEqual([]);
	});

	it("caps homedir findings at the shared per-file maximum of 10", () => {
		// MAX_MATCHES_PER_FILE (line 37) is shared; header line 27: "Max 10 findings per file".
		const writes = Array.from(
			{ length: 12 },
			(_, i) => `  appendFileSync(join(homedir(), 'f${i}'), row);`,
		);
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"export function log(row: string) {",
			...writes,
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, "src/lib/log.ts")).toHaveLength(10);
	});
});
