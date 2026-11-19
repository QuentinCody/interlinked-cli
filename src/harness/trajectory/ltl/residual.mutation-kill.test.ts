import { describe, expect, it } from "vitest";
import { always, atom, FALSE, release } from "./formula.js";
import { asFormula, endOfResidual } from "./residual.js";

type S = { n: number };
type E = { x: boolean };
const p = atom<S, E>("p", (_s, e) => e.x);

// Census fault: `leanWeak` dropped its `v === "unknown"` conjunct and survived the
// companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("endOfResidual — the weak leaning only lifts UNKNOWN safety obligations", () => {
	// test-contract: invariant — weak mode reads a pending `always` as true because nothing refuted it; an `always` whose body is already false IS refuted and must stay false at Stop
	it("keeps a refuted always false under the weak leaning", () => {
		expect(endOfResidual(asFormula(always(FALSE)), "weak")).toBe("false");
		expect(endOfResidual(asFormula(always(FALSE)), "strict")).toBe("false");
	});
	// test-contract: invariant — release is the dual safety operator and follows the same rule: a false right side is refuted, not lifted
	it("keeps a refuted release false under the weak leaning", () => {
		expect(endOfResidual(asFormula(release(p, FALSE)), "weak")).toBe("false");
	});
});
