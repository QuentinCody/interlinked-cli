import { describe, expect, it } from "vitest";
import { always, atom, eventually, FALSE, next, release, TRUE, until } from "./formula.js";
import { asFormula, endOfResidual, type Residual, residualKey, residualSize } from "./residual.js";

type S = { n: number };
type E = { x: boolean };
const p = atom<S, E>("p", (_s, e) => e.x);
const q = atom<S, E>("q", (s) => s.n > 0);

describe("endOfResidual — positive (weak leaning passes a pending safety obligation)", () => {
	it("P1: a never-evaluated always or release is unknown strictly and true under the weak leaning", () => {
		expect(endOfResidual(asFormula(always(p)), "strict")).toBe("unknown");
		expect(endOfResidual(asFormula(always(p)), "weak")).toBe("true");
		expect(endOfResidual(asFormula(release(p, q)), "weak")).toBe("true");
	});

	it("P2: an open always node with no pending obligations is unknown strictly, true weakly", () => {
		const node: Residual<S, E> = { kind: "always", sub: p, remaining: null, pending: [], onset: 0 };
		expect(endOfResidual(node, "strict")).toBe("unknown");
		expect(endOfResidual(node, "weak")).toBe("true");
	});

	it("P3: implies with a false right side and a settled-true left side folds to false", () => {
		const r: Residual<S, E> = {
			kind: "implies",
			left: { kind: "true", evidence: [] },
			right: { kind: "violated", violations: [{ onset: 0, evidence: [] }] },
		};
		expect(endOfResidual(r, "strict")).toBe("false");
		expect(endOfResidual(r, "weak")).toBe("false");
	});

	it("P4: constants resolve through never-evaluated operators (G true, F false, x U true)", () => {
		expect(endOfResidual(asFormula(always(TRUE)), "strict")).toBe("true");
		expect(endOfResidual(asFormula(eventually(FALSE)), "strict")).toBe("false");
		expect(endOfResidual(asFormula(until(p, TRUE)), "strict")).toBe("true");
	});
});

describe("endOfResidual — negative (strong operators are unknown under both folds, never pass)", () => {
	it("N1: eventually / until / next / a bare atom fold to unknown", () => {
		for (const mode of ["strict", "weak"] as const) {
			expect(endOfResidual(asFormula(eventually(p)), mode)).toBe("unknown");
			expect(endOfResidual(asFormula(until(p, q)), mode)).toBe("unknown");
			expect(endOfResidual(asFormula(next(p)), mode)).toBe("unknown");
			expect(endOfResidual(asFormula(p), mode)).toBe("unknown");
		}
	});

	it("N2: an always node with a pending eventually obligation is unknown even under the weak leaning", () => {
		const ob: Residual<S, E> = { kind: "eventually", sub: q, remaining: 2, pending: [], onset: 3 };
		const node: Residual<S, E> = { kind: "always", sub: p, remaining: null, pending: [{ residual: ob, onset: 3 }], onset: 0 };
		expect(endOfResidual(node, "weak")).toBe("unknown");
	});

	it("N3: residualKey ignores onsets of pending obligations but residualSize counts them", () => {
		const ob = (onset: number): Residual<S, E> => ({ kind: "eventually", sub: q, remaining: null, pending: [], onset });
		const a: Residual<S, E> = { kind: "always", sub: p, remaining: null, pending: [{ residual: ob(1), onset: 1 }], onset: 0 };
		const b: Residual<S, E> = { kind: "always", sub: p, remaining: null, pending: [{ residual: ob(7), onset: 7 }], onset: 0 };
		expect(residualKey(a)).toBe(residualKey(b));
		expect(residualSize(a)).toBe(2);
		expect(residualKey(a)).not.toBe(residualKey({ ...a, pending: [] }));
	});
});
