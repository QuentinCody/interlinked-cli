import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import { loadTsModule } from "./differential-fuzz-deps.js";
import { isCannedExpression, isCannedFunctionBody } from "./test-doubles-canned.js";

const ts = loadTsModule();
if (ts === null) throw new Error("typescript is required for the test-doubles suite");
const tsc: typeof TS = ts;

/** Initializer of `const x = <src>;`. */
function init(src: string): TS.Expression {
	const sf = tsc.createSourceFile("t.ts", `const x = ${src};`, tsc.ScriptTarget.Latest, true);
	const stmt = sf.statements[0];
	if (stmt === undefined || !tsc.isVariableStatement(stmt)) throw new Error("bad fixture");
	const decl = stmt.declarationList.declarations[0];
	if (decl?.initializer === undefined) throw new Error("bad fixture");
	return decl.initializer;
}

const canned = (src: string): boolean => isCannedExpression(tsc, init(src));

describe("isCannedExpression — positive (must be canned)", () => {
	it("P1: scalar literals", () => {
		expect(["1", "-1", '"a"', "`b`", "true", "null", "undefined", "/x/"].map(canned)).toEqual(Array(8).fill(true));
	});
	it("P2: object and array of literals", () => {
		expect(canned('{ a: 1, b: ["x", { c: false }] }')).toBe(true);
	});
	it("P3: bare vi.fn() and vi.fn(() => literal)", () => {
		expect(canned("vi.fn()")).toBe(true);
		expect(canned("vi.fn(() => 'ok')")).toBe(true);
	});
	it("P4: chained mockResolvedValue with literal", () => {
		expect(canned("vi.fn().mockResolvedValue({ ok: true })")).toBe(true);
	});
	it("P5: arrow with block body returning literal after canned const", () => {
		expect(canned("() => { const a = 1; return 2; }")).toBe(true);
	});
	it("P6: method declaration returning literal; Promise.resolve(literal)", () => {
		expect(canned("{ get() { return 1; }, load: () => Promise.resolve(2) }")).toBe(true);
	});
});

describe("isCannedExpression — negative (must not be canned)", () => {
	it("N1: identifier reference", () => {
		expect(canned("someValue")).toBe(false);
	});
	it("N2: spread of importActual is a partial mock", () => {
		expect(canned("{ ...(await vi.importActual('./x')), f: vi.fn() }")).toBe(false);
	});
	it("N3: arrow that calls another function", () => {
		expect(canned("() => compute(1)")).toBe(false);
	});
	it("N4: template with substitution, shorthand property (reads a binding), computed expression", () => {
		expect(canned("`a${b}`")).toBe(false);
		expect(canned("{ a }")).toBe(false);
		expect(canned("1 + 2")).toBe(false);
	});
	it("N5: vi.fn with a non-canned implementation", () => {
		expect(canned("vi.fn((a) => a.value)")).toBe(false);
		expect(canned("vi.fn().mockReturnValue(real)")).toBe(false);
	});
	it("N6: undefined node", () => {
		expect(isCannedExpression(tsc, undefined)).toBe(false);
	});
});

describe("isCannedFunctionBody — positive and negative", () => {
	const body = (src: string): boolean => {
		const fn = init(src);
		if (!tsc.isArrowFunction(fn)) throw new Error("bad fixture");
		return isCannedFunctionBody(tsc, fn.body);
	};
	it("P7: empty block is canned (returns undefined)", () => {
		expect(body("() => {}")).toBe(true);
	});
	it("N7: block with a side-effect statement is not canned", () => {
		expect(body("() => { doThing(); return 1; }")).toBe(false);
	});
	it("N8: block that does not end in return is not canned", () => {
		expect(body("() => { const a = 1; }")).toBe(false);
	});
});
