// Companion for the failing-test parse/attach helpers. Names are message
// sugar; FILES are red-debt evidence (widening-only relatedness), so the file
// parsers get explicit positive AND negative cases: a mis-parsed row must be
// dropped, never invented.
import { describe, expect, it } from "vitest";
import type { CoverageRunResult } from "./coverage-runner.js";
import {
	parsePytestFailingTestFiles,
	parseVitestFailingTestFiles,
	parseVitestFailingTests,
	withFailingTests,
} from "./coverage-runner-failing-tests.js";

function red(): CoverageRunResult {
	return { suiteMs: 10, perFile: new Map(), ok: true, testsPassed: false };
}

describe("parseVitestFailingTestFiles", () => {
	it("takes the file head of a `FAIL file > suite > case` row", () => {
		const text = "  FAIL  src/lib/server-counts.test.ts > theme counts > derives the total\n";
		expect(parseVitestFailingTestFiles(text)).toEqual(["src/lib/server-counts.test.ts"]);
	});

	it("handles a bare `FAIL file` row (whole-file failure) and ❯ summary rows with annotations", () => {
		const text = [
			"FAIL  src/a.test.ts",
			" ❯ src/b.test.ts (3 tests | 1 failed) 123ms",
			"× src/c.spec.tsx > renders",
		].join("\n");
		expect(parseVitestFailingTestFiles(text)).toEqual(["src/a.test.ts", "src/b.test.ts", "src/c.spec.tsx"]);
	});

	it("strips a |project| workspace tag", () => {
		const text = "FAIL  |unit| src/d.test.ts > case\n";
		expect(parseVitestFailingTestFiles(text)).toEqual(["src/d.test.ts"]);
	});

	it("drops rows whose head is not a test path (suite-only labels, prose, non-test files)", () => {
		const text = [
			"FAIL  some suite name > deeper", // no path head
			"FAILURES are bad", // prose, no row match
			"FAIL  src/util.ts > helper", // not a test path
			"× expected 99 to be 97",
		].join("\n");
		expect(parseVitestFailingTestFiles(text)).toEqual([]);
	});

	it("does not disturb the NAME parser (tail extraction unchanged)", () => {
		const text = "FAIL  src/lib/server-counts.test.ts > theme counts > derives the total\n";
		expect(parseVitestFailingTests(text)).toEqual(["derives the total"]);
	});
});

describe("parsePytestFailingTestFiles", () => {
	it("takes the path of a short-summary FAILED nodeid", () => {
		expect(parsePytestFailingTestFiles("FAILED tests/test_counts.py::TestC::test_total - assert 99\n")).toEqual([
			"tests/test_counts.py",
		]);
	});

	it("takes the path of a verbose `nodeid ... FAILED` row", () => {
		expect(parsePytestFailingTestFiles("tests/api_test.py::test_theme FAILED  [ 50%]\n")).toEqual([
			"tests/api_test.py",
		]);
	});

	it("drops non-test paths and unrelated lines", () => {
		const text = ["FAILED conftest.py::setup", "ERROR tests/test_x.py", "all good here"].join("\n");
		expect(parsePytestFailingTestFiles(text)).toEqual([]);
	});
});

describe("withFailingTests — file attachment contract", () => {
	it("attaches deduped files only on a RED run", () => {
		const out = withFailingTests(red(), ["case a"], ["src/a.test.ts", "src/a.test.ts", "src/b.test.ts"]);
		expect(out.failingTestFiles).toEqual(["src/a.test.ts", "src/b.test.ts"]);
		expect(out.failingTests).toEqual(["case a"]);
	});

	it("keeps BOTH fields absent on a green run", () => {
		const green: CoverageRunResult = { ...red(), testsPassed: true };
		const out = withFailingTests(green, ["case a"], ["src/a.test.ts"]);
		expect("failingTests" in out).toBe(false);
		expect("failingTestFiles" in out).toBe(false);
	});

	it("keeps the files field absent when nothing parsed (red run, empty list)", () => {
		const out = withFailingTests(red(), [], []);
		expect("failingTestFiles" in out).toBe(false);
	});

	it("caps the file list at 20 (wider than the 5-name message cap)", () => {
		const files = Array.from({ length: 30 }, (_, i) => `src/f${i}.test.ts`);
		const names = Array.from({ length: 30 }, (_, i) => `case ${i}`);
		const out = withFailingTests(red(), names, files);
		expect(out.failingTestFiles).toHaveLength(20);
		expect(out.failingTests).toHaveLength(5);
	});
});
