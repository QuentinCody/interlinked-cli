import { describe, expect, it } from "vitest";
import { parseChangedFiles } from "./changed-files-option.js";

describe("parseChangedFiles", () => {
	it("returns undefined when the option is absent", () => {
		expect(parseChangedFiles()).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(parseChangedFiles("")).toBeUndefined();
	});

	it("splits a comma-separated list", () => {
		expect(parseChangedFiles("a.ts,b.ts")).toEqual(["a.ts", "b.ts"]);
	});

	it("trims surrounding whitespace on each entry", () => {
		expect(parseChangedFiles(" a.ts , b.ts ")).toEqual(["a.ts", "b.ts"]);
	});

	it("drops empty entries from repeated or trailing commas", () => {
		expect(parseChangedFiles("a.ts,,b.ts,")).toEqual(["a.ts", "b.ts"]);
	});

	it("returns an empty array when every entry is blank", () => {
		expect(parseChangedFiles(" , ")).toEqual([]);
	});
});
