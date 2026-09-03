// Labeled P/N cases for the cognitive flattening planner (cognitive-plan.ts).
//
// The planner's savings estimates are only trustworthy if its private scorer
// agrees with the SHIPPED cognitive scorer (checks/cognitive-ast.ts). Every
// positive case therefore pins `plan.totalCognitive` against
// `computeCognitiveAst` as an oracle rather than against a hand-written
// number, and the savings numbers below are hand-derived from the Sonar rules
// the shipped scorer implements (+1 per structure, +1 per nesting level).
import { describe, expect, it } from "vitest";
import { computeCognitiveAst } from "./checks/cognitive-ast.js";
import {
	type CognitivePlan,
	cognitivePlanToMessage,
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
