import { describe, expect, it } from "vitest";
import {
	checkMockingTheSutSelf,
	checkTestMissingSutImport,
	hasAnyProjectSourceImport,
} from "./test-hygiene-quality-sut.js";

const TEST = "src/lib/foo.test.ts";
const BODY = `it("x", () => { expect(1).toBe(1); });\n`;

describe("checkTestMissingSutImport exemptions and import forms (mutation-hardening)", () => {
	// module header: `foo.mutation-kill.test.ts` names SUT `foo` (line 28-30)
	it("a mutation-directed suite resolves its SUT as the base name when the SUT is run as a subprocess", () => {
		const code = `import { execSync } from "node:child_process";\nit("x", () => { execSync("node scripts/foo.mjs"); });\n`;
		expect(checkTestMissingSutImport(code, "src/lib/foo.mutation-kill.test.ts")).toEqual([]);
	});

	// line 47: `sutBase === "index"` is exempt
	it("an index.test.ts with no companion import is exempt", () => {
		expect(checkTestMissingSutImport(BODY, "src/lib/index.test.ts")).toEqual([]);
	});

	// line 47: a file under __tests__/ that is not named *.test.* has no SUT stem
	it("a helper in __tests__/ not named *.test.* is not flagged", () => {
		expect(checkTestMissingSutImport(BODY, "src/lib/__tests__/helper.ts")).toEqual([]);
	});

	// line 48: fixtures and mocks directories are not test suites with a companion
	it("a *.test.ts under __fixtures__/ is exempt", () => {
		expect(checkTestMissingSutImport(BODY, "src/lib/__fixtures__/foo.test.ts")).toEqual([]);
	});

	it("a *.test.ts under __mocks__/ is exempt", () => {
		expect(checkTestMissingSutImport(BODY, "src/lib/__mocks__/foo.test.ts")).toEqual([]);
	});

	// line 50-51 comment: the import pattern allows an optional path prefix
	it("an import of the SUT basename through a fixtures sub-path counts as importing the SUT", () => {
		const code = `import { foo } from "./__fixtures__/foo.js";\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	// line 50-51 comment: optional `./` or `../` prefix
	it("a parent-directory import of the SUT basename through a fixtures sub-path counts", () => {
		const code = `import { foo } from "../__fixtures__/foo.js";\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("a SUT name containing a dot matches literally, not as a wildcard", () => {
		const code = `import { x } from "./fooXbar.js";\n${BODY}`;
		expect(checkTestMissingSutImport(code, "src/lib/foo.bar.test.ts").length).toBe(1);
	});

	// hasAnyProjectSourceImport header (line 124-132): a `../` source import is Tier 2 evidence
	it("a single parent-directory project source import clears the check", () => {
		const code = `import { other } from "../other.js";\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	it("reports a 1-based line number", () => {
		const matches = checkTestMissingSutImport(BODY, TEST);
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBeGreaterThanOrEqual(1);
	});

	// line 192-203: test / mock / fixture / asset specifiers do not count toward the total
	it("three parent-directory asset imports are neither a project import nor a multi-module suite", () => {
		const code = `import a from "../a.json";\nimport b from "../b.json";\nimport c from "../c.json";\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	// line 167 comment: a basename NAMED regressions/bugs; "debug" is not "bug"
	it("a basename that merely contains 'bug' is not a regression-suite name", () => {
		expect(checkTestMissingSutImport(BODY, "src/lib/debug.test.ts").length).toBe(1);
	});

	// line 174-176: subprocess shape needs a spawn call AND the companion path
	it("a companion file name in a string without any subprocess call is not a subprocess run", () => {
		const code = `it("x", () => { expect("see src/lib/foo.mjs").toContain("foo"); });\n`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	// line 291-298: lineage match works for every JS/TS extension the resolver knows
	it("a .jsx import of the SUT stem counts as importing the SUT", () => {
		const code = `import Foo from "./foo.jsx";\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST)).toEqual([]);
	});

	// line 349-357 / 311: only the SAME call's arguments carry the evidence
	it("a product path after the spawn call, outside its parentheses, is not evidence", () => {
		const code = `import { execSync } from "node:child_process";
it("x", () => { execSync("echo hi"); });
const LATER = "dist/index.js";
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	it("a binding name that only appears inside a longer identifier is not carried into the call", () => {
		const code = `import { execSync } from "node:child_process";
const DIST = join(root, "dist", "index.js");
const DISTANCE = 5;
it("x", () => { execSync("echo " + DISTANCE); });
`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});

	// line 363: evidence in comments is not a call
	it("a spawn of the product that only appears in a comment is not black-box driving", () => {
		const code = `// execFileSync("node", ["dist/index.js"]);\n${BODY}`;
		expect(checkTestMissingSutImport(code, TEST).length).toBe(1);
	});
});

describe("checkMockingTheSutSelf limits and line numbers (mutation-hardening)", () => {
	const mocks = (n: number): string =>
		Array.from({ length: n }, () => `vi.mock("./foo");`).join("\n") + `\n${BODY}`;

	// line 105: MAX_MATCHES bounds the number of reported findings at three
	it("reports at most three findings for five mocks of the SUT", () => {
		expect(checkMockingTheSutSelf(mocks(5), TEST).length).toBe(3);
	});

	it("reports every mock when there are fewer than the cap", () => {
		expect(checkMockingTheSutSelf(mocks(2), TEST).length).toBe(2);
	});

	it("reports the 1-based line of the mock call", () => {
		const code = `import { vi } from "vitest";\n\nvi.mock("./foo");\n${BODY}`;
		const matches = checkMockingTheSutSelf(code, TEST);
		expect(matches.map((m) => m.line)).toEqual([3]);
	});

	// line 107: the global regex must restart from the beginning on every call
	it("finds the mock again on a later call after an earlier call stopped at the cap", () => {
		checkMockingTheSutSelf(mocks(6), TEST);
		expect(checkMockingTheSutSelf(`vi.mock("./foo");\n${BODY}`, TEST).length).toBe(1);
	});

	// line 83-87 doc: only a SAME-directory sibling is the SUT
	it("a mock of a sub-directory module with the SUT basename is not flagged", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./sub/foo.js");\n${BODY}`, TEST)).toEqual([]);
	});

	it("a non-test file name is not inspected", () => {
		expect(checkMockingTheSutSelf(`vi.mock("./helper");\n`, "src/lib/__tests__/helper.ts")).toEqual([]);
	});
});

describe("hasAnyProjectSourceImport exclusions (mutation-hardening)", () => {
	// the base suite pins "returns false when the only parent-directory import is a test/mock/fixture/asset"
	it("a __mocks__ import is not project source", () => {
		expect(hasAnyProjectSourceImport(`import { m } from "../__mocks__/db.js";`)).toBe(false);
	});

	it("a __fixtures__ import is not project source", () => {
		expect(hasAnyProjectSourceImport(`import { f } from "../__fixtures__/data.js";`)).toBe(false);
	});
});
