// Evidence for the decomposition planner that the cyclomatic block message
// carries. "Fire" = the planner proposes at least one extraction. Every
// expected CC below is hand-derived from the canonical decision set
// (if / loop / case / catch / ?: / && / || / ??) — when a case and that set
// disagree, the set wins and the test is wrong.
import { describe, expect, it } from "vitest";
import { computeCyclomaticAst } from "./checks/cyclomatic-ast.js";
import {
	type DecompositionPlan,
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
