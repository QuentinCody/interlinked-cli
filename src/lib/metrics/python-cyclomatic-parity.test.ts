import { describe, expect, it } from "vitest";
import { computeCyclomaticPython, radonAvailable } from "../../harness/checks/cyclomatic-python.js";
import { hashBytes } from "./inventory.js";
import { measurePythonFiles, pythonAvailable } from "./python-measure.js";

/**
 * The score adapter counts like the TypeScript score (`isDecisionPoint`: if, loops, non-default case, catch, ternary,
 * and/or; `else` branches add nothing; a nested function or lambda is its own entry). The per-edit gate shells to radon,
 * which counts differently in the cases below. This table pins every known difference so a change on either side is
 * seen, and so the gate is never silently read as the score. Each source holds one function starting on line 1.
 */
const CASES: { name: string; source: string; score: number; radon: number; why: string }[] = [
	{ name: "if/elif/else", source: "def f(a):\n    if a:\n        return 1\n    elif a > 2:\n        return 2\n    else:\n        return 3\n", score: 3, radon: 3, why: "agree" },
	{ name: "boolean operators", source: "def f(a, b, c):\n    return a and b and c or a\n", score: 4, radon: 4, why: "agree: n operands add n-1" },
	{ name: "comprehension with filters", source: "def f(a):\n    return [x for x in a if x if x > 1]\n", score: 4, radon: 4, why: "agree" },
	{ name: "assert", source: "def f(a):\n    assert a\n", score: 2, radon: 2, why: "agree (TypeScript has no assert statement)" },
	{ name: "with", source: "def f(a):\n    with a as b:\n        pass\n", score: 1, radon: 1, why: "agree" },
	{ name: "loop else", source: "def f(a):\n    for i in a:\n        pass\n    else:\n        pass\n", score: 2, radon: 3, why: "radon adds one for a loop else; TypeScript counts no else" },
	{ name: "try else", source: "def f(a):\n    try:\n        pass\n    except ValueError:\n        pass\n    else:\n        pass\n", score: 2, radon: 3, why: "radon adds one for a try else; TypeScript counts only catch" },
	{ name: "lambda", source: "def f(a):\n    g = lambda x: x if x else 0\n    return g(a)\n", score: 1, radon: 2, why: "radon folds a lambda into its parent; TypeScript and the score give an arrow function its own entry" },
	{ name: "match guard", source: "def f(a):\n    match a:\n        case 1:\n            return 1\n        case 2 if a > 0:\n            return 2\n        case _:\n            return 3\n", score: 4, radon: 3, why: "the score counts a guard like and; radon ignores it, so the gate undercounts here" },
	{ name: "except star", source: "def f(a):\n    try:\n        pass\n    except* ValueError:\n        pass\n", score: 2, radon: 1, why: "radon does not read except* handlers, so the gate undercounts here" },
];

describe.skipIf(!pythonAvailable() || !radonAvailable())("Python cyclomatic: score adapter versus the per-edit radon gate", () => {
	it.each(CASES)("$name: $why", ({ source, score, radon }) => {
		const [row] = measurePythonFiles([{ path: "m.py", content: source, language: "python", role: "product", sha256: hashBytes(source) }]);
		if (!row || "error" in row) throw new Error("score analyzer failed");
		expect(row.functions.map(fn => fn.cyclomatic)).toEqual([score]);
		expect(computeCyclomaticPython(source, "m.py")?.map(fn => fn.cyclomatic)).toEqual([radon]);
	});
});
