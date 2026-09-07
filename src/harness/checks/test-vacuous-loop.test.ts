import { describe, expect, it } from "vitest";
import { checkVacuousLoopAssertion } from "./test-vacuous-loop.js";

// `checkVacuousLoopAssertion` flags it()/test() blocks whose EVERY assertion
// executes inside a loop over a collection nothing proves non-empty — an
// empty collection makes the loop body never run, so a `return []`-shaped
// stub of the branch under test passes identically. See the module header in
// ./test-vacuous-loop.ts for the full CLASS / FIRES WHEN / DOES NOT FIRE /
// CALIBRATION contract this file's cases are labeled against.

function run(content: string, path = "widget.test.ts"): ReturnType<typeof checkVacuousLoopAssertion> {
	return checkVacuousLoopAssertion(content, path);
}

describe("checkVacuousLoopAssertion — positive (must fire)", () => {
	it("P1: for-of loop, unproven collection, sole assertion inside", () => {
		const found = run(`it("checks rows", () => { for (const r of getRows()) { expect(r.ok).toBe(true); } });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("vacuous_loop_assertion:");
	});

	it("P2: for-in loop over an unproven object", () => {
		const found = run(`it("checks keys", () => { for (const k in getMap()) { expect(k.length).toBeGreaterThan(0); } });`);
		expect(found).toHaveLength(1);
	});

	it("P3: .forEach() loop over an unproven collection", () => {
		const found = run(`it("checks items", () => { getItems().forEach((item) => { expect(item.valid).toBe(true); }); });`);
		expect(found).toHaveLength(1);
	});

	it("P4: C-style index for loop with an unproven .length bound", () => {
		const found = run(
			`it("checks all", () => { for (let i = 0; i < getRows().length; i++) { expect(getRows()[i].ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P5: multiple assertions, all inside the same unproven loop", () => {
		const found = run(
			`it("checks pairs", () => { for (const r of getRows()) { expect(r.ok).toBe(true); expect(r.id).toBeDefined(); } });`,
		);
		expect(found).toHaveLength(1);
	});

	it("P6: names the collection in the finding", () => {
		const found = run(`it("checks rows", () => { for (const r of getRows()) { expect(r.ok).toBe(true); } });`);
		expect(found[0]?.text).toContain("getRows()");
	});
});

describe("checkVacuousLoopAssertion — negative (must not fire)", () => {
	it("N1 (a): an assertion outside every loop keeps the block from qualifying", () => {
		const found = run(
			`it("checks rows", () => { expect(getRows()).toBeDefined(); for (const r of getRows()) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N2 (b): collection length pinned >=1 by a sibling test in the same file", () => {
		const found = run(
			`it("has rows", () => { expect(getRows()).toHaveLength(3); });\n` +
				`it("checks rows", () => { for (const r of getRows()) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N3 (b): collection length pinned via toBeGreaterThan(0)", () => {
		const found = run(
			`it("has rows", () => { expect(getRows().length).toBeGreaterThan(0); });\n` +
				`it("checks rows", () => { for (const r of getRows()) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N4 (c): loop target is a file-level non-empty literal array", () => {
		const found = run(
			`const ROWS = [1, 2, 3];\n` +
				`it("checks rows", () => { for (const r of ROWS) { expect(r).toBeGreaterThan(0); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N5 (c): inline non-empty array literal in the for-of head", () => {
		const found = run(`it("checks two", () => { for (const x of [1, 2]) { expect(x).toBeGreaterThan(0); } });`);
		expect(found).toHaveLength(0);
	});

	it("N6 (d): it.each row table is exempt (the table IS the loop)", () => {
		const found = run(
			`it.each([1, 2, 3])("checks %i", (n) => { for (const x of [n]) { expect(x).toBeGreaterThan(0); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N7 (e): the loop body itself throws on an unexpected shape", () => {
		const found = run(
			`it("checks rows", () => { for (const r of getRows()) { if (!r) throw new Error("bad row"); expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N8 (f): Map/Set iteration whose .size is pinned elsewhere in the file", () => {
		const found = run(
			`it("has entries", () => { expect(getEntries().size).toBeGreaterThanOrEqual(1); });\n` +
				`it("checks entries", () => { for (const [k, v] of getEntries()) { expect(v).toBeDefined(); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N9: a plain block with no loop at all never fires", () => {
		const found = run(`it("checks one", () => { expect(getRow()).toBeDefined(); });`);
		expect(found).toHaveLength(0);
	});

	it("N10: an assertion-free block never fires (a different check's territory)", () => {
		const found = run(`it("does nothing observable", () => { for (const r of getRows()) { touch(r); } });`);
		expect(found).toHaveLength(0);
	});

	it("N11: a block-wide expect.hasAssertions() guard exempts the block", () => {
		const found = run(
			`it("checks rows", () => { expect.hasAssertions(); for (const r of getRows()) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N12: an in-block if(C.length===0) throw guard exempts the block", () => {
		const found = run(
			`it("checks rows", () => { const rows = getRows(); if (rows.length === 0) throw new Error("empty"); for (const r of rows) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N13: one-hop alias — pinning the SOURCE collection exempts the derived one", () => {
		const found = run(
			`it("has out", () => { expect(out).toHaveLength(5); });\n` +
				`it("checks rows", () => { const rows = out.filter(isValid); for (const r of rows) { expect(r.ok).toBe(true); } });`,
		);
		expect(found).toHaveLength(0);
	});

	it("N14: a non-test file never fires even with the same shape", () => {
		const found = run(`it("checks rows", () => { for (const r of getRows()) { expect(r.ok).toBe(true); } });`, "widget.ts");
		expect(found).toHaveLength(0);
	});
});
