import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	checkMockingTheSutSelf,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality-sut.js";

const TEST = "src/lib/foo.test.ts";
const SRC = "src/lib/foo.ts";

describe("checkTestMissingSutImport", () => {
	it("flags a test file that imports no SUT and no other project source", () => {
		const code = `import { describe, it, expect } from "vitest";\nit("does a thing", () => { expect(1).toBe(1); });\n`;
		const matches = checkTestMissingSutImport(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("does not import its SUT");
	});

	it("does not fire when the file imports its own SUT", () => {
		const code = `import { foo } from "./foo.js";\nit("works", () => { expect(foo()).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("does not fire on the index.test.ts / non-strict-test carve-outs", () => {
		expect(checkTestMissingSutImport(`it("x", () => {});`, SRC)).toEqual([]);
	});

	it("is exempt when the file spawns the SUT as a subprocess", () => {
		const code = `import { execSync } from "node:child_process";\nit("runs the script", () => { execSync("node foo.mjs"); });\n`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("is exempt for a regression-suite-named file with no companion module", () => {
		const code = `it("regressed once", () => { expect(1).toBe(1); });\n`;
		expect(checkTestMissingSutImport(code, "src/lib/bugs.test.ts")).toEqual([]);
	});

	it("is exempt for a multi-module suite importing 3+ cross-directory sources", () => {
		const code = `
import { a } from "../a.js";
import { b } from "../b.js";
import { c } from "../c.js";
it("covers three modules", () => { expect(1).toBe(1); });
`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});
});

describe("checkMockingTheSutSelf", () => {
	it("flags vi.mock of the same-directory SUT", () => {
		const code = `vi.mock("./foo");\nit("x", () => { expect(1).toBe(1); });\n`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.length).toBe(1);
		expect(nonNull(matches[0]).text).toContain("mocks the system under test");
	});

	it("does not fire when the mock target is a different module in another directory", () => {
		const code = `vi.mock("../commands/foo.js");\nit("x", () => { expect(1).toBe(1); });\n`;
		expect(checkMockingTheSutSelf(code, TEST)).toEqual([]);
	});

	it("does not fire when jest.mock targets an unrelated sibling", () => {
		const code = `jest.mock("./bar");\nit("x", () => { expect(1).toBe(1); });\n`;
		expect(checkMockingTheSutSelf(code, TEST)).toEqual([]);
	});
});

describe("hasAnyProjectSourceImport", () => {
	it("returns true for a parent-directory project source import", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "../lib/x.js";`)).toBe(true);
	});

	it("returns false when the only parent-directory import is a test/mock/fixture/asset", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "../lib/x.test.js";`)).toBe(false);
		expect(hasAnyProjectSourceImport(`import data from "../fixtures/data.json";`)).toBe(false);
	});

	it("returns false with no parent-directory import at all", () => {
		expect(hasAnyProjectSourceImport(`import { x } from "./x.js";`)).toBe(false);
	});
});
