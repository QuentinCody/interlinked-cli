import { describe, expect, it } from "vitest";
import {
	always,
	and,
	atom,
	eventually,
	FALSE,
	formulaKey,
	implies,
	next,
	not,
	or,
	release,
	renderFormula,
	TRUE,
	until,
	within,
} from "./formula.js";

type S = { n: number };
type E = { x: boolean };
const p = atom<S, E>("p", (_s, e) => e.x);
const q = atom<S, E>("q", (s) => s.n > 0);

describe("not() — positive (must rewrite to NNF)", () => {
	it("P1: flips an atom's negation flag instead of wrapping", () => {
		expect(not(p)).toEqual({ ...p, negated: true });
		expect(not(not(p))).toEqual(p);
	});

	it("P2a: De Morgan — and/or dualize", () => {
		expect(formulaKey(not(and(p, q)))).toBe(formulaKey(or(not(p), not(q))));
		expect(formulaKey(not(or(p, q)))).toBe(formulaKey(and(not(p), not(q))));
	});

	it("P2b: ¬(l ⇒ r) is l ∧ ¬r and next is self-dual", () => {
		expect(formulaKey(not(implies(p, q)))).toBe(formulaKey(and(p, not(q))));
		expect(formulaKey(not(next(p)))).toBe(formulaKey(next(not(p))));
	});

	it("P2c: always/eventually dualize and keep the bound", () => {
		expect(formulaKey(not(always(p, 3)))).toBe(formulaKey(eventually(not(p), 3)));
		expect(formulaKey(not(eventually(p)))).toBe(formulaKey(always(not(p))));
	});

	it("P2d: until/release dualize; constants flip", () => {
		expect(formulaKey(not(until(p, q)))).toBe(formulaKey(release(not(p), not(q))));
		expect(formulaKey(not(release(p, q)))).toBe(formulaKey(until(not(p), not(q))));
		expect(not(TRUE)).toBe(FALSE);
		expect(not(FALSE)).toBe(TRUE);
	});

	it("P3: within() sets an event bound and renders it", () => {
		const f = within(eventually(p), 4);
		expect(f.bound).toBe(4);
		expect(renderFormula(f)).toBe("eventually(p).within(4)");
		expect(renderFormula(implies(not(p), always(q)))).toBe("implies(¬p, always(q))");
	});
});

describe("bounds — negative (must not accept a non-count)", () => {
	it("N1: zero, negative, fractional-below-one and non-finite bounds mean unbounded", () => {
		expect(always(p, 0).bound).toBeNull();
		expect(always(p, -2).bound).toBeNull();
		expect(eventually(p, 0.5).bound).toBeNull();
		expect(eventually(p, Number.POSITIVE_INFINITY).bound).toBeNull();
		expect(eventually(p, Number.NaN).bound).toBeNull();
	});

	it("N2: a fractional bound above one floors to a count", () => {
		expect(eventually(p, 2.9).bound).toBe(2);
	});

	it("N3: formulaKey distinguishes bound, polarity and operator", () => {
		expect(formulaKey(always(p, 2))).not.toBe(formulaKey(always(p, 3)));
		expect(formulaKey(always(p))).not.toBe(formulaKey(eventually(p)));
		expect(formulaKey(p)).not.toBe(formulaKey(not(p)));
		expect(formulaKey(until(p, q))).not.toBe(formulaKey(release(p, q)));
	});
});
