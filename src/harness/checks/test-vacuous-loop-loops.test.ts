import { describe, expect, it } from "vitest";
import { findLoopSpans, innermostLoopIndex } from "./test-vacuous-loop-loops.js";

// Unit coverage for the loop-span extraction helpers behind
// `checkVacuousLoopAssertion` (./test-vacuous-loop.ts). Integration-level
// FIRES/DOES-NOT-FIRE behavior is covered by that module's own companion;
// this file exercises `findLoopSpans` / `innermostLoopIndex` directly so
// each recognized loop SHAPE has its own case independent of the outer
// assertion-classification logic.

describe("findLoopSpans — positive (must recognize the shape)", () => {
	it("P1: for-of loop", () => {
		const spans = findLoopSpans("for (const r of getRows()) { expect(r.ok); }");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("getRows()");
	});

	it("P2: for-in loop", () => {
		const spans = findLoopSpans("for (const k in getMap()) { touch(k); }");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("getMap()");
	});

	it("P3: destructured for-of loop", () => {
		const spans = findLoopSpans("for (const [k, v] of getEntries()) { touch(v); }");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("getEntries()");
	});

	it("P4: .forEach() arrow callback", () => {
		const spans = findLoopSpans("getItems().forEach((item) => { touch(item); });");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("getItems()");
	});

	it("P5: .every() arrow callback", () => {
		const spans = findLoopSpans("rows.every((r) => { touch(r); return true; });");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("rows");
	});

	it("P6: C-style index for loop bound by .length", () => {
		const spans = findLoopSpans("for (let i = 0; i < getRows().length; i++) { touch(i); }");
		expect(spans).toHaveLength(1);
		expect(spans[0]?.targetRaw).toBe("getRows()");
	});

	it("P7: single-statement (brace-less) for-of body", () => {
		const spans = findLoopSpans("for (const r of getRows()) touch(r);");
		expect(spans).toHaveLength(1);
	});
});

describe("findLoopSpans — negative (must not misfire)", () => {
	it("N1: no loop construct present", () => {
		expect(findLoopSpans("touch(getRows());")).toHaveLength(0);
	});

	it("N2: a plain (non-loop) .map() call with no arrow/function callback isn't matched as a fresh loop shape", () => {
		// `.map(fn)` where `fn` is a bare identifier reference (not an inline
		// arrow/function) carries no BODY SPAN to scope assertions into, so it
		// is correctly not recognized as a loop by this detector.
		expect(findLoopSpans("rows.map(fn);")).toHaveLength(0);
	});
});

describe("innermostLoopIndex", () => {
	it("resolves the INNERMOST of two nested loop spans", () => {
		const outer = "for (const a of A) { for (const b of B) { touch(b); } }";
		const spans = findLoopSpans(outer);
		expect(spans.length).toBeGreaterThanOrEqual(2);
		const innerCallIdx = outer.indexOf("touch(b)");
		const idx = innermostLoopIndex(innerCallIdx, spans);
		expect(spans[idx]?.targetRaw).toBe("B");
	});

	it("returns -1 when the offset is outside every span", () => {
		const spans = findLoopSpans("for (const r of getRows()) { touch(r); }");
		expect(innermostLoopIndex(0, spans)).toBe(-1);
	});
});
