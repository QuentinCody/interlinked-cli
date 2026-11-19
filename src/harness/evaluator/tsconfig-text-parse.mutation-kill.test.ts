import { describe, expect, it } from "vitest";
import { tsconfigParseFindings } from "./tsconfig-text-parse.js";

describe("tsconfig-text-parse mutation-kill", () => {
	// test-contract: boundary — creating a tsconfig absent at HEAD (empty before text) with unparseable content is not a loosening finding
	it("yields no finding when the before text is empty and the new text is unparseable", () => {
		expect(tsconfigParseFindings("tsconfig.json", "", "{ not json")).toEqual([]);
	});

	// test-contract: public-api — an existing parseable tsconfig replaced by unparseable text yields one tsconfig-parse finding
	it("still reports a finding when a non-empty parseable tsconfig becomes unparseable", () => {
		const findings = tsconfigParseFindings("tsconfig.json", '{"compilerOptions":{"strict":true}}', "{ not json");
		expect(findings.map((f) => f.rule)).toEqual(["tsconfig-parse"]);
	});
});
