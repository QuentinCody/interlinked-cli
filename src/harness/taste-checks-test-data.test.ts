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

describe("assertions delegated to helpers — negative (must not fire)", () => {
	it("N1: a test that calls a same-file function whose body asserts", () => {
		const content = [
			"function driver(run) {",
			"  return { verify() { assert.equal(run(), 0); } };",
			"}",
			'it.each(SCENARIOS)("$name", async scenario => {',
			"  await scenario.run(driver(start));",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([]);
	});

	it("N2: an arrow helper that asserts through another asserting helper", () => {
		const content = [
			"const checkReport = (report) => {",
			"  expect(report.status).toBe(\"complete\");",
			"};",
			"const runAndCheck = async (input) => {",
			"  checkReport(await run(input));",
			"};",
			'it("completes", async () => {',
			"  await runAndCheck(1);",
			"});",
		].join("\n");
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([]);
	});

	it("N3: a call to an imported assertX helper", () => {
		const content = 'it("serves the session", async () => {\n  fixture.assertServed(await fixture.hook());\n});';
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([]);
	});
});

describe("assertions delegated to helpers — positive (must fire)", () => {
	it("P1: a called same-file helper that never asserts", () => {
		const content = "function setup() {\n  return start();\n}\nit(\"starts\", () => {\n  setup();\n});";
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([{ line: 4, text: 'it("starts", () => {' }]);
	});

	it("P2: an asserting helper that the test reaches only as another object's method", () => {
		const content = "function verify() {\n  expect(1).toBe(1);\n}\nit(\"checks\", () => {\n  client.verify();\n});";
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([{ line: 4, text: 'it("checks", () => {' }]);
	});

	it("P3: an expression-bodied arrow does not borrow the next function's assertion", () => {
		const content = "const run = () => compute();\nfunction unused() {\n  expect(1).toBe(1);\n}\nit(\"runs\", () => {\n  run();\n});";
		expect(checkAssertionFreeTest(content, "flow.test.ts")).toEqual([{ line: 5, text: 'it("runs", () => {' }]);
	});
});
