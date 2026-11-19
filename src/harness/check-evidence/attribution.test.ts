// Tests for case attribution: a labeled case counts for a detector only when it names it.

import { describe, expect, it } from "vitest";
import { attributedCasesIn, attributionContext, detectorsNamedIn } from "./attribution.js";

const REGISTRY = [
	{ id: "nan_comparison", fn: { name: "checkNanComparison" } },
	{ id: "eval_usage", fn: { name: "checkEvalUsage" } },
];
const NAN = { id: "nan_comparison", fn: "checkNanComparison" };

function titles(source: string, detector = NAN): string[] {
	return attributedCasesIn(attributionContext(REGISTRY), "a.test.ts", source, detector).map((c) => c.title);
}

const SHARED = `
import { checkEvalUsage, checkNanComparison } from "../checks/x.js";
describe("shared suite — positive (must fire)", () => {
	it("P1: nan", () => {
		expect(checkNanComparison("x === NaN", "a.ts")).toHaveLength(1);
	});
	it("P2: eval", () => {
		expect(checkEvalUsage("eval(x)", "a.ts")).toHaveLength(1);
	});
});
describe("checkNanComparison", () => {
	it("N1: guarded", () => expect(run("Number.isNaN(x)")).toEqual([]));
});
describe("registry-driven", () => {
	it("N2: by id", () => {
		expect(runCheck("nan_comparison", "Number.isNaN(y)")).toEqual([]);
	});
	it("N3: other id", () => {
		expect(runCheck("eval_usage", "myeval(y)")).toEqual([]);
	});
});
`;

describe("attributedCasesIn — positive (must credit the case)", () => {
	it("P1: a case whose own body calls the detector function", () => {
		expect(titles(SHARED)).toContain("P1: nan");
	});

	it("P2: a case under a describe titled with the detector function name", () => {
		expect(titles(SHARED)).toContain("N1: guarded");
	});

	it("P3: a case whose body passes the check id as a quoted literal", () => {
		expect(titles(SHARED)).toContain("N2: by id");
	});

	it("P4: every case in a file that names this detector alone, even through a local helper", () => {
		const src = `
import { checkNanComparison } from "../checks/x.js";
const run = (c: string) => checkNanComparison(c, "a.ts");
it("P1: bare", () => expect(run("x === NaN")).toHaveLength(1));
it("N1: guarded", () => expect(run("Number.isNaN(x)")).toEqual([]));
`;
		expect(titles(src)).toEqual(["P1: bare", "N1: guarded"]);
	});
});

describe("attributedCasesIn — negative (must not credit the case)", () => {
	it("N1: a case in a shared suite that exercises only another detector", () => {
		const credited = titles(SHARED);
		expect(credited).not.toContain("P2: eval");
		expect(credited).not.toContain("N3: other id");
		expect(credited).toEqual(["P1: nan", "N1: guarded", "N2: by id"]);
	});

	it("N2: a longer identifier that contains the detector name is not a name", () => {
		const src = `
import { checkEvalUsage } from "../checks/x.js";
it("P1: x", () => { expect(checkNanComparisonStrict("x")).toHaveLength(1); checkEvalUsage("y"); });
`;
		expect(titles(src)).toEqual([]);
	});

	it("N3: a quoted literal that only contains the check id is not the id", () => {
		const src = `
import { checkEvalUsage } from "../checks/x.js";
it("P1: x", () => { expect(runCheck("nan_comparison_v2", "x")).toHaveLength(1); checkEvalUsage("y"); });
`;
		expect(titles(src)).toEqual([]);
	});

	it("N4: a file that names no registered detector credits nothing", () => {
		expect(titles('it("P1: x", () => expect(helper("x")).toHaveLength(1));')).toEqual([]);
	});
});

describe("detectorsNamedIn", () => {
	it("P1: collects function identifiers and quoted check ids, as function names", () => {
		const names = attributionContext(REGISTRY).names;
		expect([...detectorsNamedIn('runCheck("eval_usage"); checkNanComparison(x);', names)].sort()).toEqual([
			"checkEvalUsage",
			"checkNanComparison",
		]);
	});

	it("N1: ignores identifiers that are not registered detectors", () => {
		expect(detectorsNamedIn("checkSomethingElse(x)", attributionContext(REGISTRY).names).size).toBe(0);
	});
});
