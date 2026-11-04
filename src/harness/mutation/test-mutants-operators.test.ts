import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import { loadTsModule, type TsModule } from "./differential-fuzz-deps.js";
import { collectRawMutants } from "./test-mutants-operators.js";
import type { RawTestMutant, TestContext } from "./test-mutants-types.js";

function requireTs(): TsModule {
	const loaded = loadTsModule();
	if (loaded === null) throw new Error("typescript is required for the operator tests");
	return loaded;
}

const ts = requireTs();
const IN_TEST: TestContext = { testName: "t", expectStatementCount: 2 };
const OUTSIDE: TestContext = { testName: null, expectStatementCount: 0 };

/** Raw mutants proposed for the first node of the given kind. */
function raw<T extends TS.Node>(src: string, guard: (n: TS.Node) => n is T, ctx: TestContext): RawTestMutant[] {
	const sf = ts.createSourceFile("t.test.ts", src, ts.ScriptTarget.Latest, true);
	let target: T | null = null;
	const visit = (n: TS.Node): void => {
		if (target === null && guard(n)) target = n;
		if (target === null) ts.forEachChild(n, visit);
	};
	visit(sf);
	if (target === null) throw new Error("no node of that kind");
	return collectRawMutants(ts, sf, target, ctx);
}

describe("test-mutants-operators — positive (must fire)", () => {
	it("P1: a matcher call inside a test proposes negate, loosen and perturb", () => {
		const kinds = raw("expect(a).toBe(1);", ts.isCallExpression, IN_TEST).map((m) => m.kind);
		expect(kinds).toEqual(["assertion_negate", "matcher_loosen", "expected_perturb"]);
	});

	it("P2: an expect statement proposes a deletion when the test has two or more", () => {
		const kinds = raw("{ expect(a).toBe(1); }", ts.isExpressionStatement, IN_TEST).map((m) => m.kind);
		expect(kinds).toEqual(["assertion_delete"]);
	});

	it("P3: a test call carries its own title on a timeout mutant", () => {
		const out = raw('it("slow", () => {}, 100);', ts.isCallExpression, OUTSIDE);
		expect(out.map((m) => [m.kind, m.testName, m.replacement])).toEqual([["timeout_widen", "slow", "1000"]]);
	});
});

describe("test-mutants-operators — negative (must not fire)", () => {
	it("N1: nothing is proposed for an expect chain outside any test", () => {
		expect(raw("expect(a).toBe(1);", ts.isCallExpression, OUTSIDE)).toEqual([]);
	});

	it("N2: a lone expect statement is not deletable", () => {
		const lone: TestContext = { testName: "t", expectStatementCount: 1 };
		expect(raw("{ expect(a).toBe(1); }", ts.isExpressionStatement, lone)).toEqual([]);
	});

	it("N3: an identifier node proposes nothing", () => {
		expect(raw("foo;", ts.isIdentifier, IN_TEST)).toEqual([]);
	});
});
