import { describe, expect, it } from "vitest";
import { detectHomedirWriteEscape, detectWriteWithoutMkdir } from "./fs-write-safety.js";

const TS = "src/lib/foo.ts";
const JS = "src/lib/foo.js";
const PY = "src/lib/foo.py"; // non-JS/TS — should never fire

// ─── Positive cases (MUST fire) ──────────────────────────────────────────────

describe("detectWriteWithoutMkdir — positive cases", () => {
	it("flags writeFileSync with join(dir, sub, file) and no mkdir", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  writeFileSync(join(cwd, '.interlinked', 'metric-caps.json'), data);",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags appendFileSync with join(a, logs, x.log) and no mkdir", () => {
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function log(root: string, line: string) {",
			"  appendFileSync(join(root, 'logs', 'x.log'), line + '\\n');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags fs.writeFile with join(root, .tool, c.json) and no mkdir", () => {
		const code = [
			"import * as fs from 'node:fs';",
			"import { join } from 'node:path';",
			"function writeConfig(root: string, data: string, cb: () => void) {",
			"  fs.writeFile(join(root, '.tool', 'c.json'), data, cb);",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(4);
	});

	it("flags createWriteStream with string literal containing /", () => {
		const code = [
			"import { createWriteStream } from 'node:fs';",
			"function openLog() {",
			"  const stream = createWriteStream('logs/output.log');",
			"  stream.write('hello');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, JS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(3);
	});

	it("flags writeFileSync with string literal path containing /", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function init() {",
			"  writeFileSync('.interlinked/config.json', '{}');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(3);
	});
});

// ─── Negative cases (must NOT fire) ──────────────────────────────────────────

describe("detectWriteWithoutMkdir — negative cases (must NOT fire)", () => {
	it("does not fire when mkdirSync with recursive:true precedes the write", () => {
		const code = [
			"import { mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  mkdirSync(join(cwd, '.interlinked'), { recursive: true });",
			"  writeFileSync(join(cwd, '.interlinked', 'metric-caps.json'), data);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when mkdir (async) with recursive precedes the write", () => {
		const code = [
			"import { mkdir, writeFile } from 'node:fs/promises';",
			"import { join } from 'node:path';",
			"async function save(root: string) {",
			"  await mkdir(join(root, 'out'), { recursive: true });",
			"  await writeFile(join(root, 'out', 'result.json'), content);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire for writeFileSync('flat.txt', x) — no directory part", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function dump(x: string) {",
			"  writeFileSync('flat.txt', x);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when path is an opaque variable (cannot resolve statically)", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function dump(p: string, x: string) {",
			"  writeFileSync(p, x);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire for non-JS/TS file", () => {
		const code = [
			"with open('logs/output.log', 'w') as f:",
			"    f.write('hello')",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, PY)).toEqual([]);
	});

	it("does not fire when existsSync precedes the write", () => {
		const code = [
			"import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function save(cwd: string) {",
			"  if (!existsSync(join(cwd, 'out'))) {",
			"    mkdirSync(join(cwd, 'out'));",
			"  }",
			"  writeFileSync(join(cwd, 'out', 'result.json'), data);",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("does not fire when join has only 1 argument (not a nested path)", () => {
		// join with a single arg is unusual but syntactically valid
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"function dump(dir: string) {",
			"  writeFileSync(join(dir), 'data');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("N: mkdtempSync-created dir + two direct writes into it does not fire", () => {
		// Real campaign FP shape: a temp dir just created by mkdtempSync, then
		// two files written straight into it (no nesting below the temp dir).
		const code = [
			"import { mkdtempSync, writeFileSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			"function setup() {",
			"  const dir = mkdtempSync(join(tmpdir(), 'x-'));",
			"  writeFileSync(join(dir, '.env.example'), 'A=1');",
			"  writeFileSync(join(dir, 'wrangler.jsonc'), '{}');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("N: await mkdtemp (async) variant does not fire for a direct write", () => {
		const code = [
			"import { writeFile } from 'node:fs/promises';",
			"import { mkdtemp } from 'node:fs/promises';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			"async function setup() {",
			"  const dir = await mkdtemp(join(tmpdir(), 'x-'));",
			"  await writeFile(join(dir, 'config.json'), '{}');",
			"}",
		].join("\n");
		expect(detectWriteWithoutMkdir(code, TS)).toEqual([]);
	});

	it("P: a write nested two segments below an mkdtemp dir still fires (no mkdir for the sub dir)", () => {
		const code = [
			"import { mkdtempSync, writeFileSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			"function setup() {",
			"  const dir = mkdtempSync(join(tmpdir(), 'x-'));",
			"  writeFileSync(join(dir, 'nested', 'f.txt'), 'x');",
			"}",
		].join("\n");
		const out = detectWriteWithoutMkdir(code, TS);
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out[0]?.line).toBe(6);
	});
});

// ─── homedir_write_escape ────────────────────────────────────────────────────
// Class source: Stryker mutants of `INTERLINKED_HOME ?? homedir()` routed test
// corpus writes into the REAL ~/.interlinked (1443 rows, 2026-08-10). The
// detector flags production writes whose path derives from the user's home so
// the repo adds a suite-level HOME sandbox before the class can bite.

describe("detectHomedirWriteEscape — positive (must fire)", () => {
	it("P1: direct homedir() inside the write's path argument", () => {
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function log(row: string) {",
			"  appendFileSync(join(homedir(), '.tool', 'log.jsonl'), row);",
			"}",
		].join("\n");
		const out = detectHomedirWriteEscape(code, TS);
		expect(out.length).toBe(1);
		expect(out[0]?.line).toBe(5);
	});

	it("P2: one hop — const assigned from a homedir-derived join", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function save(data: string) {",
			"  const target = join(homedir(), '.tool', 'state.json');",
			"  writeFileSync(target, data);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS).length).toBe(1);
	});

	it("P3: two hops — local path fn with env-override fallback (the corpus.ts incident shape)", () => {
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function globalCorpusPath(): string {",
			"  const base = process.env.INTERLINKED_HOME ?? homedir();",
			"  return join(base, '.interlinked', 'findings-corpus.jsonl');",
			"}",
			"export function recordFinding(row: string) {",
			"  const gpath = globalCorpusPath();",
			"  appendFileSync(gpath, row);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS).length).toBeGreaterThanOrEqual(1);
	});

	it("P4: process.env.HOME in a template-literal path", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"function persist(x: string) {",
			"  writeFileSync(`${process.env.HOME}/.toolrc`, x);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS).length).toBe(1);
	});
});

describe("detectHomedirWriteEscape — negative (must not fire)", () => {
	it("N1: test files are exempt (they are the sandbox's job, not the detector's)", () => {
		const code = [
			"import { appendFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"appendFileSync(join(homedir(), '.tool', 'log.jsonl'), 'x');",
		].join("\n");
		expect(detectHomedirWriteEscape(code, "src/lib/foo.test.ts")).toEqual([]);
	});

	it("N2: homedir used read-only; the write targets a repo-local path", () => {
		const code = [
			"import { readFileSync, writeFileSync } from 'node:fs';",
			"import { homedir } from 'node:os';",
			"import { join } from 'node:path';",
			"function transform(cwd: string) {",
			"  const creds = readFileSync(join(homedir(), '.claude', 'creds.json'), 'utf8');",
			"  writeFileSync(join(cwd, 'out.json'), creds.length.toString());",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS)).toEqual([]);
	});

	it("N3: tmpdir-derived writes are not home writes", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { tmpdir } from 'node:os';",
			"import { join } from 'node:path';",
			"function scratch(x: string) {",
			"  writeFileSync(join(tmpdir(), 'probe.json'), x);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS)).toEqual([]);
	});

	it("N4: non-JS/TS files never fire", () => {
		const code = "with open(os.path.expanduser('~/.tool/x'), 'w') as f: f.write('y')";
		expect(detectHomedirWriteEscape(code, PY)).toEqual([]);
	});

	it("N5: homedir mentioned only in comments/strings does not taint a repo-local write", () => {
		const code = [
			"import { writeFileSync } from 'node:fs';",
			"import { join } from 'node:path';",
			"// mirrors what ships to homedir() installs",
			"function save(cwd: string, x: string) {",
			"  const note = 'homedir() layout';",
			"  writeFileSync(join(cwd, 'layout.json'), note + x);",
			"}",
		].join("\n");
		expect(detectHomedirWriteEscape(code, TS)).toEqual([]);
	});
});
