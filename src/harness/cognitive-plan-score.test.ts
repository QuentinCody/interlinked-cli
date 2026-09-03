// Parity + unit cases for the planner's subtree scorer (cognitive-plan-score.ts).
//
// The scorer mirrors the ACCUMULATION walk of `scoreUnit` in
// checks/cognitive-ast.ts (it shares that module's increment predicates, but
// not its traversal). The parity block below is the anti-drift pin: scoring a
// function's own body statements at its function-ancestor depth must reproduce
// the shipped `computeCognitiveAst` figure exactly.
import { describe, expect, it } from "vitest";
import { computeCognitiveAst } from "./checks/cognitive-ast.js";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { hasEscapingJump, logicalRunCount, scoreNodes } from "./cognitive-plan-score.js";

/** Does the body of the first top-level function transfer control out of itself? */
function firstBodyEscapes(src: string): boolean {
	const parsed = parseTsSource(src, "/tmp/score.ts");
	if (!parsed) throw new Error("typescript unavailable");
	const { ts, sf } = parsed;
	const fn = sf.statements.find((s) => ts.isFunctionDeclaration(s));
	if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("no function declaration");
	return hasEscapingJump(ts, fn.body.statements);
}

/** Score the body statements of the FIRST top-level function declaration at depth 0. */
function scoreFirstBody(src: string): { cost: number; nestingIncrements: number } {
	const parsed = parseTsSource(src, "/tmp/score.ts");
	if (!parsed) throw new Error("typescript unavailable — the scorer tests need it");
	const { ts, sf } = parsed;
	const fn = sf.statements.find((s) => ts.isFunctionDeclaration(s));
	if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("no function declaration");
	return scoreNodes(ts, fn.body.statements, 0);
}

function shippedScore(src: string): number {
	const entries = computeCognitiveAst(src, "/tmp/score.ts");
	if (!entries) throw new Error("typescript unavailable");
	const first = entries[0];
	if (!first) throw new Error("no entries");
	return first.cognitive;
}

/** The expression of the first `return` in the source, for logicalRunCount cases. */
function firstReturnRuns(src: string): number {
	const parsed = parseTsSource(src, "/tmp/score.ts");
	if (!parsed) throw new Error("typescript unavailable");
	const { ts, sf } = parsed;
	let expr: import("typescript").Expression | undefined;
	const walk = (node: import("typescript").Node): void => {
		if (!expr && ts.isReturnStatement(node) && node.expression) expr = node.expression;
		ts.forEachChild(node, walk);
	};
	walk(sf);
	if (!expr) throw new Error("no return expression");
	return logicalRunCount(ts, expr);
}

const CASES: ReadonlyArray<readonly [string, string]> = [
	["nested ifs", "export function f(a: boolean, b: boolean, c: boolean) {\n if (a) { if (b) { if (c) { return 1; } } }\n return 0;\n}\n"],
	["else-if chain", "export function f(a: number) {\n if (a === 1) { return 1; } else if (a === 2) { return 2; } else { return 3; }\n}\n"],
	["loop with switch", "export function f(xs: number[]) {\n for (const x of xs) { switch (x) { case 1: return 1; default: break; } }\n return 0;\n}\n"],
	["try/catch/finally", "export function f(g: () => void) {\n try { g(); } catch (e) { if (e) { return 1; } } finally { g(); }\n return 0;\n}\n"],
	["mixed logical run", "export function f(a: boolean, b: boolean, c: boolean, d: boolean) {\n return a && b || c && d;\n}\n"],
	["ternary and nullish", "export function f(a: number | null, b: number) {\n return a ?? (b > 1 ? b : 0);\n}\n"],
	["labeled continue", "export function f(xs: number[]) {\n let r = 0;\n outer: for (const x of xs) { if (x) { continue outer; } }\n return r;\n}\n"],
	["while with logical guard", "export function f(a: boolean, b: boolean) {\n let n = 0;\n while (a && b) { if (a) { n += 1; } }\n return n;\n}\n"],
];

describe("scoreNodes — parity with the shipped cognitive scorer (positive)", () => {
	for (const [label, src] of CASES) {
		it(`P: reproduces computeCognitiveAst for ${label}`, () => {
			expect(scoreFirstBody(src).cost).toBe(shippedScore(src));
		});
	}
});

describe("scoreNodes — nesting arithmetic (positive)", () => {
	it("P1: charges 1 + depth per nesting-paying structure", () => {
		const src = "export function f(a: boolean, b: boolean) {\n if (a) { if (b) { return 1; } }\n return 0;\n}\n";
		expect(scoreFirstBody(src).cost).toBe(3); // 1 + 2
	});

	it("P2: counts nesting-paying increments separately from cost", () => {
		const src = "export function f(a: boolean, b: boolean, c: boolean) {\n if (a) { if (b) { return 1; } if (c) { return 2; } }\n return 0;\n}\n";
		expect(scoreFirstBody(src)).toEqual({ cost: 5, nestingIncrements: 3 });
	});

	it("P3: an `else if` continuation is flat — +1, no nesting increment", () => {
		const src = "export function f(a: number) {\n if (a === 1) { return 1; } else if (a === 2) { return 2; }\n return 0;\n}\n";
		expect(scoreFirstBody(src)).toEqual({ cost: 2, nestingIncrements: 1 });
	});

	it("P4: scoring the same nodes deeper costs one more per nesting increment", () => {
		const parsed = parseTsSource(
			"export function f(a: boolean, b: boolean) {\n if (a) { if (b) { return 1; } }\n return 0;\n}\n",
			"/tmp/score.ts",
		);
		if (!parsed) throw new Error("typescript unavailable");
		const { ts, sf } = parsed;
		const fn = sf.statements.find((s) => ts.isFunctionDeclaration(s));
		if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) throw new Error("no function");
		const flat = scoreNodes(ts, fn.body.statements, 0);
		const deep = scoreNodes(ts, fn.body.statements, 1);
		expect(deep.cost - flat.cost).toBe(flat.nestingIncrements);
	});
});

describe("scoreNodes — boundaries (negative)", () => {
	it("N1: a nested function-like contributes nothing to the enclosing score", () => {
		const src = "export function f(xs: number[]) {\n const g = (x: number) => { if (x) { if (x) { return 1; } } return 0; };\n return xs.map(g);\n}\n";
		expect(scoreFirstBody(src)).toEqual({ cost: 0, nestingIncrements: 0 });
	});

	it("N2: straight-line statements score zero", () => {
		const src = "export function f(a: number) {\n const x = a + 1;\n const y = x * 2;\n return y;\n}\n";
		expect(scoreFirstBody(src)).toEqual({ cost: 0, nestingIncrements: 0 });
	});

	it("N3: an empty node list scores zero", () => {
		const parsed = parseTsSource("export const a = 1;\n", "/tmp/score.ts");
		if (!parsed) throw new Error("typescript unavailable");
		expect(scoreNodes(parsed.ts, [], 5)).toEqual({ cost: 0, nestingIncrements: 0 });
	});
});

describe("hasEscapingJump", () => {
	it("P7: a `return` escapes — the caller needs a residual guard", () => {
		expect(firstBodyEscapes("export function f(a: boolean) { if (a) { return 1; } }\n")).toBe(true);
	});

	it("P8: a `break` whose loop sits OUTSIDE the list escapes", () => {
		expect(firstBodyEscapes("export function f(a: boolean) { if (a) { break; } }\n")).toBe(true);
	});

	it("P9: a `continue` whose loop sits outside the list escapes", () => {
		expect(firstBodyEscapes("export function f(a: boolean) { if (a) { continue; } }\n")).toBe(true);
	});

	it("N6: a `break` bound to a loop INSIDE the list does not escape", () => {
		const src = "export function f(xs: number[]) { for (const x of xs) { if (x) { break; } } }\n";
		expect(firstBodyEscapes(src)).toBe(false);
	});

	it("N7: a `break` bound to a switch inside the list does not escape", () => {
		const src = "export function f(a: number) { switch (a) { case 1: break; default: break; } }\n";
		expect(firstBodyEscapes(src)).toBe(false);
	});

	it("N8: a `return` inside a nested callback is local to it, not an escape", () => {
		const src = "export function f(xs: number[]) { xs.map((x) => { return x + 1; }); }\n";
		expect(firstBodyEscapes(src)).toBe(false);
	});

	it("N9: straight-line statements never escape", () => {
		expect(firstBodyEscapes("export function f(a: number) { const x = a + 1; }\n")).toBe(false);
	});
});

describe("logicalRunCount", () => {
	it("P5: a mixed &&/|| sequence counts every operator-run transition", () => {
		expect(firstReturnRuns("export function f(a: boolean, b: boolean, c: boolean, d: boolean) { return a && b || c && d; }\n")).toBe(3);
	});

	it("P6: parentheses end a run, so a parenthesised group costs its own transition", () => {
		expect(firstReturnRuns("export function f(a: boolean, b: boolean, c: boolean) { return a && (b || c); }\n")).toBe(2);
	});

	it("N4: a uniform && run costs exactly one transition", () => {
		expect(firstReturnRuns("export function f(a: boolean, b: boolean, c: boolean) { return a && b && c; }\n")).toBe(1);
	});

	it("N5: a non-logical expression counts zero transitions", () => {
		expect(firstReturnRuns("export function f(a: number, b: number) { return a + b; }\n")).toBe(0);
	});
});
