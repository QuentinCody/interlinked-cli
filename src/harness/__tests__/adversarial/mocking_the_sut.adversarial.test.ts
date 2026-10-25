// Independent adversarial review of the `mocking_the_sut` pre_block check
// (2026-10-21). Each negative case is realistic test code the detector flagged
// before the refinement in taste-checks-test-assertions.ts; the positives pin
// that the refinement did not weaken the true-positive shapes.

import { describe, expect, it } from "vitest";
import { checkMockingTheSUT } from "../../taste-checks-test-assertions.js";

const SUT_TEST = "/repo/src/foo.test.ts";

describe("mocking_the_sut — negative (must not fire)", () => {
	it("N1: vitest automock with spies keeps the original implementation", () => {
		// `{ spy: true }` (vitest >= 3) wraps every export in a spy WITHOUT
		// replacing its body: the SUT still runs, the test only observes calls.
		const content = [
			'import { describe, expect, it, vi } from "vitest";',
			'import { foo, helper } from "./foo";',
			'vi.mock("./foo", { spy: true });',
			'it("foo calls helper", () => {',
			"\tfoo();",
			"\texpect(helper).toHaveBeenCalled();",
			"});",
		].join("\n");
		expect(checkMockingTheSUT(content, SUT_TEST)).toEqual([]);
	});

	it("N2: the spy option formatted across lines", () => {
		const content = ['vi.mock("./foo", {', "\tspy: true,", "});"].join("\n");
		expect(checkMockingTheSUT(content, SUT_TEST)).toEqual([]);
	});

	it("N3: the spy option with loose spacing and a trailing comment", () => {
		const content = 'vi.mock("./foo", { spy : true }); // keep real impl, observe calls';
		expect(checkMockingTheSUT(content, SUT_TEST)).toEqual([]);
	});

	it("N4: a mock call that is fixture TEXT inside a string, not code", () => {
		const content = [
			'import { renderMock } from "./gen-mock";',
			'it("renders a vi.mock line", () => {',
			"\texpect(renderMock('./gen-mock')).toBe('vi.mock(\"./gen-mock\");');",
			"});",
		].join("\n");
		expect(checkMockingTheSUT(content, "/repo/src/gen-mock.test.ts")).toEqual([]);
	});

	it("N5: a mock call that is fixture TEXT inside a template literal", () => {
		const content = ["const fixture = `", 'vi.mock("./gen-mock");', "`;", "expect(scan(fixture)).toHaveLength(1);"].join("\n");
		expect(checkMockingTheSUT(content, "/repo/src/gen-mock.test.ts")).toEqual([]);
	});

	it("N6: the ts-jest interop spread that makes exports spy-able, with no overrides", () => {
		// Makes the module object's exports configurable so `jest.spyOn(foo, "x")`
		// works; every export is still the real one.
		const content = [
			'import * as foo from "./foo";',
			'jest.mock("./foo", () => ({',
			"\t__esModule: true,",
			'\t...jest.requireActual("./foo"),',
			"}));",
			'it("calls helper", () => {',
			'\tconst spy = jest.spyOn(foo, "helper");',
			"\tfoo.run();",
			"\texpect(spy).toHaveBeenCalledWith(1);",
			"});",
		].join("\n");
		expect(checkMockingTheSUT(content, SUT_TEST)).toEqual([]);
	});

	it("N7: a factory that returns the actual module to undo a setup-file mock", () => {
		expect(checkMockingTheSUT('jest.mock("./foo", () => jest.requireActual("./foo"));', SUT_TEST)).toEqual([]);
		expect(
			checkMockingTheSUT('vi.mock("./foo", async (importOriginal) => await importOriginal());', SUT_TEST),
		).toEqual([]);
		expect(checkMockingTheSUT('vi.mock("./foo", () => vi.importActual("./foo"));', SUT_TEST)).toEqual([]);
	});
});

describe("mocking_the_sut — positive (must fire)", () => {
	it("P1: a plain automock of the SUT still fires", () => {
		expect(checkMockingTheSUT('vi.mock("./foo");', SUT_TEST)).toHaveLength(1);
	});

	it("P2: `{ spy: false }` is a full automock and still fires", () => {
		expect(checkMockingTheSUT('vi.mock("./foo", { spy: false });', SUT_TEST)).toHaveLength(1);
	});

	it("P3: a factory whose RETURN object carries `spy: true` is still a replacement", () => {
		expect(checkMockingTheSUT('vi.mock("./foo", () => ({ spy: true }));', SUT_TEST)).toHaveLength(1);
	});

	it("P4: a real mock call on a line that also carries a string mentioning one", () => {
		const content = 'vi.mock("./foo"); // see "vi.mock(\\"./foo\\")" in the docs';
		expect(checkMockingTheSUT(content, SUT_TEST)).toHaveLength(1);
	});

	it("P5: a partial mock that overrides one export of the SUT still fires", () => {
		const content = 'vi.mock("./foo", async (importOriginal) => ({ ...(await importOriginal()), run: vi.fn() }));';
		expect(checkMockingTheSUT(content, SUT_TEST)).toHaveLength(1);
	});

	it("P6: a factory returning the actual of a DIFFERENT module replaces the SUT", () => {
		expect(checkMockingTheSUT('jest.mock("./foo", () => jest.requireActual("./bar"));', SUT_TEST)).toHaveLength(1);
	});
});
