// Labeled P/N cases for the cognitive flattening planner (cognitive-plan.ts).
//
// The planner's savings estimates are only trustworthy if its private scorer
// agrees with the SHIPPED cognitive scorer (checks/cognitive-ast.ts). Every
// positive case therefore pins `plan.totalCognitive` against
// `computeCognitiveAst` as an oracle rather than against a hand-written
// number, and the savings numbers below are hand-derived from the Sonar rules
// the shipped scorer implements (+1 per structure, +1 per nesting level).
// Also covers every container kind the planner recognizes (loop headers,
// else-if chains, switch cases, try/catch/finally, a bare block statement,
// and a concise-body arrow), plus the one branch (`loopSubject`'s
// `undefined` fallback) `planCognitiveFlattening` can never reach — tested
// directly against the exported helper instead.
//
// Two container kinds (`switchContainers`, `containersOf`'s bare-`isBlock`
// arm) get a SECOND fixture each (`SWITCH_FN2`, `BLOCK_FN2`) whose clause/
// block does not escape, so the container becomes a real, named move —
// N9/N10 alone only prove the escaping-jump cancellation nets zero saving,
// which stays zero whether or not the container source ran at all. And
// `loopSubject`'s `for`/`while`/`do` arms (P10/P11) are asserted directly
// against a minimal parse, since their only consumer inside a full plan is
// a helper NAME that can collapse to the same string regardless of which
// arm produced it.
import { describe, expect, it } from "vitest";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { computeCognitiveAst } from "./checks/cognitive-ast.js";
import {
	type CognitivePlan,
	cognitivePlanToMessage,
	loopSubject,
	planCognitiveFlattening,
} from "./cognitive-plan.js";

/** Narrow away the null case without branching inside a test body. */
function assertPlan(plan: CognitivePlan | null): asserts plan is CognitivePlan {
	if (plan === null) throw new Error("expected a plan, got null");
}

/** The shipped scorer's verdict for `name` — the oracle every P case pins to. */
function oracle(src: string, name: string): number {
	const entries = computeCognitiveAst(src, "/tmp/oracle.ts");
	if (!entries) throw new Error("typescript unavailable — the planner tests need it");
	const hit = entries.filter((e) => e.name === name).sort((a, b) => b.cognitive - a.cognitive)[0];
	if (!hit) throw new Error(`no function named ${name}`);
	return hit.cognitive;
}

// ---------- fixtures ----------

/** Four `if`s nested 4 deep → 1 + 2 + 3 + 4 + 4 = 14. No `return` inside the
 *  nest, so an extracted block needs no residual guard at the call site. */
const DEEP = `export function deep(a: boolean, b: boolean, c: boolean, d: boolean): number {
	let r = 0;
	if (a) {
		if (b) {
			if (c) {
				if (d) { r += 1; }
				if (d) { r += 2; }
			}
		}
	}
	return r;
}
`;

/** The same nest, but the innermost statements RETURN — so a helper made from
 *  the block leaves an `if (…) return …;` guard behind at the call site. */
const DEEP_RETURNS = `export function deepReturns(a: boolean, b: boolean, c: boolean, d: boolean): number {
	if (a) {
		if (b) {
			if (c) {
				if (d) { return 1; }
				if (d) { return 2; }
			}
		}
	}
	return 0;
}
`;

/** A loop whose body carries three nesting-paying ifs → 1 + 2 + 2 + 2 = 7. */
const LOOPY = `export function loopy(xs: number[]): number {
	let r = 0;
	for (const x of xs) {
		if (x > 0) { r += 1; }
		if (x > 1) { r += 2; }
		if (x > 2) { r += 3; }
	}
	return r;
}
`;

/** `a && b || c && d` → three logical-run transitions. */
const MIXED = `export function mixed(a: boolean, b: boolean, c: boolean, d: boolean): boolean {
	return a && b || c && d;
}
`;

/** Over cap, but its only sequence is ONE uniform `&&` run — nothing to split. */
const UNIFORM = `export function uniform(a: boolean, b: boolean, c: boolean): number {
	if (a && b && c) { return 1; }
	if (a) { return 2; }
	return 0;
}
`;

/** `if (a) { …12 flat ifs… }` then a bare `return` — the guard-clause shape.
 *  1 + 12 * 2 = 25, and the then-block costs 12 at depth 0 (over any cap < 12). */
function wrapped(inner: number): string {
	let body = "";
	for (let i = 0; i < inner; i++) body += `\t\tif (b === ${i}) { r += ${i}; }\n`;
	return `export function wrapped(a: boolean, b: number): number {
	let r = 0;
	if (a) {
${body}	}
	return r;
}
`;
}

/** Two flat ifs — well under any realistic cap. */
const TINY = `export function tiny(a: boolean, b: boolean): number {
	if (a) { return 1; }
	if (b) { return 2; }
	return 0;
}
`;

/** A classic C-style for-loop — `loopSubject` reads its `condition`, not its `expression`. */
const CLASSIC_FOR = `export function classicFor(n: number): number {
	let r = 0;
	for (let i = 0; i < n; i++) {
		if (i > 0) { r += 1; }
		if (i > 1) { r += 2; }
	}
	return r;
}
`;

/** A while-loop — `loopSubject` reads its `expression`, same as a do-loop would. */
const WHILE_LOOP = `export function whileLoop(n: number): number {
	let i = 0;
	let r = 0;
	while (i < n) {
		if (i > 0) { r += 1; }
		i++;
	}
	return r;
}
`;

/** An `else if` chain: the first arm mutates `r` (no escaping jump, so its
 *  block is a genuine candidate) and the chain continues into a second
 *  `if (c)` arm with the same shape — recursing through `ifContainers`. */
const CHAINED = `export function chained(a: boolean, b: boolean, c: boolean, d: boolean): number {
	let r = 0;
	if (a) {
		if (b) { r += 1; }
		if (b) { r += 2; }
	} else if (c) {
		if (d) { r += 3; }
		if (d) { r += 4; }
	}
	return r;
}
`;

/** Two `case` clauses, each ending in a `return` (an escaping jump), so
 *  neither clause's block is a net-positive extraction candidate. */
const SWITCH_FN = `export function routeCase(x: number, y: number): number {
	switch (x) {
		case 1:
			if (y > 0) { return 1; }
			return 2;
		case 2:
			if (y > 1) { return 3; }
			return 4;
		default:
			return 0;
	}
}
`;

/** Same shape as `SWITCH_FN`, but neither clause escapes — `switchContainers`
 *  now yields a real candidate, so N9 can prove the container it built
 *  (name/depth/saving/lines) rather than only that an escaping clause
 *  nets zero saving (which stays zero whether or not the container ran). */
const SWITCH_FN2 = `export function routeCase2(x: number, y: number): number {
	let r = 0;
	switch (x) {
		case 1:
			if (y > 0) { r += 1; }
			if (y > 1) { r += 2; }
			break;
		default:
			r += 3;
	}
	return r;
}
`;

/** try/catch/finally, each block carrying its own nesting-paying ifs — the
 *  `try` block itself does NOT deepen, only its `catch` does. */
const TRY_FN = `export function attemptWork(a: boolean, b: boolean, c: boolean): number {
	try {
		if (a) { return 1; }
		if (a) { return 2; }
	} catch (e) {
		if (b) { return 3; }
		if (b) { return 4; }
	} finally {
		if (c) { return 5; }
		if (c) { return 6; }
	}
	return 0;
}
`;

/** A bare `{ … }` block statement, not attached to any `if`/`for`/`switch`/`try`. */
const BLOCK_FN = `export function blockish(a: boolean): number {
	{
		if (a) { return 1; }
		if (a) { return 2; }
	}
	return 0;
}
`;

/** Same shape as `BLOCK_FN`, but with an extra increment outside the bare
 *  block so the block itself now fits under the cap — N10 uses this to
 *  prove `containersOf`'s `isBlock` arm produces a real, named move
 *  (`runBlock`) rather than only that an escaping-jump block nets zero
 *  saving (which stays zero whether or not the arm ran at all). */
const BLOCK_FN2 = `export function blockish2(a: boolean, b: boolean, c: boolean): number {
	let r = 0;
	if (c) { r += 5; }
	{
		if (a) { r += 1; }
		if (b) { r += 2; }
	}
	return r;
}
`;

/** Same mixed condition as `MIXED`, but as a concise arrow-function body
 *  (no block for `collectFrom` to walk with `walkList`). */
const ARROW_MIXED = `export const arrowMixed = (a: boolean, b: boolean, c: boolean, d: boolean): boolean => a && b || c && d;
`;

// ---------- positive (must produce a move) ----------

describe("planCognitiveFlattening — positive (must fire)", () => {
	it("P1: extract-nested-block — picks the deepest block whose helper fits the cap", () => {
		const plan = planCognitiveFlattening(DEEP, "/tmp/deep.ts", "deep", 5);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(DEEP, "deep"));
		expect(plan.totalCognitive).toBe(14);
		const move = plan.moves[0];
		expect(move?.kind).toBe("extract-nested-block");
		// `if (b) { if (c) { if (d) …; if (d) … } }`'s STATEMENTS sit at depth 2:
		// in place 3 + 4 + 4 = 11; as a helper at depth 0 they cost 1 + 2 + 2 = 5 ≤ 5.
		expect(move?.depth).toBe(2);
		expect(move?.estimatedSaving).toBe(11);
		expect(move?.remainingAfter).toBe(3);
		expect(plan.remainingCognitive).toBe(3);
		expect(move?.suggestedName).toMatch(/^[a-z][A-Za-z0-9]*$/);
	});

	it("P2: extract-loop-body — a loop body is labeled as such, not as a plain block", () => {
		const plan = planCognitiveFlattening(LOOPY, "/tmp/loopy.ts", "loopy", 3);
		expect(plan?.totalCognitive).toBe(oracle(LOOPY, "loopy"));
		expect(plan?.totalCognitive).toBe(7);
		expect(plan?.moves[0]?.kind).toBe("extract-loop-body");
		expect(plan?.moves[0]?.depth).toBe(1);
		expect(plan?.moves[0]?.estimatedSaving).toBe(6); // 2 + 2 + 2 at depth 1
		expect(plan?.remainingCognitive).toBe(1);
	});

	it("P3: split-condition — a mixed &&/|| sequence saves its extra run transitions", () => {
		const plan = planCognitiveFlattening(MIXED, "/tmp/mixed.ts", "mixed", 1);
		expect(plan?.totalCognitive).toBe(oracle(MIXED, "mixed"));
		expect(plan?.totalCognitive).toBe(3);
		expect(plan?.moves[0]?.kind).toBe("split-condition");
		expect(plan?.moves[0]?.estimatedSaving).toBe(2); // 3 transitions → keep one run
		expect(plan?.remainingCognitive).toBe(1);
	});

	it("P4: guard-clause — an else-less wrapper `if` whose block is too big to extract", () => {
		const src = wrapped(12);
		const plan = planCognitiveFlattening(src, "/tmp/wrapped.ts", "wrapped", 10);
		expect(plan?.totalCognitive).toBe(oracle(src, "wrapped"));
		expect(plan?.totalCognitive).toBe(25); // 1 + 12 * 2
		const guard = plan?.moves.find((m) => m.kind === "guard-clause");
		expect(guard).toBeDefined();
		// The block would cost 12 as a helper (> cap 10) so it is not extractable;
		// inverting the wrapper lifts all 12 inner ifs one nesting level.
		expect(guard?.estimatedSaving).toBe(12);
		expect(guard?.suggestedName).toContain("if (");
	});

	it("P9: a block that RETURNS pays the residual guard the caller must keep", () => {
		const clean = planCognitiveFlattening(DEEP, "/tmp/deep.ts", "deep", 5);
		const returns = planCognitiveFlattening(DEEP_RETURNS, "/tmp/dr.ts", "deepReturns", 5);
		assertPlan(clean);
		assertPlan(returns);
		expect(returns.totalCognitive).toBe(clean.totalCognitive); // same shape, same score
		// Identical nest; the only difference is that a helper made from the
		// depth-2 block leaves an `if (…) return …;` behind, costing 1 + depth.
		expect(clean.moves[0]?.estimatedSaving).toBe(11);
		expect(returns.moves[0]?.estimatedSaving).toBe(11 - (1 + 2));
	});

	it("P5: moves are ordered largest-saving-first with a running remainder", () => {
		const plan = planCognitiveFlattening(DEEP, "/tmp/deep.ts", "deep", 2);
		assertPlan(plan);
		const savings = plan.moves.map((m) => m.estimatedSaving);
		expect([...savings].sort((a, b) => b - a)).toEqual(savings);
		let running = plan.totalCognitive;
		for (const m of plan.moves) {
			running -= m.estimatedSaving;
			expect(m.remainingAfter).toBe(running);
		}
		expect(plan.remainingCognitive).toBe(running);
	});

	it("P10: extract-loop-body — a classic for-loop is a container, not just for-of", () => {
		const plan = planCognitiveFlattening(CLASSIC_FOR, "/tmp/cf.ts", "classicFor", 3);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(CLASSIC_FOR, "classicFor"));
		expect(plan.totalCognitive).toBe(5);
		const move = plan.moves[0];
		expect(move?.kind).toBe("extract-loop-body");
		expect(move?.startLine).toBe(3);
		expect(move?.endLine).toBe(5);
		expect(move?.estimatedSaving).toBe(4);
		expect(plan.remainingCognitive).toBe(1);
		// The plan-level assertions above cannot discriminate `loopSubject`'s
		// `isForStatement` arm: its only consumer is the helper NAME, and on
		// this fixture the name it builds from `i < n`'s identifiers is
		// byte-identical to the name the undefined fallback would build, so
		// the arm is asserted directly against a minimal parse instead.
		const forParsed = parseTsSource("for (let i = 0; i < n; i++) { y(); }\n", "/tmp/for.ts");
		if (!forParsed) throw new Error("typescript unavailable");
		const forStmt = forParsed.sf.statements[0];
		if (!forStmt) throw new Error("expected a parsed statement");
		expect(loopSubject(forParsed.ts, forStmt)?.getText(forParsed.sf)).toBe("i < n");
	});

	it("P11: extract-loop-body — a while-loop reads its `expression`, same branch as a do-loop", () => {
		const plan = planCognitiveFlattening(WHILE_LOOP, "/tmp/wl.ts", "whileLoop", 1);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(WHILE_LOOP, "whileLoop"));
		expect(plan.totalCognitive).toBe(3);
		const move = plan.moves[0];
		expect(move?.kind).toBe("extract-loop-body");
		expect(move?.startLine).toBe(4);
		expect(move?.endLine).toBe(6);
		expect(move?.estimatedSaving).toBe(2);
		expect(plan.remainingCognitive).toBe(1);
		// Same discrimination need as P10: assert the while/do arm directly,
		// since the plan-level name it feeds cannot distinguish it from the
		// undefined fallback on this fixture.
		const whileParsed = parseTsSource("while (i < n) { y(); }\n", "/tmp/while.ts");
		if (!whileParsed) throw new Error("typescript unavailable");
		const whileStmt = whileParsed.sf.statements[0];
		if (!whileStmt) throw new Error("expected a parsed statement");
		expect(loopSubject(whileParsed.ts, whileStmt)?.getText(whileParsed.sf)).toBe("i < n");
		const doParsed = parseTsSource("do { y(); } while (i < n);\n", "/tmp/do.ts");
		if (!doParsed) throw new Error("typescript unavailable");
		const doStmt = doParsed.sf.statements[0];
		if (!doStmt) throw new Error("expected a parsed statement");
		expect(loopSubject(doParsed.ts, doStmt)?.getText(doParsed.sf)).toBe("i < n");
	});

	it("P12: an else-if chain recurses into the elseif's OWN arm, not the outer if's position", () => {
		const plan = planCognitiveFlattening(CHAINED, "/tmp/chained.ts", "chained", 4);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(CHAINED, "chained"));
		expect(plan.totalCognitive).toBe(10);
		expect(plan.moves).toHaveLength(2);
		// The outer `if (a)` arm is anchored at the outer if's own start (L3);
		// the recursive `ifContainers(ts, sf, els, n)` call anchors the elseif
		// arm at ITS OWN start (L6) — proof the recursion carries the right node.
		expect(plan.moves[0]?.startLine).toBe(3);
		expect(plan.moves[0]?.endLine).toBe(5);
		expect(plan.moves[1]?.startLine).toBe(6);
		expect(plan.moves[1]?.endLine).toBe(8);
		expect(plan.moves.every((m) => m.kind === "extract-nested-block")).toBe(true);
		expect(plan.remainingCognitive).toBe(2);
	});

	it("P13: try/catch/finally each become their own container at the right depth", () => {
		const plan = planCognitiveFlattening(TRY_FN, "/tmp/try.ts", "attemptWork", 2);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(TRY_FN, "attemptWork"));
		expect(plan.totalCognitive).toBe(9);
		const names = plan.moves.map((m) => m.suggestedName);
		expect(names).toContain("attemptOperation");
		expect(names).toContain("handleOperationError");
		expect(names).toContain("cleanupOperation");
		const tryMove = plan.moves.find((m) => m.suggestedName === "attemptOperation");
		const catchMove = plan.moves.find((m) => m.suggestedName === "handleOperationError");
		// The try block itself does NOT deepen (depth 0); only `catch` does (depth 1).
		expect(tryMove?.depth).toBe(0);
		expect(catchMove?.depth).toBe(1);
		expect(plan.remainingCognitive).toBe(5);
	});

	it("P14: a concise-body arrow function is walked via `collectSplits`, not `walkList`", () => {
		const plan = planCognitiveFlattening(ARROW_MIXED, "/tmp/am.ts", "arrowMixed", 1);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(ARROW_MIXED, "arrowMixed"));
		expect(plan.totalCognitive).toBe(3);
		expect(plan.moves[0]?.kind).toBe("split-condition");
		expect(plan.moves[0]?.estimatedSaving).toBe(2);
		expect(plan.remainingCognitive).toBe(1);
		expect(cognitivePlanToMessage(plan)).toContain("split the mixed condition");
	});
});

// ---------- negative (must not fire) ----------

describe("planCognitiveFlattening — negative (must not fire)", () => {
	it("N1: returns null for a non-JS/TS path", () => {
		expect(planCognitiveFlattening("def f():\n    return 1\n", "/tmp/a.py", "f", 10)).toBeNull();
	});

	it("N2: returns null for a function the file does not contain", () => {
		expect(planCognitiveFlattening(DEEP, "/tmp/deep.ts", "notThere", 5)).toBeNull();
	});

	it("N3: an already-under-cap function gets an empty plan, not a null", () => {
		const plan = planCognitiveFlattening(TINY, "/tmp/tiny.ts", "tiny", 30);
		expect(plan).not.toBeNull();
		expect(plan?.moves).toEqual([]);
		expect(plan?.remainingCognitive).toBe(plan?.totalCognitive);
	});

	it("N4: a uniform &&-run yields no split-condition move (no extra transitions)", () => {
		const plan = planCognitiveFlattening(UNIFORM, "/tmp/uniform.ts", "uniform", 1);
		expect(plan?.totalCognitive).toBe(oracle(UNIFORM, "uniform"));
		expect(plan?.totalCognitive).toBeGreaterThan(1); // the function IS over the cap
		expect(plan?.moves.some((m) => m.kind === "split-condition")).toBe(false);
	});

	it("N5: an `if` with an `else` is never a guard-clause candidate", () => {
		const src = `export function withElse(a: boolean, b: boolean, c: boolean): number {
	if (a) {
		if (b) { return 1; }
		if (c) { return 2; }
	} else {
		return 3;
	}
	return 0;
}
`;
		const plan = planCognitiveFlattening(src, "/tmp/we.ts", "withElse", 2);
		expect(plan?.moves.some((m) => m.kind === "guard-clause")).toBe(false);
	});

	it("N6: a decision-free nested block produces no extraction move", () => {
		const src = `export function plain(a: boolean): number {
	if (a) {
		const x = 1;
		const y = 2;
		return x + y;
	}
	return 0;
}
`;
		const plan = planCognitiveFlattening(src, "/tmp/plain.ts", "plain", 0);
		expect(plan?.moves).toEqual([]);
	});

	it("N7: picked moves never overlap on source lines", () => {
		const plan = planCognitiveFlattening(wrapped(12), "/tmp/wrapped.ts", "wrapped", 1);
		assertPlan(plan);
		const spans = plan.moves.map((m) => [m.startLine, m.endLine] as const);
		for (let i = 0; i < spans.length; i++) {
			for (let j = i + 1; j < spans.length; j++) {
				const a = spans[i];
				const b = spans[j];
				if (!a || !b) continue;
				expect(a[1] < b[0] || b[1] < a[0]).toBe(true);
			}
		}
	});

	it("N9: a switch case ending in `return` nets zero saving, same cancellation as a guarded return", () => {
		const plan = planCognitiveFlattening(SWITCH_FN, "/tmp/switch.ts", "routeCase", 1);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(SWITCH_FN, "routeCase"));
		expect(plan.totalCognitive).toBe(5);
		expect(plan.moves).toEqual([]);
		// Contrast: the SAME switchContainers path, given a clause that does NOT
		// escape, produces a real, named candidate — proving the empty result
		// above is the escaping-jump cancellation, not switchContainers never
		// running (an empty `moves` cannot otherwise distinguish the two).
		const observable = planCognitiveFlattening(SWITCH_FN2, "/tmp/switch2.ts", "routeCase2", 3);
		assertPlan(observable);
		expect(observable.totalCognitive).toBe(oracle(SWITCH_FN2, "routeCase2"));
		expect(observable.totalCognitive).toBe(5);
		const move = observable.moves[0];
		expect(move?.kind).toBe("extract-nested-block");
		expect(move?.suggestedName).toBe("handleSwitchCase1");
		expect(move?.depth).toBe(1);
		expect(move?.estimatedSaving).toBe(2);
		expect(move?.startLine).toBe(4);
		expect(move?.endLine).toBe(7);
	});

	it("N10: a bare block statement (no if/for/switch/try) still walks via containersOf", () => {
		const plan = planCognitiveFlattening(BLOCK_FN, "/tmp/block.ts", "blockish", 1);
		assertPlan(plan);
		expect(plan.totalCognitive).toBe(oracle(BLOCK_FN, "blockish"));
		expect(plan.totalCognitive).toBe(2);
		expect(plan.moves).toEqual([]);
		// Contrast: the SAME isBlock arm, given room under the cap, DOES yield a
		// named move — proving the empty result above is the escaping-jump
		// cancellation, not containersOf skipping bare blocks entirely.
		const observable = planCognitiveFlattening(BLOCK_FN2, "/tmp/block2.ts", "blockish2", 2);
		assertPlan(observable);
		expect(observable.totalCognitive).toBe(oracle(BLOCK_FN2, "blockish2"));
		expect(observable.totalCognitive).toBe(3);
		const move = observable.moves[0];
		expect(move?.kind).toBe("extract-nested-block");
		expect(move?.suggestedName).toBe("runBlock");
		expect(move?.depth).toBe(0);
		expect(move?.estimatedSaving).toBe(2);
		expect(move?.startLine).toBe(4);
		expect(move?.endLine).toBe(6);
	});

	it("N11: loopSubject falls through to undefined for a node no loop-kind guard ever passes it", () => {
		const parsed = parseTsSource("if (true) { 1; }\n", "/tmp/probe.ts");
		if (!parsed) throw new Error("typescript unavailable");
		const { ts, sf } = parsed;
		const ifStmt = sf.statements[0];
		if (!ifStmt) throw new Error("expected a parsed statement");
		expect(loopSubject(ts, ifStmt)).toBeUndefined();
		// Contrast: a real loop node DOES resolve to its subject expression.
		const loopParsed = parseTsSource("for (const x of xs) { 1; }\n", "/tmp/loop.ts");
		if (!loopParsed) throw new Error("typescript unavailable");
		const forOfStmt = loopParsed.sf.statements[0];
		if (!forOfStmt) throw new Error("expected a parsed statement");
		const subject = loopSubject(loopParsed.ts, forOfStmt);
		expect(subject?.getText(loopParsed.sf)).toBe("xs");
	});
});

// ---------- partial-plan convention ----------

describe("planCognitiveFlattening — partial plans", () => {
	it("P6: returns the best partial plan when no move set reaches the cap", () => {
		const src = wrapped(12);
		const plan = planCognitiveFlattening(src, "/tmp/wrapped.ts", "wrapped", 10);
		assertPlan(plan);
		expect(plan.moves.length).toBeGreaterThan(0);
		expect(plan.remainingCognitive).toBeGreaterThan(plan.targetCap);
		expect(cognitivePlanToMessage(plan)).toContain("still over 10");
	});
});

// ---------- message ----------

describe("cognitivePlanToMessage", () => {
	it("P7: renders one newline-free sentence naming each move and the remainder", () => {
		const plan = planCognitiveFlattening(DEEP, "/tmp/deep.ts", "deep", 5);
		assertPlan(plan);
		const msg = cognitivePlanToMessage(plan);
		expect(msg).not.toContain("\n");
		expect(msg).toContain("flatten:");
		expect(msg).toContain("depth-2 block");
		expect(msg).toContain("−11");
		expect(msg).toContain("→ 3");
	});

	it("P8: says so plainly when there is nothing to flatten", () => {
		const plan = planCognitiveFlattening(TINY, "/tmp/tiny.ts", "tiny", 30);
		assertPlan(plan);
		expect(cognitivePlanToMessage(plan)).toContain("already");
		expect(cognitivePlanToMessage(plan)).not.toContain("\n");
	});

	it("N8: an over-cap function with no candidate move gets the by-hand message", () => {
		const src = `export function labelled(xs: number[]): number {
	let r = 0;
	outer: for (const x of xs) {
		if (x) { continue outer; }
	}
	return r;
}
`;
		const plan = planCognitiveFlattening(src, "/tmp/lab.ts", "labelled", 0);
		assertPlan(plan);
		// Every structure here is either a labeled jump (no nesting to lift) or a
		// block whose helper would still exceed the cap of 0, so nothing qualifies.
		expect(plan.moves).toEqual([]);
		expect(cognitivePlanToMessage(plan)).toContain("by hand");
	});
});
