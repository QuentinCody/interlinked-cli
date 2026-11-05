// source-cases.ts — the AST-derived case list the Stop check and the nudge share
// (kill-proof review round 4, M2/M4/M5/M6/M7). P<n> = a real case must be seen the way
// vitest names it; N<n> = text that is not a case, or evidence that does not cover one.

import { describe, expect, it } from "vitest";
import { type CaseRequirement, newCases, requirementCovered, requirementLabel, sourceCases } from "./source-cases.js";

const FILE = "test/clamp.mutation-kill.test.ts";
const reqs = (text: string): CaseRequirement[] => sourceCases(text, FILE).map(item => item.requirement);
const killed = (...names: string[]) => names.map(name => ({ name, verdict: "killed" as const }));
const survived = (...names: string[]) => names.map(name => ({ name, verdict: "survived" as const }));

describe("sourceCases — positive (cases are named as vitest reports them)", () => {
	it("P1: a string title is its cooked value and describe ancestors join with spaces", () => {
		const text = 'describe("caps", () => { describe(`inner`, () => { it("says \\"max\\"", () => {}); }); test.only("plain", () => {}); });\n';
		expect(reqs(text)).toEqual([{ kind: "exact", name: 'caps inner says "max"' }, { kind: "exact", name: "caps plain" }]);
	});

	it("P2: an `it.each` title with a `%i` / `$n` placeholder is a prefix family, and a `%%` before it is a literal percent", () => {
		expect(reqs('it.each([5, 6])("caps %i", (n) => {});\n')).toEqual([{ kind: "prefix", prefix: "caps ", source: "caps %i" }]);
		expect(reqs('it.each`\n n\n ${5}\n`("weak $n", ({ n }) => {});\n')).toEqual([{ kind: "prefix", prefix: "weak ", source: "weak $n" }]);
		expect(reqs('it.each([[String(5)]])("100%% at %s", (n) => {});\n')).toEqual([{ kind: "prefix", prefix: "100% at ", source: "100%% at %s" }]);
		expect(reqs('test.concurrent.for([1])("same title", () => {});\n')).toEqual([{ kind: "exact", name: "same title" }]);
	});

	it("P3: a template title with substitutions is a prefix family; an identifier bound once to a literal resolves", () => {
		expect(reqs("const m = 3;\nit(`caps at ${m}`, () => {});\n")).toEqual([{ kind: "prefix", prefix: "caps at ", source: "`caps at ${m}`" }]);
		expect(reqs('const T = "boundary";\nit(T, () => {});\n')).toEqual([{ kind: "exact", name: "boundary" }]);
	});

	it("P4: a computed title, an ambiguous identifier or a non-literal describe is unresolvable, never invisible", () => {
		expect(reqs("it(name(), () => {});\n")).toEqual([{ kind: "unresolvable", source: "name()" }]);
		expect(reqs('let T = "a";\nT = "b";\nconst T2 = T;\nit(T2, () => {});\n')[0]?.kind).toBe("unresolvable");
		expect(reqs('describe.each([1])("group %s", () => { it("case", () => {}); });\n')).toEqual([{ kind: "unresolvable", source: "case" }]);
		expect(reqs('it.each([1])("%s", () => {});\n')).toEqual([{ kind: "unresolvable", source: "%s" }]);
	});

	it("P5: a `test.extend` alias opens cases; `.skipIf` / `.runIf` / `.todo` are the same case", () => {
		expect(reqs('const mine = test.extend({});\nmine("aliased", () => {});\nit.skipIf(false)("guarded", () => {});\nit.todo("later");\n')).toEqual([
			{ kind: "exact", name: "aliased" },
			{ kind: "exact", name: "guarded" },
			{ kind: "exact", name: "later" },
		]);
	});

	it("P6: a title on the line after `it(` and a case inside a loop are counted", () => {
		const text = 'it(\n\t"multi line",\n\t() => {},\n);\nfor (const n of [1, 2]) { it(`loop ${n}`, () => {}); }\n';
		expect(sourceCases(text, FILE).map(item => item.line)).toEqual([1, 5]);
	});
});

describe("sourceCases — negative (text that is not a case)", () => {
	it("N1: `/re/.test(\"…\")`, `obj.it(…)` and an unknown modifier are not cases", () => {
		expect(reqs('expect(/w/.test("weak boundary")).toBe(true);\nfoo.it("not a case", () => {});\nit.custom("no", () => {});\n')).toEqual([]);
	});

	it("N2: the configuring `it.each([...])` call is not counted beside the case it opens", () => {
		expect(reqs('it.each([[1, 2]])("row %i %i", () => {});\n')).toHaveLength(1);
	});
});

describe("newCases — the one rule shared by the Stop check and the nudge (review M6)", () => {
	const strong = (title: string) => `it(${JSON.stringify(title)}, () => { expect(clamp(5, 3)).toBe(3); });\n`;
	const weak = (title: string) => `it(${JSON.stringify(title)}, () => { expect(typeof clamp).toBe("function"); });\n`;

	it("P1: a new title with the body of a removed case is a rename, not a new case", () => {
		const result = newCases(strong("kills mutant A (renamed)"), strong("kills mutant A"), FILE);
		expect(result).toEqual({ added: [], renamed: 1 });
	});

	it("P2: a same-count swap of a strong case for a weak one is a NEW case", () => {
		const result = newCases(strong("caps at max") + weak("new weak"), strong("caps at max") + strong("old"), FILE);
		expect(result.added.map(item => item.requirement)).toEqual([{ kind: "exact", name: "new weak" }]);
		expect(result.renamed).toBe(0);
	});

	it("P3: a duplicated title is one more case (multiset), and an unborn file adds every case", () => {
		expect(newCases(weak("caps at max") + strong("caps at max"), strong("caps at max"), FILE).added).toHaveLength(1);
		expect(newCases(strong("a") + strong("b"), "", FILE).added).toHaveLength(2);
	});

	it("N1: an assertion added inside an existing case is not a new case", () => {
		const after = strong("caps at max").replace("});\n", 'expect(/a/.test("abc")).toBe(true); });\n');
		expect(newCases(after, strong("caps at max"), FILE)).toEqual({ added: [], renamed: 0 });
	});
});

describe("requirementCovered — positive (every recorded case of the requirement killed)", () => {
	it("P1: an exact name is covered by its killed row; a prefix family by all its killed rows", () => {
		expect(requirementCovered({ kind: "exact", name: 'says "max"' }, killed('says "max"'))).toBe(true);
		expect(requirementCovered({ kind: "prefix", prefix: "caps ", source: "caps %i" }, killed("caps at max", "caps 5", "caps 6"))).toBe(true);
	});
});

describe("requirementCovered — negative (evidence that does not cover the case)", () => {
	it("N1: a suffix of a killed full name is not the case; a prefix family with one surviving row is not covered", () => {
		expect(requirementCovered({ kind: "exact", name: "max" }, killed("caps at max"))).toBe(false);
		expect(requirementCovered({ kind: "prefix", prefix: "caps ", source: "caps %i" }, [...killed("caps 5"), ...survived("caps 6")])).toBe(false);
	});

	it("N2: a weak duplicate of a strong case (same full name, one row survived) is not covered; unresolvable never is", () => {
		expect(requirementCovered({ kind: "exact", name: "caps at max" }, [...survived("caps at max"), ...killed("caps at max")])).toBe(false);
		expect(requirementCovered({ kind: "exact", name: "absent" }, killed("other"))).toBe(false);
		expect(requirementCovered({ kind: "unresolvable", source: "T" }, killed("T"))).toBe(false);
		expect(requirementLabel({ kind: "unresolvable", source: "T" })).toContain("not a literal");
	});
});
