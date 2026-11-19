import { describe, expect, it } from "vitest";
import { parsePlaywrightJson } from "./playwright-report.js";

const passed = { status: "passed", retry: 0, startTime: "2026-01-01T00:00:00.000Z", duration: 10 };
const report = (tests: Array<Record<string, unknown>>) => JSON.stringify({
	suites: [{ title: "a.spec.ts", file: "a.spec.ts", specs: [{ title: "works", file: "a.spec.ts", tests }] }],
});

// Census fault: `&& test.projectName` dropped from the variant test, so an empty
// projectName produced a dangling " []" suffix (docs/reviews/kill-proof-census-e2e-structure.md #10).
describe("parsePlaywrightJson — an empty project name is no variant", () => {
	// test-contract: invariant — a test whose projectName is the empty string has the same case identity as one with no projectName: no " []" suffix
	it("gives an empty projectName no bracketed suffix", () => {
		const parsed = parsePlaywrightJson(report([{ projectName: "", status: "expected", results: [passed] }]));
		expect(parsed.cases.map(row => row.id)).toEqual(["a.spec.ts › works"]);
	});
	// test-contract: invariant — an empty-named project and an unnamed project are one identity, so both in one report are a duplicate case
	it("treats an empty projectName and a missing projectName as the same case identity", () => {
		const both = report([
			{ projectName: "", status: "expected", results: [passed] },
			{ status: "expected", results: [passed] },
		]);
		expect(() => parsePlaywrightJson(both)).toThrow(/duplicate case id a\.spec\.ts › works$/);
	});
});
