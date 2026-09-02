import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import {
	__resetTsCacheForTesting,
	astComplexityAvailable,
	computeCyclomaticAst,
	functionName,
	isDecisionPoint,
	isFunctionLike,
	isImplementationFunction,
	type ParsedTsSource,
	parseTsSource,
	type TsModule,
} from "./cyclomatic-ast.js";

const run = (src: string) => computeCyclomaticAst(src, "src/x.ts") ?? [];
const byName = (src: string, name: string) => run(src).find((e) => e.name === name);

describe("cyclomatic-ast — availability", () => {
	it("typescript is resolvable in this environment (AST path active)", () => {
		expect(astComplexityAvailable()).toBe(true);
	});
});

describe("cyclomatic-ast — per-function scope (the headline fix)", () => {
	it("counts an inline callback as its OWN function, not rolled into the parent", () => {
		const src = `
			export function parent(xs: number[]): number {
				if (xs.length === 0) return 0;        // parent +1
				return xs.map((x) => {
					return x > 0 ? x : -x;            // ternary belongs to the CALLBACK, not parent
				}).reduce((a, b) => a + b, 0);
			}
		`;
		// The whole point: the ternary inside .map's callback must NOT inflate
		// `parent`. Parent = base 1 + its own `if` = 2 (the regex walker gave 3).
		expect(byName(src, "parent")?.cyclomatic).toBe(2);
		const callback = run(src).find((e) => e.name === "(callback)");
		expect(callback?.cyclomatic).toBe(2); // base 1 + the ternary
	});

	it("emits a separate entry for each nested function", () => {
		const src = `function outer() { const a = () => 1; const b = () => 2; return a() + b(); }`;
		expect(run(src).length).toBe(3); // outer + 2 arrows
	});
});

describe("cyclomatic-ast — decision set", () => {
	it("counts `??` as a branch", () => {
		expect(byName(`function f(a: unknown) { return a ?? 1; }`, "f")?.cyclomatic).toBe(2);
	});

	it("counts if / && / || / for / while / case / catch / ternary", () => {
		const src = `function f(a: number, b: number) {
			if (a && b || a) { return 1; }            // if +1, && +1, || +1
			for (let i = 0; i < a; i++) {}            // +1
			while (b > 0) { b--; }                    // +1
			switch (a) { case 1: break; case 2: break; default: break; } // case +2 (default excluded)
			try { b++; } catch (e) { void e; }        // catch +1
			return a > 0 ? 1 : 2;                     // ternary +1
		}`;
		// base 1 + if + && + || + for + while + 2*case + catch + ternary = 10
		expect(byName(src, "f")?.cyclomatic).toBe(10);
	});

	it("does not count a `default:` clause", () => {
		expect(byName(`function f(a: number) { switch (a) { default: return 0; } }`, "f")?.cyclomatic).toBe(1);
	});

	it("does not count `?.` optional chaining", () => {
		expect(byName(`function f(x: { v?: number } | null) { return x?.v; }`, "f")?.cyclomatic).toBe(1);
	});
});

describe("cyclomatic-ast — implementation functions only", () => {
	it("excludes bodiless overload signatures, keeping the implementation", () => {
		const src = `
			export function f(a: string): string;
			export function f(a: number): number;
			export function f(a: unknown): unknown { return a; }
		`;
		expect(run(src).filter((e) => e.name === "f").length).toBe(1);
	});

	it("counts methods, getters, and constructors", () => {
		const src = `class C { constructor() {} get x() { return 1; } m(a: number) { return a > 0 ? 1 : 2; } }`;
		const names = run(src).map((e) => e.name).sort();
		expect(names).toContain("constructor");
		expect(names).toContain("x");
		expect(names).toContain("m");
		expect(byName(src, "m")?.cyclomatic).toBe(2); // the ternary
	});

	it("reports accurate 1-based start lines (for coverage matching)", () => {
		const src = "\n\nfunction first() { return 1; }\nfunction second() { return 2; }\n";
		expect(byName(src, "first")?.line).toBe(3);
		expect(byName(src, "second")?.line).toBe(4);
	});
});

describe("cyclomatic-ast — parse memo", () => {
	it("returns the SAME SourceFile for identical content + path", () => {
		const src = "export function memoA(): number { return 1; }";
		const first = parseTsSource(src, "src/memo.ts");
		const second = parseTsSource(src, "src/memo.ts");
		expect(first).not.toBeNull();
		expect(second?.sf).toBe(first?.sf);
	});

	it("re-parses when the content changes under the SAME path (the per-edit case)", () => {
		const before = parseTsSource("export const v = 1;", "src/same-path.ts");
		const after = parseTsSource("export const v = 2;", "src/same-path.ts");
		expect(after?.sf).not.toBe(before?.sf);
		expect(after?.sf.text).toBe("export const v = 2;");
	});

	it("re-parses identical content under a DIFFERENT path", () => {
		const src = "export const shared = 1;";
		const a = parseTsSource(src, "src/path-a.ts");
		const b = parseTsSource(src, "src/path-b.ts");
		expect(b?.sf).not.toBe(a?.sf);
		expect(a?.sf.fileName).toBe("src/path-a.ts");
	});

	it("keeps the ScriptKind the path implies — .tsx parses JSX cleanly", () => {
		const tsx = parseTsSource("export const el = <div className='x' />;", "src/el.tsx");
		expect(tsx?.sf.languageVariant).toBe(tsx?.ts.LanguageVariant.JSX);
	});

	it("is bounded — the oldest entry is evicted once the cap is passed", () => {
		const src = "export const bounded = 1;";
		const oldest = parseTsSource(src, "src/evict-0.ts");
		// 8 further distinct keys push the first one out of an 8-slot LRU.
		for (let i = 1; i <= 8; i++) parseTsSource(src, `src/evict-${i}.ts`);
		expect(parseTsSource(src, "src/evict-0.ts")?.sf).not.toBe(oldest?.sf);
	});

	it("__resetTsCacheForTesting clears the memo", () => {
		const src = "export const cleared = 1;";
		const before = parseTsSource(src, "src/cleared.ts");
		__resetTsCacheForTesting();
		expect(parseTsSource(src, "src/cleared.ts")?.sf).not.toBe(before?.sf);
	});
});

function scriptKindOf(parsed: ParsedTsSource): number {
	// SAFETY: `scriptKind` is written by ts.createSourceFile's 5th argument and
	// read throughout the TS compiler at runtime (verified empirically: parsing
	// each extension below and reading back `.scriptKind` returns the exact
	// enum value that extension's branch passed in). It is simply narrower than
	// this TS toolchain's bundled public `SourceFile` .d.ts surface.
	return (parsed.sf as unknown as { scriptKind: number }).scriptKind;
}

describe("cyclomatic-ast — scriptKindFor (extension → ScriptKind exact table)", () => {
	// test-contract: invariant — scriptKindFor's own doc comment: "the ONLY copy
	// of this table: a .tsx file parsed as plain TS mis-reads JSX as type
	// assertions". One exact-value assertion per branch (plus the unmatched
	// default) pins the whole switch: case-fold, every string label, and the
	// removed-return default all show up as a wrong ScriptKind here.
	it("maps every extension branch (and the unmatched default) to its exact ScriptKind", () => {
		const at = (path: string) => {
			const parsed = parseTsSource("export const v = 1;", path);
			if (!parsed) throw new Error(`parseTsSource unexpectedly returned null for ${path}`);
			return parsed;
		};
		const tsx = at("f.tsx");
		const jsx = at("f.jsx");
		const js = at("f.js");
		const mjs = at("f.mjs");
		const cjs = at("f.cjs");
		const fallback = at("f.ts"); // hits the `default:` branch — no case matches ".ts"
		expect(scriptKindOf(tsx)).toBe(tsx.ts.ScriptKind.TSX);
		expect(scriptKindOf(jsx)).toBe(jsx.ts.ScriptKind.JSX);
		expect(scriptKindOf(js)).toBe(js.ts.ScriptKind.JS);
		expect(scriptKindOf(mjs)).toBe(mjs.ts.ScriptKind.JS);
		expect(scriptKindOf(cjs)).toBe(cjs.ts.ScriptKind.JS);
		expect(scriptKindOf(fallback)).toBe(fallback.ts.ScriptKind.TS);
	});
});

describe("cyclomatic-ast — functionName resolves through each parent-shape branch", () => {
	// test-contract: invariant — a const-assigned arrow has no own `.name`; the
	// VariableDeclaration-parent branch (`parent && ts.isVariableDeclaration(parent)
	// && ts.isIdentifier(parent.name)`) is the ONLY source of its reported name.
	it("names a const-assigned arrow via its VariableDeclaration parent", () => {
		expect(byName("export const namedArrow = () => 1;", "namedArrow")?.cyclomatic).toBe(1);
	});

	// test-contract: invariant — an anonymous function value in an object literal
	// has no own `.name`; the PropertyAssignment-parent branch is the only source.
	it("names an object-literal property function via its PropertyAssignment parent", () => {
		expect(byName("const o = { fn: function () { return 1; } };", "fn")?.cyclomatic).toBe(1);
	});

	// test-contract: invariant — an anonymous function value on a class field has
	// no own `.name`; the PropertyDeclaration-parent branch is the only source.
	it("names a class-field function via its PropertyDeclaration parent", () => {
		expect(byName("class C { fn = function () { return 1; }; }", "fn")?.cyclomatic).toBe(1);
	});

	// test-contract: boundary — a computed method name is an Expression, not an
	// Identifier/PrivateIdentifier, so the `named.name` fast path must NOT claim
	// it; it falls through every parent check (the parent is the class, not a
	// declaration/assignment/property) to the documented "(callback)" fallback.
	it("does NOT resolve a computed method name as an identifier — falls back to (callback)", () => {
		const entries = run("class C { [computeKey()]() { return 1; } }");
		expect(entries.map((e) => e.name)).toEqual(["(callback)"]);
	});
});

describe("cyclomatic-ast — per-entry field exactness", () => {
	// test-contract: invariant — endLine is `getLineAndCharacterOfPosition(node.getEnd()).line + 1`;
	// a multi-line function makes start/end genuinely differ so an off-by-one
	// (or sign-flip) in that +1 is directly observable, not masked by a same-line fixture.
	it("reports the exact 1-based endLine for a multi-line function", () => {
		const src = "function f() {\n  return 1;\n}\n";
		expect(byName(src, "f")?.endLine).toBe(3);
	});

	// test-contract: invariant — every AST-derived entry is tagged with the exact
	// "js_ts" language discriminator (distinguishing this engine's output from the
	// Python/other-language cyclomatic walkers that share the same result shape).
	it('tags every entry with the exact "js_ts" language discriminator', () => {
		const entries = run("function f() { return 1; }");
		expect(entries[0]?.language).toBe("js_ts");
	});
});

/**
 * Re-derive per-function cyclomatic from the EXPORTED predicate alone, the way
 * the private `complexityOf` did before `isDecisionPoint` was exported: 1 + the
 * decision points under the function's own children, never crossing into a
 * nested function-like.
 */
function referenceCyclomatic(ts: TsModule, fn: TS.Node): number {
	let count = 1;
	const visit = (node: TS.Node): void => {
		if (isFunctionLike(ts, node)) return;
		if (isDecisionPoint(ts, node)) count++;
		ts.forEachChild(node, visit);
	};
	ts.forEachChild(fn, visit);
	return count;
}

/** Every implementation function in `src`, named → count via the exported predicate. */
function referenceCounts(src: string): Array<[string, number]> {
	const parsed = parseTsSource(src, "src/x.ts");
	if (!parsed) throw new Error("typescript dep missing");
	const { ts, sf } = parsed;
	const out: Array<[string, number]> = [];
	const walk = (node: TS.Node): void => {
		if (isImplementationFunction(ts, node)) {
			out.push([functionName(ts, node, sf), referenceCyclomatic(ts, node)]);
		}
		ts.forEachChild(node, walk);
	};
	walk(sf);
	return out;
}

/** The fixtures the decision-set / scope / implementation cases above already pin. */
const EXISTING_FIXTURES: readonly string[] = [
	`export function parent(xs: number[]): number {
		if (xs.length === 0) return 0;
		return xs.map((x) => { return x > 0 ? x : -x; }).reduce((a, b) => a + b, 0);
	}`,
	`function outer() { const a = () => 1; const b = () => 2; return a() + b(); }`,
	`function f(a: unknown) { return a ?? 1; }`,
	`function f(a: number, b: number) {
		if (a && b || a) { return 1; }
		for (let i = 0; i < a; i++) {}
		while (b > 0) { b--; }
		switch (a) { case 1: break; case 2: break; default: break; }
		try { b++; } catch (e) { void e; }
		return a > 0 ? 1 : 2;
	}`,
	`function f(a: number) { switch (a) { default: return 0; } }`,
	`function f(x: { v?: number } | null) { return x?.v; }`,
	`export function f(a: string): string;
	export function f(a: number): number;
	export function f(a: unknown): unknown { return a; }`,
	`class C { constructor() {} get x() { return 1; } m(a: number) { return a > 0 ? 1 : 2; } }`,
];

describe("cyclomatic-ast — exported isDecisionPoint matches the gate's own count", () => {
	// test-contract: invariant — `isDecisionPoint` is the ONE predicate both the
	// gate (`complexityOf`) and the decomposition planner price with. Re-deriving
	// every existing fixture through the exported predicate must reproduce
	// `computeCyclomaticAst` exactly, so exporting it changed nothing.
	it("P1: reproduces computeCyclomaticAst on every existing fixture", () => {
		for (const src of EXISTING_FIXTURES) {
			const expected = run(src).map((e) => [e.name, e.cyclomatic]);
			expect(referenceCounts(src)).toEqual(expected);
		}
	});

	it("P2: fires on each member of the canonical decision set", () => {
		// if, for, for-in, for-of, while, do, case, catch, ?:, &&, ||, ??
		expect(
			decisionPointsIn(
				"function f(a: number) { if (a) {} for (;;) {} for (const k in a) {} for (const v of a) {} " +
					"while (a) {} do {} while (a); switch (a) { case 1: break; } try {} catch {} " +
					"a ? 1 : 2; a && a; a || a; a ?? a; }",
			),
		).toBe(12);
	});

	it("N1: a DefaultClause, `?.`, a Block, and a plain BinaryExpression are not decision points", () => {
		expect(
			decisionPointsIn(
				"function f(a: { v?: number }) { switch (1) { default: break; } return a?.v + 1; }",
			),
		).toBe(0);
	});
});

/** Whole-file count of nodes the exported predicate accepts (no scope rules). */
function decisionPointsIn(src: string): number {
	const parsed = parseTsSource(src, "src/x.ts");
	if (!parsed) throw new Error("typescript dep missing");
	const { ts, sf } = parsed;
	let fired = 0;
	const visit = (node: TS.Node): void => {
		if (isDecisionPoint(ts, node)) fired++;
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return fired;
}
