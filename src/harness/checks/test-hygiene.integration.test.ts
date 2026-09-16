// Barrel-surface test for test-hygiene.ts.
//
// The detailed per-detector cases live alongside their implementations in
// test-hygiene-isolation.test.ts and test-hygiene-quality.test.ts. This file
// pins only that the public barrel still re-exports the full surface every
// importer (generic-checks.ts → the check registry) depends on, and that each
// re-exported function is wired to its real implementation (a representative
// positive case per check, run through the barrel import).
import { describe, expect, it } from "vitest";
import {
	checkDuplicateTestNames,
	checkHappyPathOnlyTest,
	checkHardcodedTimeoutInTests,
	checkMockingTheSutSelf,
	checkMockOnlyTest,
	checkRealIoInTests,
	checkTestMissingSutImport,
	checkTestNondeterminism,
	checkTestSubprocessDefaultTimeout,
	hasAnyProjectSourceImport,
} from "./test-hygiene.js";

const TEST = "src/lib/foo.test.ts";

describe("test-hygiene barrel surface", () => {
	it("re-exports every public check as a callable function", () => {
		for (const fn of [
			checkDuplicateTestNames,
			checkHappyPathOnlyTest,
			checkHardcodedTimeoutInTests,
			checkMockingTheSutSelf,
			checkMockOnlyTest,
			checkRealIoInTests,
			checkTestMissingSutImport,
			checkTestNondeterminism,
			checkTestSubprocessDefaultTimeout,
			hasAnyProjectSourceImport,
		]) {
			expect(typeof fn).toBe("function");
		}
	});

	it("wires the isolation-family checks to their implementations", () => {
		expect(
			checkRealIoInTests(`await fetch("https://api.example.com/users");`, TEST).length,
		).toBe(1);
		expect(
			checkTestNondeterminism(`it("a", () => { const t = Date.now(); });`, TEST).length,
		).toBe(1);
		expect(
			checkHardcodedTimeoutInTests(`await new Promise(r => setTimeout(r, 1000));`, TEST).length,
		).toBe(1);
		const subprocess = [
			'import { execSync } from "node:child_process";',
			'it("typechecks the fixture", () => {',
			'  const out = execSync("npx tsc --noEmit fixture.ts", { encoding: "utf8" });',
			'  expect(out).toBe("");',
			"});",
		].join("\n");
		expect(checkTestSubprocessDefaultTimeout(subprocess, TEST).length).toBe(1);
	});

	it("wires the quality-family checks to their implementations", () => {
		const dup = `
it("returns 404 when missing", () => { expect(a).toBe(1); });
it("returns 404 when missing", () => { expect(b).toBe(2); });
`;
		expect(checkDuplicateTestNames(dup, TEST).length).toBe(1);
		expect(
			checkTestMissingSutImport(`import { something } from "./bar.js";`, TEST).length,
		).toBe(1);
		expect(checkMockingTheSutSelf(`vi.mock("./foo");`, TEST).length).toBe(1);
		// FP guard: a same-basename module in a DIFFERENT directory is not the SUT.
		expect(checkMockingTheSutSelf(`vi.mock("../commands/foo");`, TEST).length).toBe(0);
		expect(checkMockingTheSutSelf(`vi.mock("./sub/foo");`, TEST).length).toBe(0);
		expect(
			checkMockOnlyTest(
				`it("calls the API", async () => { await run(); expect(client.fetch).toHaveBeenCalled(); });`,
				TEST,
			).length,
		).toBe(1);
		const happy = `
it("adds two numbers", () => { expect(add(1, 2)).toBe(3); });
it("adds a larger pair", () => { expect(add(10, 5)).toBe(15); });
it("concatenates", () => { expect(join("a", "b")).toBe("ab"); });
`;
		expect(checkHappyPathOnlyTest(happy, TEST).length).toBe(1);
		expect(hasAnyProjectSourceImport(`import { foo } from "../foo.js";`)).toBe(true);
	});
});
