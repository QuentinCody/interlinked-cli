// Algebraic laws of the monitor, checked on random formulas and random traces
// with fast-check. Mirrors Bombadil's `bombadil-ltl/src/ltl_equivalences.rs`
// (Antithesis, MIT): two formulas are equivalent when the monitor gives the
// same per-event verdict sequence and the same end-of-trace verdict ("up to
// violations" — the violation lists may differ in how they are attributed).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type EndVerdict, Monitor, type StepVerdict } from "./eval.js";
import {
	always,
	and,
	atom,
	eventually,
	FALSE,
	type Formula,
	implies,
	next,
	not,
	or,
	release,
	TRUE,
	until,
} from "./formula.js";

type S = Record<string, never>;
type E = { x: boolean; y: boolean };
type F = Formula<S, E>;

const x = atom<S, E>("x", (_s, e) => e.x);
const y = atom<S, E>("y", (_s, e) => e.y);

const boundArb = fc.option(fc.integer({ min: 1, max: 4 }), { nil: null });

/** Random formulas over x, y up to depth 3, every operator included (like Bombadil's `syntax()` generator plus until). */
const formulaArb: fc.Arbitrary<F> = fc.letrec<{ f: F }>((tie) => ({
	f: fc.oneof(
		{ depthSize: "small", withCrossShrink: true },
		fc.constantFrom<F>(x, y, TRUE, FALSE),
		tie("f").map((f) => not(f)),
		fc.tuple(tie("f"), tie("f")).map(([a, b]) => and(a, b)),
		fc.tuple(tie("f"), tie("f")).map(([a, b]) => or(a, b)),
		fc.tuple(tie("f"), tie("f")).map(([a, b]) => implies(a, b)),
		fc.tuple(tie("f"), tie("f")).map(([a, b]) => until(a, b)),
		tie("f").map((f) => next(f)),
		fc.tuple(tie("f"), boundArb).map(([f, b]) => always(f, b)),
		fc.tuple(tie("f"), boundArb).map(([f, b]) => eventually(f, b)),
	),
})).f;

const traceArb: fc.Arbitrary<E[]> = fc.array(fc.record({ x: fc.boolean(), y: fc.boolean() }), { maxLength: 8 });

interface Run {
	steps: StepVerdict[];
	end: EndVerdict;
}

/** Run both formulas as two properties of one monitor over `trace`. */
function runPair(left: F, right: F, trace: E[]): [Run, Run] {
	const m = new Monitor<S, E>([
		{ id: "L", formula: left },
		{ id: "R", formula: right },
	]);
	const state: S = {};
	const lSteps: StepVerdict[] = [];
	const rSteps: StepVerdict[] = [];
	for (const e of trace) {
		const [l, r] = m.step(state, e);
		if (l) lSteps.push(l.verdict);
		if (r) rSteps.push(r.verdict);
	}
	const [lEnd, rEnd] = m.end();
	return [
		{ steps: lSteps, end: lEnd?.verdict ?? "unknown" },
		{ steps: rSteps, end: rEnd?.verdict ?? "unknown" },
	];
}

function law(name: string, build: (a: F, b: F, bound: number | null) => [F, F]): void {
	it(name, () => {
		fc.assert(
			fc.property(formulaArb, formulaArb, boundArb, traceArb, (a, b, bound, trace) => {
				const [left, right] = build(a, b, bound);
				const [l, r] = runPair(left, right, trace);
				expect(r).toEqual(l);
			}),
			{ numRuns: 300 },
		);
	});
}

describe("LTL laws — positive (must hold on every random trace)", () => {
	// Distributivity
	law("P1: X(φ ∨ ψ) ⇔ Xφ ∨ Xψ", (a, b) => [next(or(a, b)), or(next(a), next(b))]);
	law("P2: X(φ ∧ ψ) ⇔ Xφ ∧ Xψ", (a, b) => [next(and(a, b)), and(next(a), next(b))]);
	law("P3: F_b(φ ∨ ψ) ⇔ F_bφ ∨ F_bψ", (a, b, n) => [eventually(or(a, b), n), or(eventually(a, n), eventually(b, n))]);
	law("P4: G_b(φ ∧ ψ) ⇔ G_bφ ∧ G_bψ", (a, b, n) => [always(and(a, b), n), and(always(a, n), always(b, n))]);
	// Negation propagation (duality)
	law("P5: X¬φ ⇔ ¬Xφ", (a) => [next(not(a)), not(next(a))]);
	law("P6: G¬φ ⇔ ¬Fφ", (a) => [always(not(a)), not(eventually(a))]);
	law("P7: ¬(φ U ψ) ⇔ ¬φ R ¬ψ", (a, b) => [not(until(a, b)), release(not(a), not(b))]);
	// Idempotence
	law("P8: Fφ ⇔ FFφ", (a) => [eventually(a), eventually(eventually(a))]);
	law("P9: Gφ ⇔ GGφ", (a) => [always(a), always(always(a))]);
	// Until identities
	law("P10: φ U ψ ⇔ ψ ∨ (φ ∧ X(φ U ψ))", (a, b) => [until(a, b), or(b, and(a, next(until(a, b))))]);
	law("P11: Fφ ⇔ true U φ", (a) => [eventually(a), until(TRUE, a)]);
	law("P12: Gφ ⇔ false R φ", (a) => [always(a), release(FALSE, a)]);
	law("P13: φ ⇒ ψ ⇔ ¬φ ∨ ψ", (a, b) => [implies(a, b), or(not(a), b)]);
});

describe("LTL laws — negative (a wrong law is detected)", () => {
	it("N1: G(φ ∨ ψ) is NOT G φ ∨ G ψ — the checker finds a counterexample", () => {
		const trace: E[] = [
			{ x: true, y: false },
			{ x: false, y: true },
		];
		const [l, r] = runPair(always(or(x, y)), or(always(x), always(y)), trace);
		expect(l.steps).toEqual(["pending", "pending"]);
		expect(r.steps).toEqual(["pending", "false"]);
	});

	it("N2: Fφ is NOT Gφ — a false x leaves eventually unknown and refutes always", () => {
		const [l, r] = runPair(eventually(x), always(x), [{ x: false, y: false }]);
		expect(l.end).toBe("unknown");
		expect(r.end).toBe("false");
	});
});
