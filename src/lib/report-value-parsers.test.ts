import { expect, it } from "vitest";
import {
	isRepositoryPath, nonNegativeInteger, nullableString, requiredString,
	stringList, uniqueCanonicalStrings,
} from "./report-value-parsers.js";

it("distinguishes an absent or invalid field from an explicitly null value", () => {
	expect(nullableString(null)).toBeNull();
	expect(nullableString("")).toBeUndefined();
	expect(nullableString(undefined)).toBeUndefined();
	expect(requiredString(" ")).toBe(" ");
	expect(nonNegativeInteger(0)).toBe(0);
	expect(nonNegativeInteger(0.5)).toBeNull();
	expect(nonNegativeInteger(-1)).toBeNull();
});

it("copies the input list and checks strict code-unit ordering", () => {
	const input = ["Z", "a"];
	const result = stringList(input);
	input.push("b");
	expect(result).toEqual(["Z", "a"]);
	expect(stringList([1])).toBeNull();
	expect(uniqueCanonicalStrings(["Z", "a"])).toBe(true);
	expect(uniqueCanonicalStrings(["a", "a"])).toBe(false);
	expect(uniqueCanonicalStrings(["a", "Z"])).toBe(false);
});

it("requires repository paths in canonical slash-separated form", () => {
	expect(isRepositoryPath("docs/a.md")).toBe(true);
	for (const path of ["", "/tmp/a", "C:a", "a\\b", "./a", "a/../b", "a//b"]) {
		expect(isRepositoryPath(path)).toBe(false);
	}
});
