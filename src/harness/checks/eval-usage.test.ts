// Companion test for the extracted eval_usage module. The behavior suites
// live in agent-safety-js-correctness.test.ts and
// __tests__/adversarial/eval_usage.adversarial.test.ts; this file pins the
// module boundary: the family module re-exports this exact detector.

import { describe, expect, it } from "vitest";
import { checkEvalUsage as viaFamily } from "./agent-safety-js-correctness.js";
import { checkEvalUsage } from "./eval-usage.js";

describe("checkEvalUsage module — positive (must fire)", () => {
	it("P1: a global eval call fires on its line, through the family re-export too", () => {
		const code = "const a = 1;\nconst r = eval(input);\n";
		expect(checkEvalUsage(code, "src/x.ts")).toEqual([{ line: 2, text: "const r = eval(input);" }]);
		expect(viaFamily).toBe(checkEvalUsage);
	});
});

describe("checkEvalUsage module — negative (must not fire)", () => {
	it("N1: a member call `vm.eval(code)` is not the global eval", () => {
		expect(checkEvalUsage("const r = vm.eval(code);\n", "src/x.ts")).toEqual([]);
	});
});
