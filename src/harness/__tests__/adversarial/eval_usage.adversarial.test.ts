// Independent adversarial review of the `eval_usage` pre_block check
// (2026-10-21). Every negative here was a probed false positive before the
// detector was refined: `scratch/2026-10-21-adversarial/eval_usage.probe.mts`.
// A pre_block check blocks an agent's edit, so each of these is a legitimate
// edit the gate used to refuse.

import { describe, expect, it } from "vitest";
import { checkEvalUsage } from "../../checks/agent-safety-js-correctness.js";

describe("eval_usage — negative (must not fire)", () => {
	it("N1: an interface method signature named `eval` is a declaration, not a call", () => {
		const code = "export interface Sandbox {\n\teval(code: string): unknown;\n\tdispose(): void;\n}\n";
		expect(checkEvalUsage(code, "src/sandbox/types.ts")).toEqual([]);
	});

	it("N2: a class method definition named `eval` (an interpreter)", () => {
		const code =
			"export class Interpreter {\n\teval(node: Node): Value {\n\t\treturn walk(node);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.ts")).toEqual([]);
	});

	it("N3: an object-literal method shorthand named `eval` (untyped, .js)", () => {
		const code = "const ops = {\n\teval(expr) {\n\t\treturn parse(expr).value;\n\t},\n};\n";
		expect(checkEvalUsage(code, "src/math/ops.js")).toEqual([]);
	});

	it("N4: a private method `#eval` — definition and `this.#eval(code)` call", () => {
		const code =
			"class Vm {\n\t#eval(code: string): number {\n\t\treturn 1;\n\t}\n\trun(code: string) {\n\t\treturn this.#eval(code);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/vm.ts")).toEqual([]);
	});

	it("N5: an abstract method declaration named `eval`", () => {
		const code = "export abstract class Base {\n\tabstract eval(node: Node): Value;\n}\n";
		expect(checkEvalUsage(code, "src/interp/base.ts")).toEqual([]);
	});

	it("N6: a type literal with an `eval` method", () => {
		expect(
			checkEvalUsage("type Evaluator = { eval(src: string): number };\n", "src/x.ts"),
		).toEqual([]);
	});

	it("N7: JSX prose that mentions `eval(input)` in a docs component", () => {
		const code =
			"export function Warning() {\n\treturn <p>Never pass user input to <code>eval(input)</code> in production.</p>;\n}\n";
		expect(checkEvalUsage(code, "src/docs/Warning.tsx")).toEqual([]);
	});

	it("N8: a `$eval`-suffixed identifier (`page.$eval` style helper named `$eval(`)", () => {
		expect(checkEvalUsage("const n = await $eval(sel, (el) => el.id);\n", "src/x.ts")).toEqual(
			[],
		);
	});

	it("N9: a Prettier-wrapped class method signature named `eval` (parameters on their own lines)", () => {
		const code =
			"export class Interpreter {\n\teval(\n\t\tnode: Node,\n\t\tenv: Environment,\n\t): Value {\n\t\treturn walk(node, env);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.ts")).toEqual([]);
	});

	it("N10: a Prettier-wrapped interface method signature named `eval`", () => {
		const code =
			"export interface Evaluator {\n\teval(\n\t\tsource: string,\n\t\toptions: EvalOptions,\n\t): Promise<Value>;\n}\n";
		expect(checkEvalUsage(code, "src/interp/types.ts")).toEqual([]);
	});

	it("N11: a method named `eval` whose first parameter is callback-typed", () => {
		const code =
			"class Evaluator {\n\teval(resolve: (name: string) => Value, node: Node): Value {\n\t\treturn walk(node, resolve);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.ts")).toEqual([]);
	});

	it("N12: a method named `eval` whose default parameter value is a call", () => {
		const code = "class Evaluator {\n\teval(node, scope = new Scope()) {\n\t\treturn walk(node, scope);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.js")).toEqual([]);
	});

	it("N13: an object-literal method with a destructured typed parameter `eval({ ast, env }: Input): Value {`", () => {
		const code = "const ops = {\n\teval({ ast, env }: Input): Value {\n\t\treturn walk(ast, env);\n\t},\n};\n";
		expect(checkEvalUsage(code, "src/interp/ops.ts")).toEqual([]);
	});

	it("N14: a member call with the dot at the end of the previous line `sandbox.\\n\\teval(code)`", () => {
		expect(checkEvalUsage("const r = sandbox.\n\teval(code);\n", "src/x.ts")).toEqual([]);
	});

	it("N15: an untyped .js object method with an arrow default `eval(expr, resolve = (n) => n) {`", () => {
		const code = "const ops = {\n\teval(expr, resolve = (n) => n) {\n\t\treturn parse(expr, resolve);\n\t},\n};\n";
		expect(checkEvalUsage(code, "src/interp/ops.js")).toEqual([]);
	});

	it("N16: modifier-prefixed members `static async eval(...)` and `get eval()` with return types", () => {
		const code =
			"class V {\n\tstatic async eval(code: string): Promise<unknown> {\n\t\treturn run(code);\n\t}\n\tget eval(): Evaluator {\n\t\treturn this.e;\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/x.ts")).toEqual([]);
	});
});

describe("eval_usage — positive (must fire)", () => {
	it("P1: a one-line method named `eval` that calls the GLOBAL eval still fires", () => {
		const code = "class Shell {\n\teval(code: string) { return eval(code); }\n}\n";
		expect(checkEvalUsage(code, "src/x.ts")).toEqual([
			{ line: 2, text: "eval(code: string) { return eval(code); }" },
		]);
	});

	it("P2: a multi-line ternary branch `eval(x) :` is a real call and still fires", () => {
		expect(checkEvalUsage("const r = cond ?\n\teval(x) :\n\tfallback;\n", "src/x.ts")).toEqual([
			{ line: 2, text: "eval(x) :" },
		]);
	});

	it("P3: a bare `eval(x)` in a .tsx file still fires (JSX blanking does not over-reach)", () => {
		const code = "export function Run({ x }: { x: string }) {\n\tconst r = eval(x);\n\treturn <p>{r}</p>;\n}\n";
		expect(checkEvalUsage(code, "src/Run.tsx")).toEqual([{ line: 2, text: "const r = eval(x);" }]);
	});

	it("P4: `eval(a ? b : c)` is a call, not a typed parameter list", () => {
		expect(checkEvalUsage("const r = eval(a ? b : c);\n", "src/x.ts")).toHaveLength(1);
	});

	it("P5: a global eval call split across lines fires on the `eval(` line", () => {
		expect(checkEvalUsage("const r = eval(\n\tcode,\n);\n", "src/x.ts")).toEqual([
			{ line: 1, text: "const r = eval(" },
		]);
	});

	it("P6: `case eval(x):` is a call, not a return-type annotation", () => {
		expect(checkEvalUsage("switch (v) {\n\tcase eval(x):\n\t\tbreak;\n}\n", "src/x.ts")).toEqual([
			{ line: 2, text: "case eval(x):" },
		]);
	});

	it("P7: a global eval passed as an argument after a comma `f(a, eval(x))`", () => {
		expect(checkEvalUsage("f(a, eval(x));\n", "src/x.ts")).toHaveLength(1);
	});
});

// Round 3 (2026-10-22): the round-2 FPs not pinned above, plus members whose
// `eval(): T` signature follows a decorator, a generator `*` or a previous
// member with no semicolon. Probe: scratch/2026-10-21-round3/eval_usage.round3.probe.mts.
describe("eval_usage round 3 — negative (must not fire)", () => {
	it("N17: a method named `eval` whose LATER parameter is callback-typed", () => {
		const code =
			"class E {\n\teval(expr: string, resolve: (name: string) => Value): Value {\n\t\treturn walk(expr, resolve);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.ts")).toEqual([]);
	});

	it("N18: a typed .ts method whose default parameter value is a call `scope = new Scope()`", () => {
		const code = "class E {\n\teval(node: Node, scope = new Scope()) {\n\t\treturn walk(node, scope);\n\t}\n}\n";
		expect(checkEvalUsage(code, "src/interp/evaluator.ts")).toEqual([]);
	});

	it("N19: a semicolon-less interface — `eval(): void` after `run(): void` and after `onDone: () => void`", () => {
		expect(checkEvalUsage("export interface R {\n  run(): void\n  eval(): void\n}\n", "src/r.ts")).toEqual([]);
		expect(checkEvalUsage("interface I {\n  onDone: () => void\n  eval(): void\n}\n", "src/i.ts")).toEqual([]);
	});

	it("N20: a semicolon-less class field, then `eval(): number {`", () => {
		const code = "class C {\n  x = 1\n  eval(): number {\n    return this.x\n  }\n}\n";
		expect(checkEvalUsage(code, "src/c.ts")).toEqual([]);
	});

	it("N21: a semicolon-less member ending in a nested generic, then `eval(): Promise<Value>`", () => {
		const code = "interface E {\n  get(): Map<K, Array<V>>\n  eval(): Promise<Value>\n}\n";
		expect(checkEvalUsage(code, "src/e.ts")).toEqual([]);
	});

	it("N22: decorated methods — `@memo()` and `@cached` on their own line, `@HostListener(\"x\")` on the same line", () => {
		for (const deco of ["@memo()\n\t", "@cached\n\t", '@HostListener("x") ']) {
			const code = `class C {\n\t${deco}eval(): Value {\n\t\treturn this.v;\n\t}\n}\n`;
			expect(checkEvalUsage(code, "src/c.ts"), deco).toEqual([]);
		}
	});

	it("N23: generator methods `*eval(): Generator<V>` and `async *eval(): AsyncGenerator<V>`", () => {
		for (const sig of ["*eval(): Generator<V>", "async *eval(): AsyncGenerator<V>"]) {
			const code = `class A {\n\t${sig} {\n\t\tyield 1;\n\t}\n}\n`;
			expect(checkEvalUsage(code, "src/a.ts"), sig).toEqual([]);
		}
	});
});

describe("eval_usage round 3 — positive (must fire)", () => {
	it("P8: `eval(userInput)` on untrusted input fires", () => {
		const code = "export function run(userInput: string) {\n\treturn eval(userInput);\n}\n";
		expect(checkEvalUsage(code, "src/run.ts")).toEqual([{ line: 2, text: "return eval(userInput);" }]);
	});

	it("P9: `new Function(src)` (implied eval) fires", () => {
		const code = "export const make = (src: string) => new Function(src);\n";
		expect(checkEvalUsage(code, "src/run.ts")).toEqual([
			{ line: 1, text: "export const make = (src: string) => new Function(src);" },
		]);
	});

	it("P10: a ternary branch after a line-final `await` or `void` operator is a call", () => {
		for (const op of ["await", "void"]) {
			expect(checkEvalUsage(`const r = c ? ${op}\n\teval(x) : y;\n`, "src/x.ts"), op).toEqual([
				{ line: 2, text: "eval(x) : y;" },
			]);
		}
	});

	it("P11: `a *\\n eval(x) :` is a multiplication in a ternary branch, not a generator member", () => {
		expect(checkEvalUsage("const r = c ? a *\n\teval(x) : y;\n", "src/x.ts")).toEqual([
			{ line: 2, text: "eval(x) : y;" },
		]);
	});

	it("P12: a comparison `a >\\n eval(x) :` is not a generic close", () => {
		expect(checkEvalUsage("const r = c ? a >\n\teval(x) : y;\n", "src/x.ts")).toEqual([
			{ line: 2, text: "eval(x) : y;" },
		]);
	});
});
