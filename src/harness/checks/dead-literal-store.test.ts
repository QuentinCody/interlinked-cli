import { describe, expect, it } from "vitest";
import { findDeadLiteralStores } from "./dead-literal-store.js";

const lines = (content: string, path: string): number[] => findDeadLiteralStores(content, path).map(match => match.line);

describe("findDeadLiteralStores: JS/TS", () => {
	it("P1: a literal initializer overwritten by the next statement fires", () => {
		expect(lines("function f() {\n\tlet total = 0;\n\ttotal = compute();\n\treturn total;\n}\n", "a.ts")).toEqual([2]);
	});
	it("P2: a string initializer overwritten before any read fires", () => {
		expect(lines("function f(x: number) {\n\tlet label = \"\";\n\tlabel = x > 1 ? \"many\" : \"one\";\n\treturn label;\n}\n", "a.ts")).toEqual([2]);
	});
	it("P3: null initializer overwritten in a nested block fires once", () => {
		expect(lines("if (ok) {\n\tlet value = null;\n\tvalue = load();\n\tuse(value);\n}\n", "a.js")).toEqual([2]);
	});
	it("N1: an overwrite that reads the old value is not dead", () => {
		expect(lines("function f() {\n\tlet n = 0;\n\tn = n + 1;\n\treturn n;\n}\n", "a.ts")).toEqual([]);
	});
	it("N2: a statement between the two stores is not adjacent", () => {
		expect(lines("function f() {\n\tlet n = 0;\n\tlog(n);\n\tn = 1;\n\treturn n;\n}\n", "a.ts")).toEqual([]);
	});
	it("N3: a non-literal initializer and a different name do not fire", () => {
		expect(lines("function f() {\n\tlet a = make();\n\ta = 1;\n\tlet b = 0;\n\tc = 2;\n\treturn [a, b, c];\n}\n", "a.ts")).toEqual([]);
	});
	it("N4: an unparseable file or an unsupported extension reports nothing", () => {
		expect(lines("let x = 0;\nx = 1;\n", "a.rs")).toEqual([]);
	});
});

describe("findDeadLiteralStores: Python", () => {
	it("P1: a literal assignment overwritten by the next line fires", () => {
		expect(lines("def f(x):\n    result = None\n    result = compute(x)\n    return result\n", "a.py")).toEqual([2]);
	});
	it("P2: blank and comment lines between the two stores do not hide the pair", () => {
		expect(lines("def f(x):\n    count = 0\n\n    # recompute\n    count = len(x)\n    return count\n", "a.py")).toEqual([2]);
	});
	it("P3: a module-level pair fires", () => {
		expect(lines("MODE = \"fast\"\nMODE = load_mode()\n", "a.py")).toEqual([1]);
	});
	it("N1: an overwrite that reads the old value is not dead", () => {
		expect(lines("def f():\n    n = 0\n    n = n + 1\n    return n\n", "a.py")).toEqual([]);
	});
	it("N2: an annotated first store, an augmented store and a chained store do not fire", () => {
		expect(lines("def f():\n    a: int = 0\n    a = g()\n    b = 0\n    b += 1\n    c = 0\n    c = d = 2\n    return a, b, c, d\n", "a.py")).toEqual([]);
	});
	it("N3: lines inside a triple-quoted string do not fire", () => {
		expect(lines("TEXT = \"\"\"\nx = 0\nx = 1\n\"\"\"\n", "a.py")).toEqual([]);
	});
	it("N4: a different indent is another block", () => {
		expect(lines("def f(x):\n    n = 0\n    if x:\n        n = 1\n    return n\n", "a.py")).toEqual([]);
	});
});
