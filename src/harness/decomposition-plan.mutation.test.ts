// Mutation-hardening evidence for decomposition-plan.ts. Each test pins one
// behavior that a single-token mutant of the module changed without failing
// decomposition-plan.test.ts. Names, spans and kinds asserted here follow the
// module's own doc comments: helper names come from the condition's
// identifiers (identifiersOf: >1 char, stoplist, outside nested functions,
// distinct), a span is "the owning keyword's line through the arm's last
// STATEMENT" (toCandidate), `loopSubject` returns each loop kind's
// condition/expression, and equal-CC functions of one name resolve to the
// first in source (findFunction: "ties -> first in source").
import { describe, expect, it } from "vitest";
import type * as TS from "typescript";
import { type TsModule, parseTsSource } from "./checks/cyclomatic-ast.js";
import { type DecompositionPlan, loopSubject, planDecomposition } from "./decomposition-plan.js";

function planOf(code: string, name: string, cap: number, path = "fixture.ts"): DecompositionPlan {
	const plan = planDecomposition(code, path, name, cap);
	if (plan === null) throw new Error("planner returned null (typescript dep missing?)");
	return plan;
}

function firstStatement(code: string): { ts: TsModule; sf: TS.SourceFile; node: TS.Statement } {
	const parsed = parseTsSource(code, "fixture.ts");
	if (!parsed) throw new Error("typescript dep missing");
	const stmt = parsed.sf.statements[0];
	if (!stmt) throw new Error("fixture parsed with no statements");
	return { ts: parsed.ts, sf: parsed.sf, node: stmt };
}

/** CC 3, cap 2: the first `if` (cc 1) is the extraction; its name comes from `cond`. */
function firstIfName(cond: string): string | undefined {
	const code = `
function f(alpha: any, beta: any, xv: any, other: any, go: any, zeta: any) {
  if (${cond}) return 1;
  if (other) return 2;
  return 0;
}`;
	return planOf(code, "f", 2).extractions[0]?.suggestedName;
}

/** 1-based line of the first line containing `needle`. */
function lineOf(code: string, needle: string): number {
	const idx = code.split("\n").findIndex((l) => l.includes(needle));
	if (idx < 0) throw new Error(`fixture has no line with ${needle}`);
	return idx + 1;
}

describe("helper names from condition identifiers", () => {
	it("keeps a two-character identifier (only single characters are dropped)", () => {
		expect(firstIfName("id")).toBe("handleId");
	});

	it("leaves `undefined` out of the name (stoplisted, carries no meaning)", () => {
		expect(firstIfName("alpha !== undefined")).toBe("handleAlpha");
	});

	it("does not read identifiers inside a nested function", () => {
		expect(firstIfName("go(() => zeta)")).toBe("handleGo");
	});
});

describe("missing-check names", () => {
	it("`x === undefined` is a missing check", () => {
		expect(firstIfName("alpha === undefined")).toBe("handleMissingAlpha");
	});

	it("`x == null` is a missing check", () => {
		expect(firstIfName("alpha == null")).toBe("handleMissingAlpha");
	});

	it("`x === null` is a missing check", () => {
		expect(firstIfName("alpha === null")).toBe("handleMissingAlpha");
	});

	it("an equality between two real operands is not a missing check", () => {
		expect(firstIfName("alpha === beta")).toBe("handleAlphaBeta");
	});
});

describe("loopSubject for every loop kind", () => {
	it("for-in yields the iterated expression", () => {
		const { ts, sf, node } = firstStatement("for (const k in obj) { y(); }");
		expect(loopSubject(ts, node)?.getText(sf)).toBe("obj");
	});

	it("for-of yields the iterated expression", () => {
		const { ts, sf, node } = firstStatement("for (const k of list) { y(); }");
		expect(loopSubject(ts, node)?.getText(sf)).toBe("list");
	});

	it("do-while yields its loop condition", () => {
		const { ts, sf, node } = firstStatement("do { y(); } while (cond);");
		expect(loopSubject(ts, node)?.getText(sf)).toBe("cond");
	});
});

describe("case-clause names", () => {
	const dispatch = (first: string, second: string): string => `
function dispatch(kind: any, n: number): number {
  switch (kind) {
    case ${first}: return n > 0 && n < 9 ? 1 : 0;
    case ${second}: return n > 9 || n < -9 ? 2 : 0;
    default: return 0;
  }
}`;

	it("a numeric label names the helper after the number", () => {
		const plan = planOf(dispatch("1", "2"), "dispatch", 3);
		expect(plan.extractions.map((e) => e.suggestedName)).toEqual(["handleKind1", "handleKind2"]);
	});

	it("a string label with no letters or digits falls back to 'Case'", () => {
		const plan = planOf(dispatch('"-"', '"b"'), "dispatch", 3);
		expect(plan.extractions.map((e) => e.suggestedName)).toEqual(["handleKindCase", "handleKindB"]);
	});

	it("a non-literal label uses only its first identifier", () => {
		const plan = planOf(dispatch("Kinds.Alpha", "Kinds.Beta"), "dispatch", 3);
		expect(plan.extractions.map((e) => e.suggestedName)).toEqual(["handleKindKinds", "handleKindKinds2"]);
	});
});

describe("whole-statement arm labels", () => {
	const TRY_FIRST = `
function f(flag: boolean) {
  try {
    const cb = () => inner();
    outer();
  } catch (err) {
    log(err);
  }
  if (flag) retry();
  return 0;
}`;

	it("a try statement that fits as a helper is kind 'try'", () => {
		const plan = planOf(TRY_FIRST, "f", 2);
		expect(plan.extractions[0]?.kind).toBe("try");
	});

	it("a try helper is named after the first call outside nested functions", () => {
		const plan = planOf(TRY_FIRST, "f", 2);
		expect(plan.extractions[0]?.suggestedName).toBe("attemptOuter");
	});

	it("a variable statement is named after its first declared identifier only", () => {
		const code = `
function f(c1: boolean, c2: boolean) {
  const { aa, bb } = c1 ? one() : two();
  const zz = c2 ? 3 : 4;
  return aa + bb + zz;
}`;
		const plan = planOf(code, "f", 2);
		expect(plan.extractions.map((e) => [e.kind, e.suggestedName])).toEqual([["logical", "computeAa"]]);
	});

	it("a return statement is named 'resolve...' from its expression", () => {
		const code = `
function f(flag: boolean, ready: boolean, ok: boolean) {
  if (flag) log();
  return ready && ok ? one() : two();
}`;
		const plan = planOf(code, "f", 3);
		expect(plan.extractions.map((e) => [e.kind, e.suggestedName, e.cc])).toEqual([
			["logical", "resolveReadyOk", 2],
		]);
	});
});

describe("planDecomposition edge behavior", () => {
	it("a loop with no condition (for(;;)) is still split into its body arms", () => {
		const code = `
function spin(a: boolean, b: boolean, c: boolean) {
  for (;;) {
    if (a) break;
    if (b) continue;
    if (c) return;
  }
}`;
		const plan = planOf(code, "spin", 3);
		expect(plan.totalCc).toBe(5);
		expect(plan.extractions.map((e) => e.kind)).toEqual(["if", "if"]);
		expect(plan.remainingCc).toBe(3);
	});

	it("equal-CC functions of one name resolve to the first in source", () => {
		const code = `
const a = { run(v: number) { if (v > 0) return 1; if (v > 9) return 2; return 0; } };
const b = { run(v: number) { if (v < 0) return 1; if (v < -9) return 2; return 0; } };`;
		const plan = planOf(code, "run", 2);
		expect(plan.extractions.map((e) => e.startLine)).toEqual([2]);
	});

	it("a path that is not JS/TS yields null even when the content parses as TypeScript", () => {
		const code = "function f(a: number) { if (a) return 1; if (a > 2) return 2; return 0; }";
		expect(planDecomposition(code, "fixture.txt", "f", 2)).toBeNull();
	});
});

describe("arm spans", () => {
	it("a finally arm starts on the `finally` keyword line, not on its brace line", () => {
		const code = `
function g(conn: any, mode: number, retries: number): number {
  try
  {
    if (mode > 0 && conn.ready) conn.open();
  }
  finally
  {
    if (retries > 0) conn.close();
  }
  return retries;
}`;
		const plan = planOf(code, "g", 2);
		const fin = plan.extractions.find((e) => e.kind === "finally");
		expect(fin?.startLine).toBe(lineOf(code, "finally"));
		expect(fin?.endLine).toBe(lineOf(code, "conn.close"));
	});

	it("a catch arm starts on the `catch` keyword line, not on its brace line", () => {
		const code = `
function g(client: any, retries: number, mode: boolean) {
  try { client.push(); }
  catch (err)
  {
    if (retries > 0 && mode) client.retry();
    if (retries > 1) client.stop();
  }
}`;
		const plan = planOf(code, "g", 4);
		const cat = plan.extractions.find((e) => e.kind === "catch");
		expect(cat?.startLine).toBe(lineOf(code, "catch (err)"));
		expect(cat?.endLine).toBe(lineOf(code, "client.stop"));
	});

	it("a block arm ends on the last line of its final multi-line statement", () => {
		const code = `
function h(a: boolean, b: boolean, c: boolean) {
  if (a) {
    if (b) {
      one();
    }
    if (c) {
      two();
    }
  }
}`;
		const plan = planOf(code, "h", 3);
		expect(plan.extractions.map((e) => [e.kind, e.startLine, e.endLine])).toEqual([
			["if", lineOf(code, "if (a)"), lineOf(code, "two();") + 1],
		]);
	});
});
