import { describe, expect, it } from "vitest";
import { withCheckRoot } from "./check-root.js";
import { detectNumericZeroDefault } from "./numeric-zero-default.js";

const scan = (source: string) => withCheckRoot("/project", () => detectNumericZeroDefault(source, "/project/source.ts"));

describe("numeric_zero_default source facts", () => {
	it.each(["Number(raw)", "parseInt(raw, 10)", "Number.parseInt(raw, 10)", "parseFloat(raw)", "Number.parseFloat(raw)"])("P1: observes zero falling through a resolved %s result", parser => {
		const result = scan(`const value = ${parser} || 2;`);
		expect(result.result).toHaveLength(1);
		expect(result.result[0]).toMatchObject({ line: 1, text: expect.stringContaining("zero") });
		expect(result.notMeasured).toEqual([]);
	});
	it("P2: retains the originating bounded helper and its valid-zero caller as source evidence", () => {
		// Originating ec85adc60497c80ccca037f83a9a3bad7c8c572d search.ts:313.
		const result = scan('function boundedOption(raw, fallback, min, max) {\n const parsed = Number.parseInt(raw || String(fallback), 10) || fallback;\n return Math.min(Math.max(min, parsed), max);\n}\nconst context = boundedOption(opts.context, 2, 0, 10);');
		expect(result.result).toEqual([expect.objectContaining({ line: 2 })]);
	});
	it("P3: retains sirv endpoint and excludes its same-value starting-position default", () => {
		// Pinned sirv3.0.2 send(), primary source hashes retained in the private qualification receipt.
		const result = scan('let end = opts.end = parseInt(y, 10) || stats.size - 1;\nlet start = opts.start = parseInt(x, 10) || 0;');
		expect(result.result).toEqual([expect.objectContaining({ line: 1 })]);
	});
	it("P4: describes intentional zero-sentinel arithmetic without asserting a confirmed defect", () => {
		const result = scan('const amount = parseInt(raw, 10) || 2; // zero intentionally means default');
		expect(result.result).toHaveLength(1);
		expect(result.result[0]?.text).not.toMatch(/invalid|defect|must|valid zero/i);
	});
	it("P5: follows a stable local numeric result binding", () => {
		expect(scan('const parsed = Number(raw);\nconst result = parsed || 2;').result).toEqual([expect.objectContaining({ line: 2 })]);
	});
	it.each([
		'const value = parseInt(raw, 10) || 0;',
		'const value = parseInt(raw, 10) || -0;',
		'const ZERO = 0; const value = parseInt(raw, 10) || ZERO;',
		'const value = parseInt(raw, 10) ?? 2;',
		'const parsed = Number.parseInt(raw, 10); const value = Number.isNaN(parsed) ? 2 : parsed;',
		'function read(Number) { return Number(raw) || 2; }',
		'function read(parseInt) { return parseInt(raw) || 2; }',
		'import { Number } from "other"; const value = Number(raw) || 2;',
		'import { parseInt } from "other"; const value = parseInt(raw) || 2;',
		'function read() { const value = Number(raw) || 2; var Number; }',
		'const { parseInt } = custom; const value = parseInt(raw) || 2;',
		'try { work(); } catch (Number) { const value = Number(raw) || 2; }',
		'for (let Number of values) { const value = Number(raw) || 2; }',
		'class Number {} const value = Number(raw) || 2;',
		'namespace Number { export const parseInt = custom; } const value = Number.parseInt(raw) || 2;',
		'const other = object.Number(raw) || 2;',
	])("N1: preserves exclusions and value shadowing for %s", source => {
		expect(scan(source).result).toEqual([]);
	});
	it("P6: type-only names do not shadow the runtime numeric constructor", () => {
		expect(scan('type Number = { field: string }; const value = Number(raw) || 2;').result).toHaveLength(1);
	});
	it.each([
		'let parsed = Number(raw); parsed = replacement; const value = parsed || 2;',
		'Number.parseInt = custom; const value = Number.parseInt(raw) || 2;',
		'parseInt = custom; const value = parseInt(raw) || 2;',
	])("retains explicit unknown evidence for numeric mutation in %s", source => {
		const result = scan(source);
		expect(result.result).toEqual([]);
		expect(result.notMeasured.join("\n")).toContain("numeric_zero_default");
	});
	it("N2: comments, strings, unrelated calls and other languages are quiet", () => {
		expect(scan('// Number(raw) || 2\nconst example = "parseInt(raw) || 2"; const value = loadConfig() || {};').result).toEqual([]);
		expect(detectNumericZeroDefault("value = Number(raw) || 2", "source.py")).toEqual([]);
	});
	it("describes a conditional zero result without asserting it is reachable for a fixed nonzero argument", () => {
		expect(scan('const value = Number(1) || 2;').result[0]?.text).toContain("If");
	});
	it("retains unknown when a numeric constructor receiver escapes through an unknown method", () => {
		const result = scan('Number.normalize(); const value = Number.parseInt(raw, 10) || 2;');
		expect(result.result).toEqual([]);
		expect(result.notMeasured.length).toBeGreaterThan(0);
	});
});
