import { describe, expect, it } from "vitest";
import { checkEvalUsage } from "./eval-usage.js";

// Census fault: `(setTimeout|setInterval)` → `(setTimeout)` survived the
// boundary-only companion test (docs/reviews/kill-proof-census-harness.md).
describe("checkEvalUsage — string-evaluating timers", () => {
	// test-contract: public-api — setInterval with a string body evaluates code exactly like eval and must be reported
	it("reports setInterval called with a string body", () => {
		expect(checkEvalUsage('setInterval("tick()", 1000);', "src/clock.ts")).toEqual([
			{ line: 1, text: 'setInterval("tick()", 1000);' },
		]);
	});

	// test-contract: invariant — both timer spellings are reported, each on its own line
	it("reports both setTimeout and setInterval string bodies in one file", () => {
		const source = 'setTimeout("a()", 1);\nsetInterval(`b()`, 2);';
		expect(checkEvalUsage(source, "src/clock.js").map((m) => m.line)).toEqual([1, 2]);
	});
});
