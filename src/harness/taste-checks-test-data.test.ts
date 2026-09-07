import { describe, expect, it } from "vitest";
import { checkAssertionFreeTest } from "./taste-checks-test-assertions.js";

describe("assertions in parameterized test bodies", () => {
	it("does not mistake a data factory for the asserting callback", () => {
		const content = [
			"it.each([",
			'  ["case", () => parse({ nested: [] })],',
			'] as const)("rejects %s", (_name, parse) => {',
			"  expect(parse).toThrow();",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "boundary.test.ts")).toEqual([]);
	});

	it("does not borrow an assertion from a data factory", () => {
		const content = [
			"it.each([",
			"  () => { expect(value).toBe(42); return value; },",
			'])("processes a case", (factory) => {',
			"  processCase(factory);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "boundary.test.ts")).toEqual([
			{ line: 1, text: "it.each([" },
		]);
	});

	it("still checks the next ordinary test after a parameterized callback", () => {
		const content = 'it.each([() => ({})])("case", (factory) => { expect(factory()).toEqual({}); });\nit("empty", () => { processCase(); });';
		expect(checkAssertionFreeTest(content, "boundary.test.ts")).toEqual([
			{ line: 2, text: 'it("empty", () => { processCase(); });' },
		]);
	});
});
