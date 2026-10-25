import { describe, expect, it } from "vitest";
import { checkMisusedPromises } from "./agent-safety-async.js";

describe("awaited forEach receiver evidence", () => {
	it("still reports async callbacks on a const array despite awaiting forEach", () => {
		const source = "const values = [1, 2];\nawait values.forEach(async (value) => { await save(value); });";
		expect(checkMisusedPromises(source, "src/work.ts")).toEqual([{ line: 2, text: source.split("\n")[1] }]);
	});
	it("follows a const array alias through array-producing methods", () => {
		const source = "const values = [1, 2];\nconst copy = values;\nawait copy.filter(Boolean).forEach(async (value) => save(value));";
		expect(checkMisusedPromises(source, "src/work.ts").map((match) => match.line)).toEqual([3]);
	});
	it("keeps an awaited stream receiver eligible and does not confuse shadowed names", () => {
		const source = "const values = [1, 2];\nasync function consume(values) {\n  await values.forEach(async (value) => save(value));\n}";
		expect(checkMisusedPromises(source, "src/work.ts")).toEqual([]);
		expect(checkMisusedPromises("await getStream().forEach(async (value) => save(value));", "src/work.ts")).toEqual([]);
	});
	it("does not treat a reassigned binding as array evidence", () => {
		const source = "let values = [1, 2];\nvalues = getStream();\nawait values.forEach(async (value) => save(value));";
		expect(checkMisusedPromises(source, "src/work.ts")).toEqual([]);
	});
	it("keeps receiver evidence specific to one call when a line contains different receivers", () => {
		const source = "const values = [1, 2];\nvalues.forEach(save); await stream.forEach(async (value) => save(value));";
		expect(checkMisusedPromises(source, "src/work.ts")).toEqual([]);
	});
	it("still finds the exact array call after string literal text has been stripped", () => {
		const source = "const values = ['long literal']; await values.forEach(async (value) => save(value));";
		expect(checkMisusedPromises(source, "src/work.ts").map((match) => match.line)).toEqual([1]);
	});
});
