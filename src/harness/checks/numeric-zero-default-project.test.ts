import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCheckRoot } from "./check-root.js";
import { withNumericZeroDefaultEvidence } from "./numeric-zero-default-evidence.js";
import { detectNumericZeroDefault } from "./numeric-zero-default.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";
import { withProposedFiles } from "./proposed-files.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(parser = 'export const readNumber = raw => Number.parseInt(raw, 10);') {
	const root = mkdtempSync(join(process.cwd(), "scratch", "numeric-zero-project-")); roots.push(root);
	const caller = join(root, "caller.ts"), helper = join(root, "parser.ts");
	writeFileSync(caller, 'import { readNumber as parse } from "./parser.js";\nconst value = parse(raw) || 2;');
	writeFileSync(helper, parser);
	return { root, caller, helper };
}
function project(root: string, target: string) {
	const gaps: { file: string; reason: string }[] = [];
	const matches = withProjectCheckEvidence(root, ["caller.ts", "parser.ts"], () => detectNumericZeroDefault(readFileSync(target, "utf8"), target), gap => gaps.push(gap));
	return { matches, gaps };
}

describe("numeric_zero_default imported numeric helpers", () => {
	it("P1: follows a stable exported raw parser wrapper with named import alias", () => {
		const { root, caller } = fixture();
		const result = project(root, caller);
		expect(result.matches).toEqual([expect.objectContaining({ line: 2, text: expect.stringContaining("parser.ts") })]);
		expect(result.matches[0]?.sourceEvidence).toEqual(expect.arrayContaining([
			expect.objectContaining({ file: "parser.ts", role: "producer", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
			expect.objectContaining({ file: "caller.ts", role: "consumer", line: 2 }),
		]));
		expect(result.gaps).toEqual([]);
	});
	it("P2: follows default function export and a stable local alias result", () => {
		const { root, caller } = fixture('export default function parse(raw) { return Number(raw); }');
		writeFileSync(caller, 'import parse from "./parser.js";\nconst numeric = parse(raw);\nconst value = numeric || 2;');
		expect(project(root, caller).matches).toEqual([expect.objectContaining({ line: 3 })]);
	});
	it("resolves a relative target path from the selected foreign root", () => {
		const { root, caller } = fixture();
		const result = withProjectCheckEvidence(root, ["caller.ts", "parser.ts"], () => detectNumericZeroDefault(readFileSync(caller, "utf8"), "caller.ts"));
		expect(result).toHaveLength(1);
		expect(result[0]?.sourceEvidence?.map(source => source.file)).toEqual(["parser.ts", "caller.ts"]);
	});
	it.each([
		'export function readNumber(raw) { return Number.isNaN(Number(raw)) ? 2 : Number(raw); }',
		'export const readNumber = raw => ({ raw });',
		'export const readNumber = raw => "value";',
	])("N1: excludes normalized or nonnumeric helper returns in %s", parser => {
		const { root, caller } = fixture(parser);
		expect(project(root, caller).matches).toEqual([]);
	});
	it.each([
		'export let readNumber = raw => Number(raw); readNumber = custom;',
		'export function readNumber(raw) { return Number(raw); } readNumber = custom;',
		'export function readNumber(raw): number { if (raw) return Number(raw); return custom(raw); }',
		'export declare function readNumber(raw): number;',
		'export function readNumber(raw): number { return custom(raw); }',
	])("retains unknown for a relevant mutable/opaque parser in %s", parser => {
		const { root, caller } = fixture(parser);
		const result = project(root, caller);
		expect(result.matches).toEqual([]);
		expect(result.gaps.length).toBeGreaterThan(0);
	});
	it("retains the full late source population and reads a shared helper once per query invocation", () => {
		const { root, caller, helper } = fixture();
		const content = 'import { readNumber } from "./parser.js";\n' + '// padding\n'.repeat(110_000)
			+ Array.from({ length: 40 }, (_, index) => `const count${index} = readNumber(raw) || 2;`).join("\n");
		let reads = 0, queries = 0;
		const matches = withNumericZeroDefaultEvidence({ root, importers: () => { queries++; return { files: [], complete: false }; }, readFile: file => { reads++; return readFileSync(file, "utf8"); } }, () => detectNumericZeroDefault(content, caller));
		expect(matches).toHaveLength(40);
		expect(matches.at(-1)?.line).toBe(110_041);
		expect(reads).toBe(1);
		expect(queries).toBe(0);
		writeFileSync(helper, 'export const readNumber = raw => "updated";');
		expect(withNumericZeroDefaultEvidence({ root, importers: () => ({ files: [], complete: false }) }, () => detectNumericZeroDefault(content, caller))).toEqual([]);
	});
	it("N2: arbitrary unrelated opaque helpers do not create numeric gaps", () => {
		const { root, caller } = fixture('export function readNumber(raw) { return loadConfig(raw); }');
		expect(project(root, caller)).toEqual({ matches: [], gaps: [] });
	});
	it("does not attach numeric gaps to an unresolved arbitrary configuration loader", () => {
		const { root, caller, helper } = fixture();
		unlinkSync(helper);
		writeFileSync(caller, 'import { loadConfig } from "./missing.js"; const config = loadConfig() || {};');
		expect(project(root, caller)).toEqual({ matches: [], gaps: [] });
	});
	it.each([
		'export default function readNumber(raw) { return Number(raw); }',
		'const readNumber = raw => Number(raw); export { readNumber as parse };',
	])("retains supported helper-only default/alias export evidence in %s", parser => {
		const { root, caller, helper } = fixture(parser);
		writeFileSync(caller, parser.startsWith("export default") ? 'import parse from "./parser.js"; const value = parse(raw) || 2;' : 'import { parse } from "./parser.js"; const value = parse(raw) || 2;');
		const matches = withNumericZeroDefaultEvidence({ root, importers: () => ({ files: [caller], complete: false }) }, () => detectNumericZeroDefault(readFileSync(helper, "utf8"), helper));
		expect(matches).toHaveLength(1);
	});
	it("uses changed helper bytes and records deleted selected dependencies", () => {
		const { root, caller, helper } = fixture();
		const gaps: unknown[] = [];
		withProjectCheckEvidence(root, [caller, helper], () => {
			expect(detectNumericZeroDefault(readFileSync(caller, "utf8"), caller)).toHaveLength(1);
			withProposedFiles(new Map([[helper, 'export const readNumber = raw => "fixed";']]), () => {
				expect(detectNumericZeroDefault(readFileSync(caller, "utf8"), caller)).toEqual([]);
			});
			expect(detectNumericZeroDefault(readFileSync(caller, "utf8"), caller)).toHaveLength(1);
			withProposedFiles(new Map([[helper, null]]), () => expect(detectNumericZeroDefault(readFileSync(caller, "utf8"), caller)).toEqual([]));
		}, gap => gaps.push(gap));
		expect(gaps.length).toBeGreaterThan(0);
	});
	it("checks helper-only hook imports at the helper location and retains partial reverse scope", () => {
		const { root, helper, caller } = fixture();
		const gaps: { file: string; reason: string }[] = [];
		const matches = withNumericZeroDefaultEvidence({ root, importers: () => ({ files: [caller], complete: false }), onUnavailable: input => gaps.push(input) }, () => detectNumericZeroDefault(readFileSync(helper, "utf8"), helper));
		expect(matches).toEqual([expect.objectContaining({ line: 1, text: expect.stringContaining("caller.ts:2") })]);
		expect(gaps.some(gap => /partial/i.test(gap.reason))).toBe(true);
	});
	it("does not emit helper-only duplicates in a full foreground population", () => {
		const { root, helper } = fixture();
		expect(project(root, helper).matches).toEqual([]);
	});
	it("does not consume outside-root symlink bytes through a supplied reader", () => {
		const { root, caller, helper } = fixture();
		const other = fixture();
		unlinkSync(helper); symlinkSync(other.helper, helper);
		let outsideReads = 0;
		const result = withCheckRoot(root, () => withNumericZeroDefaultEvidence({ root, importers: () => ({ files: [], complete: false }), readFile: file => { outsideReads++; return readFileSync(file, "utf8"); } }, () => detectNumericZeroDefault(readFileSync(caller, "utf8"), caller)));
		expect(result.result).toEqual([]);
		expect(outsideReads).toBe(0);
		expect(result.notMeasured.join()).toContain("outside");
	});
});
