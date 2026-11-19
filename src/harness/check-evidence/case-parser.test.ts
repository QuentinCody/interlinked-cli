// Tests for labeled-test-case extraction.
//
// Dogfoods the contract this module enforces: cases below are labeled in both
// directions, and the negatives pin the shapes that must NOT be counted as
// evidence (unlabeled tests, comments, nested blocks).

import { describe, expect, it } from "vitest";
import { countCases, directionFromTitle, parseCaseSpans, parseLabeledCases } from "./case-parser.js";

describe("directionFromTitle — positive (must classify as positive)", () => {
	it("P1: reads an explicit P-prefix", () => {
		expect(directionFromTitle("P1: inline Date.parse with no guard")).toBe("positive");
	});

	it("P2: reads 'must fire' prose", () => {
		expect(directionFromTitle("positive (must fire)")).toBe("positive");
	});

	it("P3: reads 'detects' prose", () => {
		expect(directionFromTitle("detects a raw SQL concat")).toBe("positive");
	});

	it("P4: reads the hyphenated MUST-FIRE dialect (9 suites label this way)", () => {
		expect(directionFromTitle("MUST-FIRE: bare marshal.loads call")).toBe("positive");
	});

	it("P5: reads hyphenated 'does-fire' prose", () => {
		expect(directionFromTitle("does-fire on an unguarded call")).toBe("positive");
	});

	it("P6: 'no matching' is not a 'no match' label, so 'STILL flags' stays positive", () => {
		expect(directionFromTitle("STILL flags a bare ident with no matching const declaration anywhere")).toBe("positive");
	});
});

describe("directionFromTitle — negative (must classify as negative or null)", () => {
	it("N1: 'must not fire' is never read as positive", () => {
		expect(directionFromTitle("negative (must not fire)")).toBe("negative");
	});

	it("N2: 'does not fire' is negative even though it contains 'fire'", () => {
		expect(directionFromTitle("does not fire when guarded")).toBe("negative");
	});

	it("N3: an N-prefix wins over positive-sounding prose", () => {
		expect(directionFromTitle("N4: detects nothing when the guard is present")).toBe("negative");
	});

	it("N4: an unlabeled title yields null rather than a guess", () => {
		expect(directionFromTitle("returns an empty array for an empty file")).toBeNull();
	});

	it("N5: reads the hyphenated MUST-NOT-FIRE dialect (9 suites label this way)", () => {
		expect(directionFromTitle("MUST-NOT-FIRE: noqa-suppressed call")).toBe("negative");
	});

	it("N6: hyphenated 'must-not-fire' is never read as positive via its 'fire' tail", () => {
		expect(directionFromTitle("checkFoo must-not-fire boundary cases")).toBe("negative");
	});

	it("N7: reads hyphenated 'must-stay-silent' prose", () => {
		expect(directionFromTitle("must-stay-silent on vendored paths")).toBe("negative");
	});

	it("N8: a whole-word 'no match' / 'no-match' label is still negative", () => {
		expect(directionFromTitle("no match for a guarded call")).toBe("negative");
		expect(directionFromTitle("no-match: guarded call")).toBe("negative");
	});
});

describe("parseCaseSpans", () => {
	it("P1: a braced case ends on the line that closes its block", () => {
		const src = [
			'describe("checkThing — positive (must fire)", () => {', // 1
			'\tit("braced", () => {', // 2
			"\t\texpect(checkThing(x)).toHaveLength(1);", // 3
			"\t});", // 4
			'\tit("one line", () => expect(run(y)).toHaveLength(1));', // 5
			"});", // 6
		].join("\n");
		const spans = parseCaseSpans(src);
		expect(spans.map((s) => [s.labeled.line, s.endLine])).toEqual([[2, 4], [5, 5]]);
		expect(spans[0]?.describeTitles).toEqual(["checkThing — positive (must fire)"]);
	});

	it("P2: a case without braces runs until the next opener", () => {
		const src = [
			'describe("negative (must not fire)", () => {', // 1
			'\tit("arrow", () =>', // 2
			"\t\texpect(run(z)).toEqual([]));", // 3
			'\tit("next", () => {});', // 4
			"});", // 5
		].join("\n");
		expect(parseCaseSpans(src).map((s) => [s.labeled.line, s.endLine])).toEqual([[2, 3], [4, 4]]);
	});

	it("N1: an unlabeled test ends the labeled case before it and adds no span", () => {
		const src = [
			'describe("checkThing", () => {', // 1
			'\tit("P1: labeled", () =>', // 2
			"\t\texpect(a).toBe(1));", // 3
			'\tit("unlabeled helper case", () => {', // 4
			"\t\texpect(checkOther(b)).toEqual([]);", // 5
			"\t});", // 6
			"});", // 7
		].join("\n");
		expect(parseCaseSpans(src).map((s) => [s.labeled.line, s.endLine])).toEqual([[2, 3]]);
	});
});

describe("parseLabeledCases — positive (must count)", () => {
	it("P1: counts tests inheriting a labeled describe", () => {
		const src = `
describe("checkThing — positive (must fire)", () => {
	it("inline case", () => {});
	it("two-step case", () => {});
});
describe("checkThing — negative (must not fire)", () => {
	it("guarded case", () => {});
});
`;
		const counts = countCases(parseLabeledCases(src));
		expect(counts).toEqual({ positive: 2, negative: 1 });
	});

	it("P2: counts P/N prefixes with no labeled describe at all", () => {
		const src = `
describe("checkThing", () => {
	it("P1: fires here", () => {});
	it("N1: silent here", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 1 });
	});

	it("P3: a per-test prefix overrides the enclosing describe", () => {
		const src = `
describe("positive (must fire)", () => {
	it("fires", () => {});
	it("N9: counter-example tucked inside the positive block", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 1 });
	});

	it("P4: handles it.each and test() forms", () => {
		const src = `
describe("negative (must not fire)", () => {
	it.each([1, 2])("case %i", () => {});
	test("another silent case", () => {});
});
`;
		expect(countCases(parseLabeledCases(src)).negative).toBe(2);
	});

	it("P5: records 1-based line numbers", () => {
		const src = ['describe("positive (must fire)", () => {', '\tit("a", () => {});', "});"].join("\n");
		const cases = parseLabeledCases(src);
		expect(cases[0]?.line).toBe(2);
	});
});

describe("parseLabeledCases — negative (must NOT count)", () => {
	it("N1: unlabeled tests under an unlabeled describe are ignored", () => {
		const src = `
describe("checkThing", () => {
	it("returns an array", () => {});
	it("handles empty input", () => {});
});
`;
		expect(parseLabeledCases(src)).toEqual([]);
	});

	it("N2: commented-out tests are not counted", () => {
		const src = `
describe("positive (must fire)", () => {
	// it("disabled case", () => {});
	it("real case", () => {});
});
`;
		expect(countCases(parseLabeledCases(src)).positive).toBe(1);
	});

	it("N3: a label does not leak past its describe block", () => {
		const src = `
describe("positive (must fire)", () => {
	it("inside", () => {});
});
describe("unrelated helpers", () => {
	it("outside", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 0 });
	});

	it("N4: an empty source yields no cases", () => {
		expect(parseLabeledCases("")).toEqual([]);
	});

	it("N5: a file with only helpers and imports yields no cases", () => {
		const src = `
import { thing } from "./thing.js";
function helper(x: number): number {
	return x + 1;
}
`;
		expect(parseLabeledCases(src)).toEqual([]);
	});
});

describe("countCases", () => {
	it("returns zeroes for an empty list", () => {
		expect(countCases([])).toEqual({ positive: 0, negative: 0 });
	});
});
