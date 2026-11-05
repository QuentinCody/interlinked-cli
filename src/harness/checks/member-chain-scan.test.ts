import { describe, expect, it } from "vitest";
import { memberChainStart } from "./member-chain-scan.js";

/** Chain head text for the `.forEach` in `src`. */
function headOf(src: string): string {
	const dot = src.indexOf(".forEach");
	return src.slice(memberChainStart(src, dot), dot);
}

describe("memberChainStart", () => {
	it("returns the receiver identifier of a one-link chain", () => {
		expect(headOf("await xs.forEach(f)")).toBe("xs");
	});

	it("walks back over member links and closed calls", () => {
		expect(headOf("await this.src.map((x) => g(x)).forEach(f)")).toBe("this.src.map((x) => g(x))");
	});

	it("walks back over a multi-line chain", () => {
		expect(headOf("await readable\n  .filter((c) => c)\n  .forEach(f)")).toBe(
			"readable\n  .filter((c) => c)\n  ",
		);
	});

	it("walks back over optional and non-null links and index access", () => {
		expect(headOf("x = a?.b!.c[0].forEach(f)")).toBe("a?.b!.c[0]");
	});

	it("stops at an enclosing call's open paren", () => {
		expect(headOf("await Promise.all(xs.forEach(f))")).toBe("xs");
	});

	it("yields an empty head at an unbalanced close bracket", () => {
		expect(headOf(") ) .forEach(f)")).toBe("");
	});
});

// Census fault (docs/reviews/kill-proof-census-harness.md, "Product defect
// found"): `isChainLink` took a bare `?` and a prefix `!` as chain links, so the
// head of `c ? a.b.forEach` was `c` and `await c ? …` read as an awaited forEach.
describe("memberChainStart — links — positive (a link joins the chain)", () => {
	it("P1: `?.` before an identifier is optional chaining", () => {
		expect(headOf("await a?.b.forEach(f)")).toBe("a?.b");
	});

	it("P2: `?.` before a call or index is optional chaining", () => {
		expect(headOf("await s?.(x).forEach(f)")).toBe("s?.(x)");
		expect(headOf("await s?.[0].forEach(f)")).toBe("s?.[0]");
	});

	it("P3: a postfix `!` after an identifier, a call or an index is a non-null assertion", () => {
		expect(headOf("x = a?.b!.c.forEach(f)")).toBe("a?.b!.c");
		expect(headOf("await f()!.forEach(f)")).toBe("f()!");
		expect(headOf("await xs[0]!.forEach(f)")).toBe("xs[0]!");
	});
});

describe("memberChainStart — links — negative (a ternary or a prefix is not a link)", () => {
	// test-contract: bug — a ternary `?` must end the chain, so the head of `c ? a.b.forEach` is `a.b`, never `c`
	it("N1: a bare `?` is a ternary, not a chain link", () => {
		expect(headOf("x = c ? a.b.forEach(f) : 0")).toBe("a.b");
		expect(headOf("x = await c ? items.forEach(f) : null")).toBe("items");
	});

	it("N2: a `?` before a call is a ternary, not optional chaining", () => {
		expect(headOf("x = c ? (a).forEach(f) : 0")).toBe("(a)");
	});

	it("N3: a prefix `!` is negation, not a non-null assertion", () => {
		expect(headOf("y = !a.b.forEach(f)")).toBe("a.b");
		expect(headOf("if (c) !a.b.forEach(f)")).toBe("a.b");
	});

	it("N4: a `!` with no operand before it is not a link", () => {
		expect(headOf("x = c ? !(a).forEach(f) : 0")).toBe("(a)");
	});
});
