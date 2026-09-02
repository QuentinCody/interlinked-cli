// Unit tests for assertion-move.ts — the "is this removal really a MOVE"
// classifier GATE 2 (mutation_directed_assertion_removal) consults before it
// blocks.
//
//   Positive (MUST fire — the line stays classified as REMOVED):
//     P1  removed with nothing added in the edit
//     P2  same matcher, different expected value
//     P3  same expected value, different matcher
//     P4  `.not` modifier dropped — modifiers are part of the matcher identity
//     P5  multiset: two identical removals, one equivalent addition ⇒ one still removed
//     P6  unbalanced (multi-line) assertion opener only matches by exact text
//     P7  same low-entropy matcher + expected value, DIFFERENT subject — the
//         verdict's counter-example (`expect(killed).toBe(true)` paid for by
//         `expect(flag).toBe(true)` in an unrelated block) stays removed
//     P8  a renamed subject (`b` → `out.b`) is a rewrite, not a move
//   Negative (MUST NOT fire — the line is classified as MOVED):
//     N1  same subject + matcher + expected value, different spacing
//     N2  an it() case declaration re-added verbatim elsewhere
//     N3  nested call inside the expected value — the TERMINAL matcher is compared
//     N4  unbalanced opener re-added with identical text
//     N5  `resolves.` modifier retained on both sides

import { describe, expect, it } from "vitest";
import type { InlineMatch } from "../check-registry/types.js";
import { assertionSignature, partitionMovedAssertions } from "./assertion-move.js";

function m(text: string, line = 1): InlineMatch {
	return { line, text };
}

describe("assertionSignature", () => {
	it("keys an expect line by subject + terminal matcher + whitespace-normalized expected text", () => {
		expect(assertionSignature("expect(a).toBe(1);")).toBe("expect(a).toBe(1)");
		expect(assertionSignature("  expect( result.a ).toBe( 1 )")).toBe("expect(result.a).toBe(1)");
		expect(assertionSignature("expect(x).toEqual({ a: 1,   b: 2 });")).toBe("expect(x).toEqual({ a: 1, b: 2 })");
		expect(assertionSignature("expect.soft(x).toBe(1);")).toBe("expect(x).toBe(1)");
	});

	it("keeps .not / .resolves / .rejects modifiers as part of the matcher identity", () => {
		expect(assertionSignature("expect(a).not.toBe(1);")).toBe("expect(a).not.toBe(1)");
		expect(assertionSignature("await expect(p).resolves.toBe(1);")).toBe("expect(p).resolves.toBe(1)");
		expect(assertionSignature("await expect(p).rejects.toThrow(/boom/);")).toBe("expect(p).rejects.toThrow(/boom/)");
	});

	it("picks the terminal matcher, not a to*-named call inside the subject or the argument", () => {
		expect(assertionSignature("expect(a.toString()).toBe('1');")).toBe("expect(a.toString()).toBe('1')");
		expect(assertionSignature("expect(x).toEqual(y.toFixed(2));")).toBe("expect(x).toEqual(y.toFixed(2))");
	});

	it("falls back to exact normalized text when the subject's parens do not balance on the line", () => {
		expect(assertionSignature("expect(render({")).toBe("text:expect(render({");
	});

	it("keys a case-declaration line by its normalized text", () => {
		expect(assertionSignature('it("does  a thing", () => {')).toBe('case:it("does a thing", () => {');
	});

	it("falls back to exact normalized text for an unbalanced (multi-line) opener", () => {
		expect(assertionSignature("expect(x).toEqual({")).toBe("text:expect(x).toEqual({");
	});
});

describe("partitionMovedAssertions — positive (must fire)", () => {
	it("P1: a removal with nothing added stays removed", () => {
		const out = partitionMovedAssertions([m("expect(b).toBe(2);")], []);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});

	it("P2: same matcher but a different expected value is not a move", () => {
		const out = partitionMovedAssertions([m("expect(b).toBe(2);")], [m("expect(b).toBe(3);")]);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});

	it("P3: same expected value but a different matcher is not a move", () => {
		const out = partitionMovedAssertions([m("expect(b).toBe(2);")], [m("expect(b).toEqual(2);")]);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});

	it("P4: dropping the .not modifier is not a move", () => {
		const out = partitionMovedAssertions([m("expect(b).not.toBe(2);")], [m("expect(b).toBe(2);")]);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});

	it("P5: multiset — two identical removals, one equivalent addition ⇒ one still removed", () => {
		const out = partitionMovedAssertions(
			[m("expect(a).toBe(1);", 2), m("expect(a).toBe(1);", 5)],
			[m("expect( a ).toBe(1);", 9)],
		);
		expect(out.moved.map((x) => x.line)).toEqual([2]);
		expect(out.removed.map((x) => x.line)).toEqual([5]);
	});

	it("P6: an unbalanced opener with a different subject is not a move", () => {
		const out = partitionMovedAssertions([m("expect(x).toEqual({")], [m("expect(y).toEqual({")]);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});

	it("P7: a low-entropy literal re-asserted on a DIFFERENT subject does not pay for the removal", () => {
		const out = partitionMovedAssertions(
			[m("expect(killed).toBe(true);", 4), m("expect(report.survivors).toHaveLength(0);", 5)],
			[m("expect(flag).toBe(true);", 20), m("expect(list).toHaveLength(0);", 21)],
		);
		expect(out.removed.map((x) => x.line)).toEqual([4, 5]);
		expect(out.moved).toHaveLength(0);
	});

	it("P8: a renamed subject (b → out.b) is a rewrite, not a move", () => {
		const out = partitionMovedAssertions([m("expect(b).toBe(2);")], [m("expect(out.b).toBe(2);")]);
		expect(out.removed).toHaveLength(1);
		expect(out.moved).toHaveLength(0);
	});
});

describe("partitionMovedAssertions — negative (must not fire)", () => {
	it("N1: same subject + matcher + expected value with different spacing is a move", () => {
		const out = partitionMovedAssertions([m("expect(b).toBe(2);", 3)], [m("expect( b ).toBe( 2 )", 8)]);
		expect(out.moved.map((x) => x.line)).toEqual([3]);
		expect(out.removed).toHaveLength(0);
	});

	it("N2: an it() declaration re-added verbatim elsewhere is a move", () => {
		const out = partitionMovedAssertions([m('it("kills the survivor", () => {')], [m('it("kills the survivor", () => {')]);
		expect(out.moved).toHaveLength(1);
		expect(out.removed).toHaveLength(0);
	});

	it("N3: a nested call in the expected value compares by the terminal matcher", () => {
		const out = partitionMovedAssertions(
			[m("expect(x).toEqual(y.toFixed(2));")],
			[m("expect(x).toEqual( y.toFixed(2) );")],
		);
		expect(out.moved).toHaveLength(1);
		expect(out.removed).toHaveLength(0);
	});

	it("N4: an unbalanced opener re-added with identical text is a move", () => {
		const out = partitionMovedAssertions([m("expect(x).toEqual({")], [m("  expect(x).toEqual({")]);
		expect(out.moved).toHaveLength(1);
		expect(out.removed).toHaveLength(0);
	});

	it("N5: a resolves-modified assertion re-added with the modifier is a move", () => {
		const out = partitionMovedAssertions(
			[m("await expect(p).resolves.toBe(1);")],
			[m("await expect(p).resolves.toBe( 1 );")],
		);
		expect(out.moved).toHaveLength(1);
		expect(out.removed).toHaveLength(0);
	});
});
