import { describe, expect, it } from "vitest";
import { findTopLevelBurden, TOP_LEVEL_BURDEN_LIMIT, topLevelWorkTokens } from "./top-level-burden.js";

const work = (content: string, path = "src/m.ts"): number => topLevelWorkTokens(content, path) ?? 0;

/** An object literal of many entries: data, not work. */
function tableModule(entries: number): string {
	const rows = Array.from({ length: entries }, (_, index) => `\tk${index}: ${index},`).join("\n");
	return `export const TABLE = {\n${rows}\n};\n`;
}
const bareCalls = (count: number): string => Array.from({ length: count }, (_, index) => `registry.set("name${index}", ${index});`).join("\n");

describe("findTopLevelBurden: fires on import-time work", () => {
	it("P1: many bare call statements reach the limit and fire once, at line 1", () => {
		const matches = findTopLevelBurden(bareCalls(160), "src/registry.js");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("import-time work");
	});
	it("P2: loops, conditionals, try and await at the top level count", () => {
		const body = Array.from({ length: 60 }, (_, index) => `\tcount${index} += step${index};`).join("\n");
		const content = `for (const file of files) {\n${body}\n}\nif (ready) {\n${body}\n}\ntry {\n${body}\n} catch {\n\treset();\n}\nawait boot();\n`;
		expect(findTopLevelBurden(content, "src/boot.ts")).toHaveLength(1);
	});
	it("P3: a const initialised by an effect call or an await counts", () => {
		expect(work("const text = fs.readFileSync(path, \"utf8\");\nconst data = await load(text);\n")).toBeGreaterThan(10);
	});
	it("P4: a class static block counts and an instance field does not", () => {
		expect(work("class A { static { init(); } }\n")).toBeGreaterThan(0);
		expect(work("class A { field = make(); }\n")).toBe(0);
	});
});

describe("findTopLevelBurden: does not fire on data, declarations and declarative builders", () => {
	it("N1: a large literal object or array is data", () => {
		expect(findTopLevelBurden(tableModule(400), "src/table.ts")).toEqual([]);
		expect(work(`export const LIST = [${"1, ".repeat(600)}];\n`)).toBe(0);
	});
	it("N2: pure declarations and function bodies do not count", () => {
		const rows = Array.from({ length: 400 }, (_, index) => `\t\tk${index}: ${index},`).join("\n");
		expect(findTopLevelBurden(`export function table() {\n\treturn {\n${rows}\n\t};\n}\nexport class C {}\ninterface I { a: number }\ntype T = string;\nenum E { A }\n`, "src/t.ts")).toEqual([]);
	});
	it("N3: declarative schema and builder chains with literal, identifier and builder arguments do not count", () => {
		const schema = Array.from({ length: 200 }, (_, index) => `export const s${index} = z.object({ a${index}: z.string().min(1), b: z.number().optional(), c: z.array(otherSchema) });`).join("\n");
		expect(findTopLevelBurden(schema, "src/schemas.ts")).toEqual([]);
		expect(work("export const load = createAction('[X] load', props<{ id: string }>());\nexport const r = createReducer(initialState, on(load, (state) => state));\nexport default defineConfig({ a: 1, b: [1, 2] });\n")).toBe(0);
	});
	it("N4: a small module, a test file, declaration, generated paths and other languages are out of scope", () => {
		expect(findTopLevelBurden(bareCalls(3), "src/small.ts")).toEqual([]);
		expect(findTopLevelBurden(bareCalls(160), "src/table.test.ts")).toEqual([]);
		expect(findTopLevelBurden(bareCalls(160), "types/table.d.ts")).toEqual([]);
		expect(findTopLevelBurden(bareCalls(160), "src/__generated__/table.ts")).toEqual([]);
		expect(findTopLevelBurden("x = 1\n".repeat(400), "src/table.py")).toEqual([]);
	});
	it("N5: the limit is the score's half-burden knot", () => {
		expect(TOP_LEVEL_BURDEN_LIMIT).toBe(500);
	});
});
