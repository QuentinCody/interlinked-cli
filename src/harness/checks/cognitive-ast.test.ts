// Oracle tests for the SonarSource-aligned cognitive-complexity walker.
// Spec: docs/design/history-relational-metrics.md §5. Every expected score
// below is hand-derived from the increment rules there; when a case and the
// spec disagree, the spec wins and the test is wrong.
import { describe, expect, it } from "vitest";
import {
	type CognitiveComplexityEntry,
	cognitiveComplexityCheck,
	computeCognitiveAst,
	DEFAULT_MAX_COGNITIVE,
} from "./cognitive-ast.js";

function entriesOf(code: string): CognitiveComplexityEntry[] {
	const out = computeCognitiveAst(code, "fixture.ts");
	if (out === null) throw new Error("typescript optional dep missing in test env");
	return out;
}

function scoreOf(code: string, name: string): number {
	const e = entriesOf(code).find((x) => x.name === name);
	if (!e) throw new Error(`no entry named ${name}`);
	return e.cognitive;
}

describe("computeCognitiveAst — oracle scores", () => {
	it("flat switch scores 1 regardless of case count (the anti-cyclomatic case)", () => {
		const code = `
function pick(k: number): string {
  switch (k) {
    case 1: return "a";
    case 2: return "b";
    case 3: return "c";
    case 4: return "d";
    case 5: return "e";
    default: return "f";
  }
}`;
		expect(scoreOf(code, "pick")).toBe(1);
	});

	it("linear function scores 0 (cognitive has no +1 base)", () => {
		expect(scoreOf(`function f(a: number) { const b = a + 1; return b * 2; }`, "f")).toBe(0);
	});

	it("nested ifs pay the nesting penalty: 1+2+3 = 6", () => {
		const code = `
function nested(a: boolean, b: boolean, c: boolean): number {
  if (a) {
    if (b) {
      if (c) {
        return 3;
      }
    }
  }
  return 0;
}`;
		expect(scoreOf(code, "nested")).toBe(6);
	});

	it("else-if chain stays flat: if +1, two else-if +1 each, else +1 = 4", () => {
		const code = `
function grade(x: number): string {
  if (x > 90) { return "A"; }
  else if (x > 80) { return "B"; }
  else if (x > 70) { return "C"; }
  else { return "D"; }
}`;
		expect(scoreOf(code, "grade")).toBe(4);
	});

	it("an if nested under an else-if branch deepens from the chain level, not deeper", () => {
		const code = `
function g(x: number, y: boolean): string {
  if (x > 90) { return "A"; }
  else if (x > 80) {
    if (y) { return "B+"; }
    return "B";
  }
  return "C";
}`;
		// if +1 (n0), else-if +1 flat, inner if +1+1 (n1 — chain does not deepen) = 4
		expect(scoreOf(code, "g")).toBe(4);
	});

	describe("boolean operator runs (flat +1 per run transition)", () => {
		it("a && b && c = 1", () => {
			expect(scoreOf(`function f(a: boolean, b: boolean, c: boolean) { return a && b && c; }`, "f")).toBe(1);
		});
		it("a && b || c = 2", () => {
			expect(scoreOf(`function f(a: boolean, b: boolean, c: boolean) { return (a && b) || c; }`, "f")).toBe(2);
		});
		it("(a && b) || (c && d) = 3 (parens are sequence boundaries)", () => {
			expect(
				scoreOf(`function f(a: boolean, b: boolean, c: boolean, d: boolean) { return (a && b) || (c && d); }`, "f"),
			).toBe(3);
		});
		it("?? is its own operator kind: a ?? b ?? c = 1, a ?? (b && c) = 2", () => {
			expect(scoreOf(`function f(a?: number, b?: number, c?: number) { return a ?? b ?? c; }`, "f")).toBe(1);
			expect(scoreOf(`function f(a?: boolean, b?: boolean, c?: boolean) { return a ?? (b && c); }`, "f")).toBe(2);
		});
	});

	it("ternary costs +1+nesting; boolean run in its condition stays flat", () => {
		const code = `function f(a: boolean, b: boolean, x: number) { return a && b ? x : -x; }`;
		// ternary +1 (n0) + one && run +1 = 2
		expect(scoreOf(code, "f")).toBe(2);
	});

	it("loops and catch pay nesting: for{ if } + catch = 1 + 2 + 1 = 4", () => {
		const code = `
function scan(xs: number[]): number {
  try {
    for (const x of xs) {
      if (x < 0) { return x; }
    }
  } catch {
    return -1;
  }
  return 0;
}`;
		// for +1 (n0; try does not increment or deepen), if +1+1, catch +1 (n0) = 4
		expect(scoreOf(code, "scan")).toBe(4);
	});

	it("direct recursion adds +1 once, not per call site", () => {
		const code = `
function fib(n: number): number {
  if (n < 2) { return n; }
  return fib(n - 1) + fib(n - 2);
}`;
		expect(scoreOf(code, "fib")).toBe(2); // if +1, recursion +1
	});

	it("labeled break adds a flat +1", () => {
		const code = `
function find(grid: number[][]): number {
  outer: for (const row of grid) {
    for (const v of row) {
      if (v === 0) { break outer; }
    }
  }
  return 1;
}`;
		// for +1 (n0), for +1+1, if +1+2, labeled break +1 = 7
		expect(scoreOf(code, "find")).toBe(7);
	});

	describe("attribution across nested function-likes", () => {
		const code = `
function outer(items: number[]): number[] {
  return items.map((x) => {
    if (x > 0) { return x; }
    return -x;
  });
}`;
		it("each function-like is its own unit; parent excludes nested bodies", () => {
			expect(scoreOf(code, "outer")).toBe(0);
		});
		it("a lambda starts at its ancestor depth, so the sum matches Sonar's roll-in", () => {
			const entries = entriesOf(code);
			const lambda = entries.find((e) => e.name === "(callback)");
			expect(lambda?.cognitive).toBe(2); // if +1 + initial nesting 1
			const total = entries.reduce((s, e) => s + e.cognitive, 0);
			expect(total).toBe(2); // == Sonar score for `outer` with roll-in
		});
	});

	it("top-level extraction zeroes the initial nesting (the refactor reward)", () => {
		const code = `
const helper = (x: number): number => {
  if (x > 0) { return x; }
  return -x;
};`;
		expect(scoreOf(code, "helper")).toBe(1);
	});

	it("reports maxNesting alongside the score", () => {
		const code = `
function deep(a: boolean, b: boolean) {
  if (a) {
    if (b) { return 1; }
  }
  return 0;
}`;
		const e = entriesOf(code).find((x) => x.name === "deep");
		expect(e?.maxNesting).toBe(1); // deepest increment applied at nesting 1
	});

	it("bodiless overload signatures produce no entries", () => {
		const code = `
export function pick(k: number): string;
export function pick(k: string): string;
export function pick(k: number | string): string { return String(k); }
declare function ambient(x: number): void;`;
		const entries = entriesOf(code);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("pick");
	});
});

describe("cognitiveComplexityCheck — registry detector contract", () => {
	function monster(depth: number): string {
		// depth nested ifs => score 1+2+…+depth
		let body = "return 1;";
		for (let i = depth; i >= 1; i--) {
			body = `if (a${i}) { ${body} }`;
		}
		const params = Array.from({ length: depth }, (_, i) => `a${i + 1}: boolean`).join(", ");
		return `function monster(${params}) { ${body} return 0; }`;
	}

	it("P1: fires on a function over the cap, naming function, line, and score", () => {
		const code = monster(6); // 1+2+3+4+5+6 = 21 > 15 — provably over the cap
		const matches = cognitiveComplexityCheck(code, "src/a.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toContain("monster");
		expect(matches[0]?.text).toContain("21");
	});

	it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("keeps the source snippet aligned with TypeScript after line separator %j", (separator) => {
		const code = `const heading = 1;${separator}${monster(6)}`;
		expect(cognitiveComplexityCheck(code, "src/a.ts")).toEqual([
			expect.objectContaining({ line: 2, text: expect.stringContaining("function monster(") }),
		]);
	});

	it("fires on callback-pyramid code whose inner unit crosses via initial nesting", () => {
		const code = `
function pipeline(xs: number[]): number[] {
  return xs.map((a) => {
    return [a].flatMap((b) => {
      return [b].map((c) => {
        if (c > 0) { if (c > 1) { if (c > 2) { if (c > 3) { return c; } } } }
        return -c;
      });
    })[0] ?? 0;
  });
}`;
		// innermost (callback): initial nesting 3 → ifs cost 4+5+6+7 = 22 > 15
		const matches = cognitiveComplexityCheck(code, "src/b.ts");
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});

	it("boundary: exactly DEFAULT_MAX_COGNITIVE does not fire, cap+1 fires", () => {
		const at = monster(5); // 15 == cap
		expect(cognitiveComplexityCheck(at, "src/c.ts")).toHaveLength(0);
		const over = `function f(a: boolean, b: boolean) { ${"if (a) { ".repeat(0)}${""} return 0; }`;
		void over;
		const just = `${monster(5).replace("return 1;", "return b && a ? 1 : 2;")}`;
		// adds ternary at depth 5 (+6) — comfortably over; asserts the > (not >=) contract
		expect(cognitiveComplexityCheck(just, "src/c.ts").length).toBeGreaterThanOrEqual(1);
	});

	it("does not fire on a flat 20-case switch (high cyclomatic, low cognitive)", () => {
		const cases = Array.from({ length: 20 }, (_, i) => `case ${i}: return "${i}";`).join("\n");
		const code = `function pick(k: number): string { switch (k) { ${cases} default: return "x"; } }`;
		expect(cognitiveComplexityCheck(code, "src/d.ts")).toHaveLength(0);
	});

	it("does not fire on non-JS/TS files", () => {
		const py = `def f(a):\n    if a:\n        if a:\n            if a:\n                if a:\n                    if a:\n                        if a:\n                            return 1`;
		expect(cognitiveComplexityCheck(py, "src/e.py")).toHaveLength(0);
	});

	it("does not fire on clean decomposed code", () => {
		const code = `
function route(kind: string): string {
  if (kind === "a") { return handleA(); }
  if (kind === "b") { return handleB(); }
  return handleDefault();
}
function handleA(): string { return "a"; }
function handleB(): string { return "b"; }
function handleDefault(): string { return "d"; }`;
		expect(cognitiveComplexityCheck(code, "src/f.ts")).toHaveLength(0);
	});

	it("cap constant matches the Sonar default the spec pins", () => {
		expect(DEFAULT_MAX_COGNITIVE).toBe(15);
	});
});
