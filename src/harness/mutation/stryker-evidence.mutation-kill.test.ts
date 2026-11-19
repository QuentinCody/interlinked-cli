import { describe, expect, it } from "vitest";
import { preserveStrykerEvidence } from "./stryker-evidence.js";

describe("stryker-evidence mutation-kill", () => {
	// test-contract: boundary — a test id that appears twice in testFiles is ambiguous and stays unresolved
	it("reports a duplicated test id as unresolved", () => {
		const report = {
			testFiles: {
				"a.test.ts": { tests: [{ id: "dup" }, { id: "solo" }] },
				"b.test.ts": { tests: [{ id: "dup" }] },
			},
			files: { "x.ts": { mutants: [{ killedBy: ["dup", "solo"] }] } },
		};
		expect(preserveStrykerEvidence(report).unresolved_test_ids).toEqual(["dup"]);
	});
});
