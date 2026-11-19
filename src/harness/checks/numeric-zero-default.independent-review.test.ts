import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCheckRoot } from "./check-root.js";
import { detectNumericZeroDefault } from "./numeric-zero-default.js";
import { withNumericZeroDefaultEvidence } from "./numeric-zero-default-evidence.js";
import { withProjectCheckEvidence } from "./project-check-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function local(source: string) { return withCheckRoot("/independent", () => detectNumericZeroDefault(source, "/independent/source.ts")); }
function fixture(helper: string, caller = 'import { readNumber } from "./parser.js";\nconst value = readNumber(raw) || 2;') {
	const root = mkdtempSync(join(process.cwd(), "scratch", "numeric-independent-")); roots.push(root);
	writeFileSync(join(root, "parser.ts"), helper); writeFileSync(join(root, "caller.ts"), caller);
	return { root, helper: join(root, "parser.ts"), caller: join(root, "caller.ts") };
}
function project(helper: string) {
	const files = fixture(helper), gaps: unknown[] = [];
	const matches = withProjectCheckEvidence(files.root, [files.helper, files.caller], () => detectNumericZeroDefault(readFileSync(files.caller, "utf8"), files.caller), gap => gaps.push(gap));
	return { matches, gaps };
}

describe("independent numeric lexical scopes", () => {
	it("N1 class-expression names bind inside methods", () => {
		expect(local('const X = class Number { method(raw) { return Number(raw) || 2; } };').result).toEqual([]);
	});
	it("P1 switch lexical names do not shadow an outside builtin", () => {
		expect(local('switch (tag) { case "x": const Number = custom; break; } const value = Number(raw) || 2;').result).toHaveLength(1);
	});
	it("P2 static-block var declarations stay inside the static block", () => {
		expect(local('class X { static { var Number = custom; } } const value = Number(raw) || 2;').result).toHaveLength(1);
	});
	it("P3 arithmetic wording stays conditional for a known nonzero input", () => {
		const match = local("const value = Number(1) || 2;").result[0];
		expect(match?.text).toMatch(/\bIf\b|\bwould\b/);
	});
});

const nonNumericWrappers = [
	'async function readNumber(raw) { return Number(raw); }',
	'function* readNumber(raw) { return Number(raw); }',
	'const readNumber = async raw => Number(raw);',
];
describe.each(nonNumericWrappers)("independent nonnumeric invocation result %s", helper => {
	it("N2 a local Promise/iterator cannot become numeric zero through direct invocation", () => {
		expect(local(`${helper}\nconst value = readNumber(raw) || 2;`).result).toEqual([]);
	});
	it("N3 an imported Promise/iterator cannot become numeric zero through direct invocation", () => {
		expect(project(`export ${helper}`).matches).toEqual([]);
	});
});

it.each([
	['export default function readNumber(raw) { return Number(raw); }', 'import parse from "./parser.js";\nconst value = parse(raw) || 2;'],
	['export default function(raw) { return Number(raw); }', 'import parse from "./parser.js";\nconst value = parse(raw) || 2;'],
	['function parse(raw) { return Number(raw); } export { parse as readNumber };', 'import { readNumber } from "./parser.js";\nconst value = readNumber(raw) || 2;'],
])("P4 helper-only hooks retain supported exported consumers %s", (helper, caller) => {
	const files = fixture(helper, caller), gaps: unknown[] = [];
	const matches = withNumericZeroDefaultEvidence({ root: files.root, importers: () => ({ files: [files.caller], complete: false }), onUnavailable: gap => gaps.push(gap) },
		() => detectNumericZeroDefault(readFileSync(files.helper, "utf8"), files.helper));
	expect(matches).toHaveLength(1);
	expect(matches[0]?.text).toContain("caller.ts:2");
	expect(gaps.length).toBeGreaterThan(0);
});

it("N4 opaque missing relative helpers do not manufacture numeric provenance", () => {
	const files = fixture('export const other = 1;', 'import { loadConfig } from "./missing.js";\nconst config = loadConfig(raw) || defaults;');
	const gaps: unknown[] = [];
	const matches = withProjectCheckEvidence(files.root, [files.caller, files.helper], () => detectNumericZeroDefault(readFileSync(files.caller, "utf8"), files.caller), gap => gaps.push(gap));
	expect({ matches, gaps }).toEqual({ matches: [], gaps: [] });
});

it.each([
	'const N = Number; N.parseInt = custom; const value = Number.parseInt(raw) || 2;',
	'Object.assign(Number, { parseInt: custom }); const value = Number.parseInt(raw) || 2;',
])("N5 source-visible receiver mutation makes builtin attribution unknown %s", source => {
	const result = local(source);
	expect(result.result).toEqual([]);
	expect(result.notMeasured.length).toBeGreaterThan(0);
});
