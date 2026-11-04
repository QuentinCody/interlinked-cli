import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import { loadTsModule, type TsModule } from "./differential-fuzz-deps.js";
import {
	countExpectStatements,
	hasModifier,
	inStatementList,
	isTestCall,
	parseExpectChain,
	statementChain,
	testTitle,
} from "./test-mutants-chain.js";

function requireTs(): TsModule {
	const loaded = loadTsModule();
	if (loaded === null) throw new Error("typescript is required for the chain tests");
	return loaded;
}

const ts = requireTs();

function parse(src: string): TS.SourceFile {
	return ts.createSourceFile("t.test.ts", src, ts.ScriptTarget.Latest, true);
}

/** First node of the given kind, depth first. */
function first<T extends TS.Node>(sf: TS.SourceFile, guard: (n: TS.Node) => n is T): T {
	let found: T | null = null;
	const visit = (n: TS.Node): void => {
		if (found === null && guard(n)) found = n;
		if (found === null) ts.forEachChild(n, visit);
	};
	visit(sf);
	if (found === null) throw new Error("no node");
	return found;
}

function chainOf(src: string) {
	const stmt = first(parse(src), ts.isExpressionStatement);
	return statementChain(ts, stmt);
}

describe("test-mutants-chain — positive (must fire)", () => {
	it("P1: parses expect(x).toBe(1) with no modifiers", () => {
		const chain = chainOf("expect(x).toBe(1);");
		expect(chain?.matcherName).toBe("toBe");
		expect(chain?.modifiers).toHaveLength(0);
	});

	it("P2: parses modifiers .resolves.not and sees through await", () => {
		const chain = chainOf("await expect(p).resolves.not.toBe(1);");
		expect(chain?.modifiers.map((m: TS.PropertyAccessExpression) => m.name.text)).toEqual(["resolves", "not"]);
		expect(chain !== null && hasModifier(chain, "not")).toBe(true);
	});

	it("P3: recognizes it/test/it.only/it.each calls with a callback and reads the title", () => {
		const calls = ["it('a', () => {});", "test('a', () => {});", "it.only('a', () => {});", "it.each([1])('a', () => {});"];
		for (const src of calls) {
			const outer = first(parse(src), ts.isExpressionStatement).expression;
			if (!ts.isCallExpression(outer)) throw new Error("not a call");
			expect([src, isTestCall(ts, outer)]).toEqual([src, true]);
			expect(testTitle(ts, outer)).toBe("a");
		}
	});

	it("P4: counts expect statements without entering nested tests", () => {
		const sf = parse("it('a', () => { expect(1).toBe(1); it('b', () => { expect(2).toBe(2); }); expect(3).toBe(3); });");
		const call = first(sf, ts.isCallExpression);
		expect(countExpectStatements(ts, call)).toBe(2);
	});

	it("P5: a statement in a block is in a statement list", () => {
		const sf = parse("function f() { foo(); }");
		const stmt = first(sf, ts.isExpressionStatement);
		expect(inStatementList(ts, stmt)).toBe(true);
	});
});

describe("test-mutants-chain — negative (must not fire)", () => {
	it("N1: obj.expect(x).toBe(1) and expect.assertions(1) are not chains", () => {
		expect(chainOf("obj.expect(x).toBe(1);")).toBeNull();
		expect(chainOf("expect.assertions(1);")).toBeNull();
	});

	it("N2: an unknown modifier breaks the chain", () => {
		expect(chainOf("expect(x).foo.toBe(1);")).toBeNull();
		expect(parseExpectChain(ts, parse("expect(x);"))).toBeNull();
	});

	it("N3: regex.test(...) and a call without a callback are not test calls", () => {
		const a = first(parse("regex.test(() => 1);"), ts.isCallExpression);
		const b = first(parse("it.each([1]);"), ts.isCallExpression);
		expect(isTestCall(ts, a)).toBe(false);
		expect(isTestCall(ts, b)).toBe(false);
	});

	it("N4: a dynamic title is flagged and an unbraced if-body is not a statement list", () => {
		const call = first(parse("it(name, () => {});"), ts.isCallExpression);
		expect(testTitle(ts, call)).toBe("<dynamic>");
		const stmt = first(parse("if (a) foo();"), ts.isExpressionStatement);
		expect(inStatementList(ts, stmt)).toBe(false);
	});
});
