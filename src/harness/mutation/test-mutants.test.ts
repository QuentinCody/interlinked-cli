import { describe, expect, it } from "vitest";
import { loadTsModule } from "./differential-fuzz-deps.js";
import {
	applyTestMutant,
	describeKind,
	enumerateTestMutants,
	enumerateTestMutantsDetailed,
	TEST_MUTANT_KINDS,
	type TestMutant,
	TestMutantDriftError,
	type TestMutantKind,
} from "./test-mutants.js";

const FILE = "src/x.test.ts";

/** Mutants of one kind, in file order. */
function of(src: string, kind: TestMutantKind): TestMutant[] {
	return enumerateTestMutants(FILE, src).filter((m) => m.kind === kind);
}

/** Every mutated program for one kind. */
function applied(src: string, kind: TestMutantKind): string[] {
	return of(src, kind).map((m) => applyTestMutant(src, m));
}

function wrap(body: string): string {
	return `it("case", () => {\n${body}\n});\n`;
}

describe("test-mutants assertion_negate — positive (must fire)", () => {
	it("P1: inserts .not before the matcher", () => {
		const src = wrap("expect(f()).toBe(1);");
		const [m] = of(src, "assertion_negate");
		expect(m?.original).toBe("toBe");
		expect(m?.replacement).toBe("not.toBe");
		expect(m?.testName).toBe("case");
		expect(applied(src, "assertion_negate")).toEqual([wrap("expect(f()).not.toBe(1);")]);
	});

	it("P2: removes an existing .not", () => {
		const src = wrap("expect(f()).not.toBe(1);");
		expect(applied(src, "assertion_negate")).toEqual([wrap("expect(f()).toBe(1);")]);
	});

	it("P3: negates inside resolves chains and nested non-statement positions", () => {
		const src = wrap("await Promise.all([expect(p).resolves.toBe(1)]);");
		expect(applied(src, "assertion_negate")).toEqual([wrap("await Promise.all([expect(p).resolves.not.toBe(1)]);")]);
	});
});

describe("test-mutants assertion_negate — negative (must not fire)", () => {
	it("N1: obj.expect(x).toBe(1) is not an expect chain", () => {
		expect(of(wrap("helper.expect(1).toBe(1);"), "assertion_negate")).toEqual([]);
	});

	it("N2: a string that contains an assertion produces no mutant of any kind", () => {
		expect(enumerateTestMutants(FILE, wrap('const s = "expect(x).toBe(1)"; use(s);'))).toEqual([]);
	});

	it("N3: an expect in a module-level helper outside any test is not attributable", () => {
		const src = `function check(v) { expect(v).toBe(1); }\nit("a", () => { check(1); });\n`;
		expect(enumerateTestMutants(FILE, src)).toEqual([]);
	});
});

describe("test-mutants assertion_delete — positive (must fire)", () => {
	it("P1: deletes each of two expect statements in turn", () => {
		const src = wrap("expect(a).toBe(1);\nexpect(b).toBe(2);");
		expect(applied(src, "assertion_delete")).toEqual([wrap("\nexpect(b).toBe(2);"), wrap("expect(a).toBe(1);\n")]);
	});

	it("P2: counts an awaited resolves statement", () => {
		const src = wrap("await expect(p).resolves.toBe(1);\nexpect(b).toBe(2);");
		expect(of(src, "assertion_delete")).toHaveLength(2);
	});
});

describe("test-mutants assertion_delete — negative (must not fire)", () => {
	it("N1: a test with a single expect statement keeps it", () => {
		expect(of(wrap("expect(a).toBe(1);"), "assertion_delete")).toEqual([]);
	});

	it("N2: an unbraced if-body expect is not deleted (would orphan the if)", () => {
		const src = wrap("if (c) expect(a).toBe(1);\nexpect(b).toBe(2);");
		const deleted = applied(src, "assertion_delete");
		expect(deleted).toEqual([wrap("if (c) expect(a).toBe(1);\n")]);
	});

	it("N3: expects of a nested test do not count toward the outer test", () => {
		const src = `it("outer", () => {\n  expect(a).toBe(1);\n  it("inner", () => { expect(b).toBe(2); });\n});\n`;
		expect(of(src, "assertion_delete")).toEqual([]);
	});
});

describe("test-mutants matcher_loosen — positive (must fire)", () => {
	it("P1: replaces each specific matcher with its weaker form", () => {
		const cases: Array<[string, string]> = [
			["expect(a).toBe(1);", "expect(a).toBeDefined();"],
			["expect(a).toEqual({ k: 1 });", "expect(a).toBeDefined();"],
			["expect(a).toStrictEqual([1]);", "expect(a).toBeDefined();"],
			["expect(a).toHaveLength(2);", "expect(a).toBeDefined();"],
			["expect(a).toContain('x');", "expect(a).toBeTruthy();"],
			["expect(a).toMatch(/x/);", 'expect(a).toBeTypeOf("string");'],
			["expect(() => f()).toThrow('boom');", "expect(() => f()).toThrow();"],
			["await expect(p).rejects.toThrow(/boom/);", "await expect(p).rejects.toThrow();"],
		];
		for (const [before, after] of cases) {
			expect([before, applied(wrap(before), "matcher_loosen")]).toEqual([before, [wrap(after)]]);
		}
	});
});

describe("test-mutants matcher_loosen — negative (must not fire)", () => {
	it("N1: a negated matcher is not loosened (that would tighten it)", () => {
		expect(of(wrap("expect(a).not.toBe(1);"), "matcher_loosen")).toEqual([]);
	});

	it("N2: toThrow() without a message, toBe(undefined) and unrelated matchers stay", () => {
		const body = "expect(f).toThrow();\nexpect(a).toBe(undefined);\nexpect(a).toBeTruthy();\nexpect(a).toBe(1, 2);";
		expect(of(wrap(body), "matcher_loosen")).toEqual([]);
	});
});

describe("test-mutants expected_perturb — positive (must fire)", () => {
	it("P1: bumps a number, appends to a string, flips a boolean", () => {
		expect(applied(wrap("expect(a).toBe(5);"), "expected_perturb")).toEqual([wrap("expect(a).toBe(6);")]);
		expect(applied(wrap('expect(a).toBe("ab");'), "expected_perturb")).toEqual([wrap('expect(a).toBe("abx");')]);
		expect(applied(wrap("expect(a).toBe(true);"), "expected_perturb")).toEqual([wrap("expect(a).toBe(false);")]);
		expect(applied(wrap("expect(a).toBe(false);"), "expected_perturb")).toEqual([wrap("expect(a).toBe(true);")]);
	});

	it("P2: perturbs values inside an object but never its keys", () => {
		const out = applied(wrap('expect(a).toEqual({ n: 1, s: "q", list: [2] });'), "expected_perturb");
		expect(out).toEqual([
			wrap('expect(a).toEqual({ n: 2, s: "q", list: [2] });'),
			wrap('expect(a).toEqual({ n: 1, s: "qx", list: [2] });'),
			wrap('expect(a).toEqual({ n: 1, s: "q", list: [3] });'),
		]);
	});

	it("P3: perturbs through an asymmetric matcher", () => {
		const out = applied(wrap('expect(a).toEqual(expect.stringContaining("ab"));'), "expected_perturb");
		expect(out).toEqual([wrap('expect(a).toEqual(expect.stringContaining("abx"));')]);
	});
});

describe("test-mutants expected_perturb — negative (must not fire)", () => {
	it("N1: empty array and empty object expectations are skipped", () => {
		expect(of(wrap("expect(a).toEqual([]);\nexpect(b).toEqual({});"), "expected_perturb")).toEqual([]);
	});

	it("N2: literals inside the subject expect(...) or a nested helper call are not expected values", () => {
		expect(of(wrap("expect(3).toBe(compute(4));"), "expected_perturb")).toEqual([]);
	});

	it("N3: a negated matcher keeps its literal (perturbing it stays vacuously green)", () => {
		expect(of(wrap("expect(a).not.toBe(5);"), "expected_perturb")).toEqual([]);
	});
});

describe("test-mutants expect_assertions_remove — positive (must fire)", () => {
	it("P1: drops expect.assertions(n) and expect.hasAssertions()", () => {
		const src = wrap("expect.assertions(2);\nexpect.hasAssertions();");
		expect(applied(src, "expect_assertions_remove")).toEqual([wrap("\nexpect.hasAssertions();"), wrap("expect.assertions(2);\n")]);
	});
});

describe("test-mutants expect_assertions_remove — negative (must not fire)", () => {
	it("N1: an asymmetric matcher call is not a count declaration", () => {
		expect(of(wrap("expect(a).toEqual(expect.anything());"), "expect_assertions_remove")).toEqual([]);
	});

	it("N2: an unbraced if-body declaration is left alone", () => {
		expect(of(wrap("if (c) expect.assertions(1);"), "expect_assertions_remove")).toEqual([]);
	});
});

describe("test-mutants timeout_widen — positive (must fire)", () => {
	it("P1: widens a numeric third argument", () => {
		const src = `it("slow", () => {}, 5000);\n`;
		expect(applied(src, "timeout_widen")).toEqual([`it("slow", () => {}, 50000);\n`]);
	});

	it("P2: widens { timeout: n } options", () => {
		const src = `it("slow", { timeout: 2000 }, () => {});\n`;
		expect(applied(src, "timeout_widen")).toEqual([`it("slow", { timeout: 20000 }, () => {});\n`]);
		expect(of(src, "timeout_widen")[0]?.testName).toBe("slow");
	});

	it("P3: widens vi.setConfig({ testTimeout }) with an empty test name", () => {
		const src = `vi.setConfig({ testTimeout: 3000 });\n`;
		const [m] = of(src, "timeout_widen");
		expect(applyTestMutant(src, m as TestMutant)).toBe(`vi.setConfig({ testTimeout: 30000 });\n`);
		expect(m?.testName).toBe("");
	});
});

describe("test-mutants timeout_widen — negative (must not fire)", () => {
	it("N1: a timeout held in a variable is not a literal", () => {
		const src = `const T = 5000;\nit("a", () => {}, T);\nit("b", { timeout: T }, () => {});\nvi.setConfig({ testTimeout: T });\n`;
		expect(of(src, "timeout_widen")).toEqual([]);
	});

	it("N2: a zero timeout and unrelated numeric options stay", () => {
		expect(of(`it("a", { timeout: 0, retry: 2 }, () => {});\n`, "timeout_widen")).toEqual([]);
	});
});

describe("test-mutants await_drop — positive (must fire)", () => {
	it("P1: drops await before rejects and resolves chains", () => {
		const src = wrap("await expect(p).rejects.toThrow();\nawait expect(q).resolves.toBe(1);");
		expect(applied(src, "await_drop")).toEqual([
			wrap("expect(p).rejects.toThrow();\nawait expect(q).resolves.toBe(1);"),
			wrap("await expect(p).rejects.toThrow();\nexpect(q).resolves.toBe(1);"),
		]);
	});
});

describe("test-mutants await_drop — negative (must not fire)", () => {
	it("N1: await on a synchronous matcher, a plain call, or a missing await stays", () => {
		const body = "await expect(a).toBe(1);\nawait other();\nreturn expect(p).rejects.toThrow();";
		expect(of(wrap(body), "await_drop")).toEqual([]);
	});
});

describe("test-mutants mock_to_real — positive (must fire)", () => {
	it("P1: comments out a relative vi.mock and records the specifier", () => {
		const src = `vi.mock("./dep.js", () => ({ x: 1 }));\nit("a", () => {});\n`;
		const [m] = of(src, "mock_to_real");
		expect(m?.detail).toBe("./dep.js");
		expect(m?.testName).toBe("");
		expect(applied(src, "mock_to_real")).toEqual([`/* vi.mock removed */\nit("a", () => {});\n`]);
	});

	it("P2: handles a parent-relative specifier", () => {
		expect(of(`vi.mock("../lib/x.js");\n`, "mock_to_real")[0]?.detail).toBe("../lib/x.js");
	});
});

describe("test-mutants mock_to_real — negative (must not fire)", () => {
	it("N1: bare-package and node: specifiers are not relative modules", () => {
		const src = `vi.mock("node:fs");\nvi.mock("vitest");\nvi.mock("@scope/pkg");\n`;
		expect(of(src, "mock_to_real")).toEqual([]);
	});

	it("N2: a vi.mock that is an unbraced if-body is left alone", () => {
		expect(of(`if (c) vi.mock("./x.js");\n`, "mock_to_real")).toEqual([]);
	});
});

describe("test-mutants enumeration and apply — positive (must fire)", () => {
	const composite = [
		`vi.mock("./dep.js");`,
		`vi.setConfig({ testTimeout: 100 });`,
		`it("a", async () => {`,
		`  expect.assertions(2);`,
		`  expect(f(1)).toEqual({ n: 1 });`,
		`  await expect(g()).rejects.toThrow("bad");`,
		`}, 200);`,
		`test.each([1])("b %i", (n) => { expect(n).toBe(1); expect(n).not.toBe(2); });`,
		``,
	].join("\n");

	it("P1: every mutant round-trips to different, syntactically valid source", () => {
		const ts = loadTsModule();
		const mutants = enumerateTestMutants(FILE, composite);
		expect(mutants.length).toBeGreaterThan(10);
		let valid = 0;
		for (const m of mutants) {
			const out = applyTestMutant(composite, m);
			expect(out).not.toBe(composite);
			expect(out.slice(0, m.start)).toBe(composite.slice(0, m.start));
			const diags = ts?.transpileModule(out, { reportDiagnostics: true }).diagnostics ?? [];
			if (diags.length === 0) valid += 1;
		}
		expect([valid, mutants.length]).toEqual([mutants.length, mutants.length]);
	});

	it("P2: ids are stable across runs and unique within a file; every kind is exercised", () => {
		const a = enumerateTestMutants(FILE, composite);
		const b = enumerateTestMutants(FILE, composite);
		expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
		expect(new Set(a.map((m) => m.id)).size).toBe(a.length);
		expect(new Set(a.map((m) => m.kind))).toEqual(new Set(TEST_MUTANT_KINDS));
	});

	it("P3: lines are 1-based and testName follows the enclosing test", () => {
		const names = new Map(enumerateTestMutants(FILE, composite).map((m) => [m.kind, m.testName]));
		expect(names.get("await_drop")).toBe("a");
		const negate = enumerateTestMutants(FILE, composite).find((m) => m.kind === "assertion_negate");
		expect(negate?.line).toBeGreaterThanOrEqual(5);
		expect(enumerateTestMutants(FILE, composite).find((m) => m.kind === "mock_to_real")?.line).toBe(1);
	});

	it("P4: describeKind is re-exported and answers for every kind", () => {
		expect(TEST_MUTANT_KINDS.every((k) => describeKind(k).length > 0)).toBe(true);
	});
});

describe("test-mutants enumeration and apply — negative (must not fire)", () => {
	it("N1: applying a mutant to drifted content throws TestMutantDriftError", () => {
		const src = wrap("expect(a).toBe(1);");
		const [m] = enumerateTestMutants(FILE, src);
		const drifted = src.replace("toBe", "toEqual");
		expect(() => applyTestMutant(drifted, m as TestMutant)).toThrow(TestMutantDriftError);
	});

	it("N2: a mutant whose range lies beyond the content is refused as drift", () => {
		const [m] = enumerateTestMutants(FILE, wrap("expect(a).toBe(1);"));
		expect(() => applyTestMutant("", m as TestMutant)).toThrow(TestMutantDriftError);
	});

	it("N3: typescript absent returns no mutants with a stated reason", () => {
		const out = enumerateTestMutantsDetailed(FILE, wrap("expect(a).toBe(1);"), null);
		expect(out.mutants).toEqual([]);
		expect(out.unavailableReason).toMatch(/typescript/);
	});

	it("N4: a file with no tests and no mocks yields nothing, and unparseable text does not throw", () => {
		expect(enumerateTestMutants(FILE, "export const x = 1;\n")).toEqual([]);
		expect(() => enumerateTestMutants(FILE, "it('a', () => { expect(")).not.toThrow();
	});
});
