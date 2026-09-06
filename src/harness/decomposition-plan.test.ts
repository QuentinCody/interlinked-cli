// Evidence for the decomposition planner that the cyclomatic block message
// carries. "Fire" = the planner proposes at least one extraction. Every
// expected CC below is hand-derived from the canonical decision set
// (if / loop / case / catch / ?: / && / || / ??) — when a case and that set
// disagree, the set wins and the test is wrong. Also unit-tests `loopSubject`
// directly (exported for this purpose): its `undefined` fallback for a
// non-loop node is unreachable through `planDecomposition` itself, since every
// caller already gates on the identical `isLoop` node-kind check first.
import { describe, expect, it } from "vitest";
import type * as TS from "typescript";
import { type TsModule, computeCyclomaticAst, parseTsSource } from "./checks/cyclomatic-ast.js";
import {
	type DecompositionPlan,
	loopSubject,
	planDecomposition,
	planToMessage,
} from "./decomposition-plan.js";

/** CC 11: 1 + if(!raw) + if strict + if fallback + for + if startsWith +
 *  if typeof + && + else-if + case a + case b. */
const OVER_CAP = `
const DEFAULT = {};
export function loadConfig(raw: string, env: Env): Config {
  if (!raw) {
    if (env.strict) throw new Error("x");
    if (env.fallback) return env.fallback;
    return DEFAULT;
  }
  const parsed = JSON.parse(raw);
  for (const key of Object.keys(parsed)) {
    if (key.startsWith("_")) continue;
    if (typeof parsed[key] === "string" && parsed[key].length > 0) {
      parsed[key] = parsed[key].trim();
    } else if (Array.isArray(parsed[key])) {
      parsed[key] = parsed[key].filter(Boolean);
    }
  }
  switch (parsed.mode) {
    case "a": return withA(parsed);
    case "b": return withB(parsed);
    default: return parsed;
  }
}
`;

function planOf(code: string, name: string, cap: number): DecompositionPlan {
	const plan = planDecomposition(code, "fixture.ts", name, cap);
	if (plan === null) throw new Error("planner returned null (typescript dep missing?)");
	return plan;
}

/** First top-level statement of a fixture snippet, parsed with the same `typescript` load the planner uses. */
function firstStatement(code: string): { ts: TsModule; sf: TS.SourceFile; node: TS.Statement } {
	const parsed = parseTsSource(code, "fixture.ts");
	if (!parsed) throw new Error("typescript dep missing");
	const stmt = parsed.sf.statements[0];
	if (!stmt) throw new Error("fixture parsed with no statements");
	return { ts: parsed.ts, sf: parsed.sf, node: stmt };
}

describe("planDecomposition — positive (must fire)", () => {
	it("P1: one large loop extraction brings loadConfig from 11 under a cap of 6", () => {
		const plan = planOf(OVER_CAP, "loadConfig", 6);
		expect(plan.totalCc).toBe(11);
		expect(plan.extractions).toEqual([
			{
				kind: "loop",
				cc: 5,
				nesting: 0,
				startLine: 10,
				endLine: 17,
				suggestedName: "processObjectKeys",
			},
		]);
		expect(plan.remainingCc).toBe(6);
	});

	it("P2: a tighter cap descends into the loop body and picks three disjoint arms", () => {
		const plan = planOf(OVER_CAP, "loadConfig", 4);
		expect(plan.extractions.map((e) => [e.kind, e.cc, e.nesting])).toEqual([
			["if", 3, 0],
			["if", 3, 1],
			["case", 2, 0],
		]);
		expect(plan.extractions.map((e) => e.suggestedName)).toEqual([
			"handleMissingRaw",
			"handleParsedKey",
			"handleParsedMode",
		]);
		expect(plan.remainingCc).toBe(3);
		// Disjoint by construction: spans never overlap.
		const spans = plan.extractions.map((e) => [e.startLine, e.endLine]);
		expect(spans).toEqual([
			[4, 8],
			[12, 16],
			[18, 22],
		]);
	});

	it("P3: an if whose complexity lives in its condition yields predicate extractions", () => {
		const code = `
function tangled(a: number, b: number): number {
  let x = 0;
  if (a > 0 && b > 0 && a !== b && (a > b || b > a)) x = 1;
  if (a < 0 || b < 0 || a === b || (a < b && b < a)) x = 2;
  return x;
}`;
		// CC 11: 1 + (if + 3×&& + ||) + (if + 3×|| + &&). Each whole if is cc 5
		// (helper 6 > 5) so the planner descends to the condition (cc 4, helper 5).
		const plan = planOf(code, "tangled", 5);
		expect(plan.totalCc).toBe(11);
		expect(plan.extractions.map((e) => [e.kind, e.cc])).toEqual([
			["logical", 4],
			["logical", 4],
		]);
		expect(plan.extractions.every((e) => e.suggestedName.startsWith("is"))).toBe(true);
		expect(plan.remainingCc).toBe(3);
	});

	it("P11: a plan that cannot reach the cap still returns its best partial set", () => {
		const code = `
function partial(a: number, b: number, c: number, d: number, e: number): number {
  if (a > 0) return 1;
  if (a && b && c && d && e) return 2;
  return 0;
}`;
		// CC 7: 1 + if + (if + 4×&&). The 4-&& condition (helper 5) cannot fit a
		// cap of 3 and has no sub-arms, so only the small if is extractable.
		const plan = planOf(code, "partial", 3);
		expect(plan.extractions.map((e) => [e.kind, e.cc])).toEqual([["if", 1]]);
		expect(plan.remainingCc).toBe(6);
	});

	it("P4: try/catch arms are candidates with kind-specific names", () => {
		const code = `
async function sync(client: Client, items: Item[]): Promise<void> {
  try {
    const res = await client.push(items);
    if (res.status === 429 || res.status === 503) await backoff();
    if (res.status >= 500) throw new Error("server");
  } catch (err) {
    if (err instanceof NetworkError && err.retryable) await retry(items);
    if (err instanceof AuthError) await login(client);
  }
}`;
		// CC 8: 1 + catch + (if + ||) + if + (if + &&) + if. Extracting a catch
		// BODY leaves the `catch` keyword (its +1) with the parent.
		const plan = planOf(code, "sync", 4);
		expect(plan.extractions.map((e) => [e.kind, e.cc, e.suggestedName])).toEqual([
			["try", 3, "attemptClientPush"],
			["catch", 3, "handleClientPushError"],
		]);
		expect(plan.remainingCc).toBe(2);
	});

	it("P5: else arms and switch default cases get their own names", () => {
		const code = `
function route(req: Req): Res {
  if (req.user) {
    if (req.user.admin) return admin(req);
    if (req.user.banned) return banned(req);
  } else {
    if (req.token) return byToken(req);
    if (req.cookie) return byCookie(req);
  }
  switch (req.method) {
    case "GET": return req.cache ? cached(req) : fresh(req);
    default: return req.body ? withBody(req) : empty(req);
  }
}`;
		// CC 9: 1 + if user + 2 inner + 2 else-inner + case GET + ?: + ?: (default
		// is not a decision point; its ?: is). Whole if (cc 5) and switch (cc 3)
		// both exceed a cap-3 helper, so their arms are the candidates. A clause
		// arm is priced by its STATEMENTS — the `case` label's +1 cannot leave the
		// switch — so GET is cc 1, not 2, and greedy needs the default clause too.
		const plan = planOf(code, "route", 3);
		expect(plan.extractions.map((e) => [e.kind, e.cc, e.suggestedName])).toEqual([
			["if", 2, "handleReqUser"],
			["else", 2, "handleReqUserOtherwise"],
			["case", 1, "handleReqMethodGet"],
			["case", 1, "handleReqMethodDefault"],
		]);
		expect(plan.remainingCc).toBe(3);
	});

	it("P12: block arms span the owning keyword through the last statement, never sharing a line", () => {
		const code = `
function route(req: Req): Res {
  if (req.user) {
    if (req.user.admin) return admin(req);
    if (req.user.banned) return banned(req);
  } else {
    if (req.token) return byToken(req);
    if (req.cookie) return byCookie(req);
  }
  switch (req.method) {
    case "GET": return req.cache ? cached(req) : fresh(req);
    default: return req.body ? withBody(req) : empty(req);
  }
}`;
		// then-arm starts on the `if` line (3) and ends on its last statement (5);
		// the else-arm starts on the `} else {` line (6), not on line 5's `}`, and
		// ends on its last statement (8); each clause spans its `case` line.
		const plan = planOf(code, "route", 3);
		expect(plan.extractions.map((e) => [e.startLine, e.endLine])).toEqual([
			[3, 5],
			[6, 8],
			[11, 11],
			[12, 12],
		]);
	});

	it("P13: the plan's totalCc is exactly the gate's count, and case pricing leaves the label behind", () => {
		const code = `
function dispatch(kind: string, n: number): number {
  switch (kind) {
    case "a": return n > 0 && n < 9 ? 1 : 0;
    case "b": return n > 9 || n < -9 ? 2 : 0;
    default: return 0;
  }
}`;
		// Gate: 1 + case a + case b + (&& + ?:) + (|| + ?:) = 7. Each clause body
		// is cc 2 (helper 3 fits cap 3); extracting BOTH bodies removes 4, leaving
		// the two `case` labels with the switch: 7 − 4 = 3, which is what
		// computeCyclomaticAst measures on the decomposed function.
		const gate = computeCyclomaticAst(code, "fixture.ts")?.find((e) => e.name === "dispatch");
		const plan = planOf(code, "dispatch", 3);
		expect(plan.totalCc).toBe(gate?.cyclomatic);
		expect(plan.extractions.map((e) => [e.kind, e.cc])).toEqual([
			["case", 2],
			["case", 2],
		]);
		expect(plan.remainingCc).toBe(3);
		const decomposed = `
function dispatch(kind: string, n: number): number {
  switch (kind) {
    case "a": return handleKindA(n);
    case "b": return handleKindB(n);
    default: return 0;
  }
}`;
		const after = computeCyclomaticAst(decomposed, "fixture.ts")?.find((e) => e.name === "dispatch");
		expect(after?.cyclomatic).toBe(plan.remainingCc);
	});

	it("P6: duplicate suggested names are made unique", () => {
		const code = `
function thrice(val: number): number {
  if (val > 1 && val < 5) return 1;
  if (val > 10 && val < 50) return 2;
  if (val > 100 && val < 500) return 3;
  return 0;
}`;
		// CC 7; each if is cc 2 (helper 3 fits cap 3); two extractions reach 3.
		const plan = planOf(code, "thrice", 3);
		const names = plan.extractions.map((e) => e.suggestedName);
		expect(names).toEqual(["handleVal", "handleVal2"]);
	});

	it("P7: same-named functions resolve to the one with the highest CC", () => {
		const code = `
const a = { run(v: number) { return v > 0 ? 1 : 0; } };
const b = { run(v: number) { if (v > 0 && v < 3) return 1; if (v > 9 || v < -9) return 2; return 0; } };`;
		const plan = planOf(code, "run", 3);
		expect(plan.totalCc).toBe(5);
		expect(plan.extractions.length).toBeGreaterThan(0);
	});
});

describe("loopSubject — the condition/expression each loop kind carries", () => {
	it("returns the for-statement's condition, not its init or update", () => {
		const { ts, sf, node } = firstStatement("for (let i = 0; i < 3; i++) { y(); }");
		// SAFETY: fixture's first (and only) statement is a for-loop by construction.
		const forNode = node as TS.ForStatement;
		expect(loopSubject(ts, forNode)?.getText(sf)).toBe("i < 3");
	});

	it("returns undefined for a node that is not a loop, since every caller pre-filters with isLoop", () => {
		const { ts, node } = firstStatement("if (x) { y(); }");
		expect(loopSubject(ts, node)).toBe(undefined);
	});
});

describe("planDecomposition — loop, case-label, leaf, and finally naming", () => {
	it("a plain for-loop and a while-loop are named from their own condition identifiers", () => {
		const code = `
function poll(budget: number, retries: number, flag: boolean): number {
  if (budget > 0) retries += 1;
  for (let i = 0; i < retries; i++) {
    retries -= 1;
  }
  while (budget > 0) {
    budget -= 1;
  }
  if (flag) retries += 1;
  return retries;
}`;
		// CC 5: 1 + if1 + for + while + if2. Every top-level statement is its own
		// cc-1 candidate (helper cc 2 fits cap 2); greedy picks the first three in
		// source order to bring 5 under the cap of 2, which is if1, for, while.
		const plan = planOf(code, "poll", 2);
		expect(plan.extractions.map((e) => [e.kind, e.suggestedName, e.startLine, e.endLine])).toEqual([
			["if", "handleBudget", 3, 3],
			["loop", "processRetries", 4, 6],
			["loop", "processBudget", 7, 9],
		]);
	});

	it("a non-literal case label (an identifier, not a string/number) is named from its own identifier", () => {
		const code = `
function dispatch(kind: string, n: number): number {
  switch (kind) {
    case KIND_KEY: return n > 0 && n < 9 ? 1 : 0;
    case "b": return n > 9 || n < -9 ? 2 : 0;
    default: return 0;
  }
}`;
		// Same shape as the string-label case (CC 7, clause body cc 2 fits cap 3);
		// only the label text differs, exercising the identifier-fallback branch
		// of caseLabel instead of its string/numeric-literal branch.
		const plan = planOf(code, "dispatch", 3);
		expect(plan.extractions.map((e) => e.suggestedName)).toEqual(["handleKindKINDKEY", "handleKindB"]);
	});

	it("a leaf expression-statement (not a variable or return) is named 'apply<Idents>Step'", () => {
		const code = `
function process(mode: number, extra: number, flag: boolean): number {
  if (extra > 0) mode += 1;
  report(mode ? 1 : 0);
  if (flag) mode += 2;
  return mode;
}`;
		// CC 4: 1 + if1 + ternary + if2, each cc 1 (helper cc 2 fits cap 2).
		// Greedy needs two arms to bring 4 under 2: if1, then the call statement —
		// which is neither a VariableStatement nor a ReturnStatement, so
		// describeLeaf falls through to its "apply" branch.
		const plan = planOf(code, "process", 2);
		expect(plan.extractions.map((e) => [e.kind, e.suggestedName, e.startLine, e.endLine])).toEqual([
			["if", "handleExtra", 3, 3],
			["logical", "applyReportMode", 4, 4],
		]);
	});

	it("a finally block with its own decision becomes a named candidate distinct from the try block", () => {
		const code = `
function guarded(conn: Connection, mode: number, retries: number): number {
  try {
    if (mode > 0 && conn.ready) conn.open();
  } finally {
    if (retries > 0) conn.close();
  }
  return retries;
}`;
		// CC 4: 1 + (ifTry + &&) + ifFinally. The whole try-statement (cc 3) is too
		// big for a cap-2 helper (cc+1=4), so it splits into its arms; the
		// try-block arm (cc 2) is STILL too big and splits again down to its
		// condition (cc 1, "is..."), while the finally arm (cc 1) fits directly
		// and is named from tryNames().cleanup — independent of, and disjoint
		// from, the try-block's own condition extraction.
		const plan = planOf(code, "guarded", 2);
		expect(plan.extractions.map((e) => [e.kind, e.suggestedName, e.cc, e.nesting])).toEqual([
			["logical", "isModeConn", 1, 1],
			["finally", "cleanupConnOpen", 1, 0],
		]);
		expect(plan.remainingCc).toBe(2);
	});

	it("an arrow function with an expression body (no braces) becomes one named 'logical' candidate", () => {
		// CC 3, but the decision that pushes `rate` over the cap lives in the
		// DEFAULT PARAMETER (`a = x ?? 1`), not the body — so the body itself
		// (`b > 0 ? 1 : 0`, cc 1) fits a cap-2 helper on its own. The body is an
		// Expression, not a Block, so bodyArms wraps it as the single non-Block
		// arm (`{node: body, label: {kind: "logical", name: "computeResult"},
		// deepens: false}`) instead of recursing into statementArms; that arm is
		// then the one and only candidate collect() finds.
		const code = "const rate = (a = x ?? 1, b: number): number => (b > 0 ? 1 : 0);";
		const plan = planOf(code, "rate", 2);
		expect(plan.totalCc).toBe(3);
		expect(plan.extractions).toEqual([
			{ startLine: 1, endLine: 1, cc: 1, nesting: 0, kind: "logical", suggestedName: "computeResult" },
		]);
		expect(plan.remainingCc).toBe(2);
	});

	it("an arrow function whose whole body is one over-cap arm is left unsplittable", () => {
		const code = "const rate = (a: number, b: number): number => (a > 0 && b > 0 ? 1 : 0);";
		// CC 3: 1 + && + ?:, all inside the single non-Block body arm. That arm's
		// own cc (3) is too big to fit as a cap-2 helper (cc + 1 > cap), and
		// armsOf returns [] for a plain expression node (nothing to recurse
		// into), so collect() finds no candidate at all: extractions stays empty
		// and the full complexity remains on the caller.
		const plan = planOf(code, "rate", 2);
		expect(plan.totalCc).toBe(3);
		expect(plan.extractions).toEqual([]);
		expect(plan.remainingCc).toBe(3);
	});
});

describe("planDecomposition — negative (must not fire)", () => {
	it("N1: a function already at or under the cap proposes nothing", () => {
		const plan = planOf(OVER_CAP, "loadConfig", 11);
		expect(plan.extractions).toEqual([]);
		expect(plan.remainingCc).toBe(11);
	});

	it("N2: an unknown function name yields null", () => {
		expect(planDecomposition(OVER_CAP, "fixture.ts", "nope", 3)).toBeNull();
	});

	it("N3: a non-JS/TS path yields null without parsing", () => {
		expect(planDecomposition("def f():\n  pass\n", "fixture.py", "f", 3)).toBeNull();
	});

	it("N4: complexity that lives in a nested callback is not the parent's to extract", () => {
		const code = `
function outer(xs: number[]): number[] {
  return xs.map((x) => (x > 0 && x < 9 ? x : x > 100 || x < -100 ? 0 : 1));
}`;
		const plan = planOf(code, "outer", 1);
		expect(plan.totalCc).toBe(1);
		expect(plan.extractions).toEqual([]);
	});

	it("N5: a decision-free statement is never a candidate", () => {
		const code = `
function simple(a: number): number {
  const b = a * 2;
  const c = b + 1;
  if (c > 3) return c;
  if (b > 3) return b;
  return b;
}`;
		// CC 3 against a cap of 2: one `if` (cc 1) goes; the two decision-free
		// `const` statements are never proposed.
		const plan = planOf(code, "simple", 2);
		expect(plan.extractions.map((e) => e.kind)).toEqual(["if"]);
	});
});

describe("planToMessage", () => {
	it("P8: renders one line per extraction plus the remaining CC, capped at three lines", () => {
		const msg = planToMessage(planOf(OVER_CAP, "loadConfig", 4));
		const lines = msg.split("\n");
		expect(lines.length).toBeLessThanOrEqual(3);
		expect(lines[0]).toBe("extract lines 4–8 (CC 3, nesting 0) → handleMissingRaw");
		expect(lines[1]).toBe("lines 12–16 (CC 3, nesting 1) → handleParsedKey");
		expect(lines[2]).toBe("lines 18–22 (CC 2, nesting 0) → handleParsedMode; remaining CC 3");
	});

	it("P9: a single extraction is one line", () => {
		const msg = planToMessage(planOf(OVER_CAP, "loadConfig", 6));
		expect(msg).toBe(
			"extract lines 10–17 (CC 5, nesting 0) → processObjectKeys; remaining CC 6",
		);
	});

	it("P10: a partial plan says the remainder is still over the cap", () => {
		const plan: DecompositionPlan = {
			functionName: "f",
			targetCap: 5,
			totalCc: 30,
			remainingCc: 9,
			extractions: [
				{ startLine: 1, endLine: 2, cc: 3, nesting: 0, kind: "if", suggestedName: "handleA" },
				{ startLine: 3, endLine: 4, cc: 3, nesting: 0, kind: "if", suggestedName: "handleB" },
				{ startLine: 5, endLine: 6, cc: 3, nesting: 0, kind: "if", suggestedName: "handleC" },
				{ startLine: 7, endLine: 8, cc: 3, nesting: 0, kind: "if", suggestedName: "handleD" },
			],
		};
		const msg = planToMessage(plan);
		expect(msg.split("\n")).toHaveLength(3);
		expect(msg).toContain("+1 more");
		expect(msg).toContain("remaining CC 9 (still over 5 — re-plan after extracting)");
	});

	it("N6: an empty plan says so instead of inventing an extraction", () => {
		const msg = planToMessage(planOf(OVER_CAP, "loadConfig", 11));
		expect(msg).toBe("no extractable branch found in loadConfig (CC 11); split its top-level statements by hand");
	});
});
