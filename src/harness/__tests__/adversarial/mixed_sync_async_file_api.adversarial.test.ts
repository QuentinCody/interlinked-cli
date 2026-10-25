// Independent adversarial false-positive review of `mixed_sync_async_file_api`
// (pre_block). The detector's contract is per-function: a nested helper's
// calls never taint its parent. Every negative below is a concise-body arrow
// (no braces) — the one nested-function shape the brace-balanced body
// extractor could not see — and fired before the 2026-10-21 refinement. Probe:
// scratch/2026-10-21-adversarial/mixed_sync_async_file_api.probe.mts
import { describe, expect, it } from "vitest";
import { checkMixedSyncAsyncFileApi } from "../../checks/ubs-language-specific/js-security-checks.js";

describe("mixed_sync_async_file_api — negative (must not fire)", () => {
	it("N1: sync cleanup registered on process 'exit' inside an async setup (exit handlers must be sync)", () => {
		const src = [
			"import fs from 'node:fs';",
			"import fsp from 'node:fs/promises';",
			"export async function setup(dir: string) {",
			"  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));",
			"  await fsp.mkdir(dir, { recursive: true });",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/tmp.ts")).toEqual([]);
	});

	it("N2: a concise-arrow sync helper passed to .map inside an async function", () => {
		const src = [
			"import fs from 'node:fs';",
			"export async function sizes(dir: string) {",
			"  const stat = await fs.stat(dir);",
			"  return names.map((n) => fs.statSync(n).size);",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/sizes.ts")).toEqual([]);
	});

	it("N3: a concise async arrow awaiting fs, declared inside a sync function", () => {
		const src = [
			"import fs from 'node:fs';",
			"export function makeLoader(p: string) {",
			"  const head = fs.readFileSync(p, 'utf8').slice(0, 10);",
			"  const load = async () => await fs.readFile(p, 'utf8');",
			"  return { head, load };",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/lazy.ts")).toEqual([]);
	});

	it("N4: a concise-arrow sync fallback inside a .then chained on an awaited call", () => {
		const src = [
			"import fs from 'node:fs';",
			"export async function read(p: string, q: string) {",
			"  const a = await fs.readFile(p, 'utf8');",
			"  const b = await Promise.resolve().then(() => fs.readFileSync(q, 'utf8'));",
			"  return a + b;",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/fallback.ts")).toEqual([]);
	});

	it("N5: a concise arrow whose body starts on the next line is still its own function", () => {
		const src = [
			"import fs from 'node:fs';",
			"export async function read(p: string) {",
			"  const data = await fs.readFile(p, 'utf8');",
			"  const readSync = (q: string) =>",
			"    fs.readFileSync(q, 'utf8');",
			"  return { data, readSync };",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/multi.ts")).toEqual([]);
	});

	// Round 2 (same day, against the round-1 refinement): a concise body whose
	// fs call is not the FIRST token, and JSX prose.
	it("N6: a concise sync arrow wrapping fs in another call inside an async function", () => {
		const src = [
			"import fs from 'node:fs';",
			"export async function loadAll(dir: string, files: string[]) {",
			"  const entries = await fs.readdir(dir);",
			"  return files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/json.ts")).toEqual([]);
	});

	it("N7: a concise async arrow with a parenthesized await body inside a sync function", () => {
		const src = [
			"import fs from 'node:fs';",
			"export function makeLoader(p: string) {",
			"  const head = fs.readFileSync(p, 'utf8');",
			"  const load = async () => (await fs.readFile(p)).toString('utf8');",
			"  return { head, load };",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/lazy2.ts")).toEqual([]);
	});

	it("N8: a concise `void` exit handler inside an async setup", () => {
		const src = [
			"import fs from 'node:fs';",
			"export async function setup(dir: string) {",
			"  process.once('exit', () => void fs.rmSync(dir, { recursive: true }));",
			"  await fs.mkdir(dir, { recursive: true });",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/tmp2.ts")).toEqual([]);
	});

	it("N9: JSX prose in a docs component that quotes both APIs", () => {
		const src = [
			"import fs from 'node:fs';",
			"export function Migrate() {",
			"  return (",
			"    <p>",
			"      Replace fs.readFileSync(p) with await fs.readFile(p) everywhere.",
			"    </p>",
			"  );",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/docs/Migrate.tsx")).toEqual([]);
	});
});

describe("mixed_sync_async_file_api — positive (must fire)", () => {
	it("P1: a genuinely mixed function still fires on the await line", () => {
		const src = "async function f() {\n  fs.readFileSync(p);\n  await fs.readFile(q);\n}";
		expect(checkMixedSyncAsyncFileApi(src, "src/bad.ts")).toEqual([
			{ line: 3, text: "await fs.readFile(q);" },
		]);
	});

	it("P2: an unrelated concise arrow in the same body does not exempt a real mix", () => {
		const src = [
			"async function f(p, q) {",
			"  const x = ys.map((y) => y + 1);",
			"  fs.readFileSync(p);",
			"  await fs.readFile(q);",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/bad2.ts")).toEqual([
			{ line: 4, text: "await fs.readFile(q);" },
		]);
	});

	it("P3: a braced arrow body is scanned, not masked as a concise call", () => {
		const src = [
			"const g = async (p, q) => {",
			"  fs.readFileSync(p);",
			"  await fs.readFile(q);",
			"};",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/bad3.ts")).toEqual([
			{ line: 3, text: "await fs.readFile(q);" },
		]);
	});

	it("P4: an await whose line also holds a concise sync arrow still mixes when both target the parent", () => {
		const src = [
			"async function f(p, q) {",
			"  const r = (n) => n + 1;",
			"  const a = await fs.readFile(q);",
			"  const b = fs.readFileSync(p);",
			"  return r(a.length + b.length);",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/bad4.ts")).toEqual([
			{ line: 3, text: "const a = await fs.readFile(q);" },
		]);
	});

	it("P5: a concise arrow wrapping an unrelated call ends at its group's close paren", () => {
		const src = [
			"async function f(p, q) {",
			"  const xs = ys.map((y) => String(y));",
			"  fs.readFileSync(p);",
			"  await fs.readFile(q);",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/bad5.ts")).toEqual([
			{ line: 4, text: "await fs.readFile(q);" },
		]);
	});

	it("P6: a semicolon-free concise arrow ends at its line break (ASI)", () => {
		const src = [
			"async function f(p, q) {",
			"  const id = (x) => x",
			"  fs.readFileSync(p)",
			"  await fs.readFile(q)",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/bad6.ts")).toEqual([
			{ line: 4, text: "await fs.readFile(q)" },
		]);
	});

	it("P7: JSX blanking does not hide a real mix in a component's code", () => {
		const src = [
			"export async function Page({ p, q }) {",
			"  const a = fs.readFileSync(p);",
			"  const b = await fs.readFile(q);",
			"  return <p>{a.length + b.length}</p>;",
			"}",
		].join("\n");
		expect(checkMixedSyncAsyncFileApi(src, "src/Page.tsx")).toEqual([
			{ line: 3, text: "const b = await fs.readFile(q);" },
		]);
	});
});
