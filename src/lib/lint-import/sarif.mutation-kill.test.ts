import { expect, it } from "vitest";
import { parseSarif } from "./sarif.js";

const located = { message: { text: "Note" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.ts" }, region: { startLine: 3 } } }] };
function report(results: unknown[]): string {
	return JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CustomLint" } }, invocations: [{ executionSuccessful: true }], results }] });
}

// test-contract: public-api — SARIF `kind: "informational"` results are not findings and must not be imported as lint diagnostics, while a `kind: "fail"` result is
it("drops informational results and keeps failing ones", () => {
	expect(parseSarif(report([{ ...located, ruleId: "Info", kind: "informational" }, { ...located, ruleId: "Bad", kind: "fail" }])))
		.toEqual([{ file: "src/a.ts", line: 3, rule: "CustomLint/Bad", message: "Note" }]);
});
