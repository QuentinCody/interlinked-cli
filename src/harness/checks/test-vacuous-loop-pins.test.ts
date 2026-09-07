import { describe, expect, it } from "vitest";
import {
	blockHasLengthThrowGuard,
	blockHasWideGuard,
	classifyTarget,
	fileAliasBases,
	fileLiteralCollections,
	isProvenNonEmpty,
	loopBodyHasThrowOrFail,
} from "./test-vacuous-loop-pins.js";

// Unit coverage for the "is C proven non-empty" helpers behind
// `checkVacuousLoopAssertion` (./test-vacuous-loop.ts). Integration-level
// FIRES/DOES-NOT-FIRE behavior is covered by that module's own companion;
// this file exercises each pin/proof SHAPE directly.

describe("isProvenNonEmpty — positive (a pin proves the target)", () => {
	it("mapped collection pins preserve source cardinality with nested callbacks", () => {
		expect(isProvenNonEmpty('expect(rows.map((r) => format(r.id))).toStrictEqual(["one"]);', "rows", new Map())).toBe(true);
		expect(isProvenNonEmpty('const expected = ["one"]; expect(rows.map(r => r.id)).toEqual(expected);', "rows", new Map())).toBe(true);
	});
	it("P1: expect(C).toHaveLength(n>=1)", () => {
		expect(isProvenNonEmpty("expect(rows).toHaveLength(3);", "rows", new Map())).toBe(true);
	});

	it("P2: expect(C.length).toBe(n>=1)", () => {
		expect(isProvenNonEmpty("expect(rows.length).toBe(2);", "rows", new Map())).toBe(true);
	});

	it("P3: expect(C.size).toBeGreaterThanOrEqual(1) — Map/Set", () => {
		expect(isProvenNonEmpty("expect(entries.size).toBeGreaterThanOrEqual(1);", "entries", new Map())).toBe(true);
	});

	it("P4: expect(C).not.toEqual([])", () => {
		expect(isProvenNonEmpty("expect(rows).not.toEqual([]);", "rows", new Map())).toBe(true);
	});

	it("P5: expect(C).toEqual([non-empty])", () => {
		expect(isProvenNonEmpty("expect(rows).toEqual([1, 2]);", "rows", new Map())).toBe(true);
	});

	it("P6: one-hop alias resolves through to a pinned base", () => {
		const aliasBases = new Map([["rows", "out"]]);
		expect(isProvenNonEmpty("expect(out).toHaveLength(5);", "rows", aliasBases)).toBe(true);
	});

	it("P7: expect([...C]).toEqual([non-empty]) pins C via the spread wrapper", () => {
		expect(isProvenNonEmpty("expect([...LABELS]).toEqual(['a', 'b']);", "LABELS", new Map())).toBe(true);
	});
});

describe("isProvenNonEmpty — negative (nothing pins the target)", () => {
	it("an empty mapped result and zero assertion count do not guarantee execution", () => {
		expect(isProvenNonEmpty('expect(rows.map(r => r.id)).toEqual([]);', "rows", new Map())).toBe(false);
		expect(blockHasWideGuard("expect.assertions(0);")).toBe(false);
	});
	it("N1: no matching assertion anywhere", () => {
		expect(isProvenNonEmpty("expect(other).toHaveLength(3);", "rows", new Map())).toBe(false);
	});

	it("N2: toHaveLength(0) does not prove non-empty", () => {
		expect(isProvenNonEmpty("expect(rows).toHaveLength(0);", "rows", new Map())).toBe(false);
	});
});

describe("classifyTarget", () => {
	it("marks an inline non-empty array literal as provenSafe", () => {
		expect(classifyTarget("[1, 2]", new Map()).provenSafe).toBe(true);
	});

	it("does not mark an empty array literal as provenSafe", () => {
		expect(classifyTarget("[]", new Map()).provenSafe).toBe(false);
	});

	it("resolves Object.entries(<file-level literal>) via the literal map", () => {
		const literals = new Map([["OBJ", true]]);
		expect(classifyTarget("Object.entries(OBJ)", literals).provenSafe).toBe(true);
	});

	it("falls through to the plain collapsed identifier for a bare expression", () => {
		expect(classifyTarget("getRows()", new Map()).key).toBe("getRows()");
	});

	it("strips a trailing `as const` cast before testing for an inline array literal", () => {
		expect(classifyTarget("[1, 2] as const", new Map()).provenSafe).toBe(true);
	});

	it("strips a trailing `as Foo[]` cast before testing for an inline array literal", () => {
		expect(classifyTarget("[1, 2] as Foo[]", new Map()).provenSafe).toBe(true);
	});

	it("recognizes a NESTED non-empty array literal", () => {
		expect(classifyTarget("[[1, 2], [3, 4]]", new Map()).provenSafe).toBe(true);
	});
});

describe("fileLiteralCollections", () => {
	it("records a non-empty array literal binding", () => {
		expect(fileLiteralCollections("const ROWS = [1, 2, 3];").get("ROWS")).toBe(true);
	});

	it("records an empty array literal binding as non-empty=false", () => {
		expect(fileLiteralCollections("const ROWS = [];").get("ROWS")).toBe(false);
	});

	it("records a non-empty new Set([...]) binding", () => {
		expect(fileLiteralCollections("const S = new Set([1]);").get("S")).toBe(true);
	});

	it("records an empty new Map() binding as non-empty=false", () => {
		expect(fileLiteralCollections("const M = new Map();").get("M")).toBe(false);
	});
});

describe("fileAliasBases", () => {
	it("records a one-hop alias to a call's head identifier", () => {
		expect(fileAliasBases("const rows = out.filter(isValid);").get("rows")).toBe("out");
	});

	it("does not record an alias for a non-identifier RHS", () => {
		expect(fileAliasBases("const rows = [];").has("rows")).toBe(false);
	});
});

describe("guard helpers", () => {
	it("blockHasWideGuard: expect.hasAssertions() exempts the block", () => {
		expect(blockHasWideGuard("expect.hasAssertions(); for (const r of rows) { expect(r); }")).toBe(true);
	});

	it("blockHasWideGuard: absent when no guard call is present", () => {
		expect(blockHasWideGuard("for (const r of rows) { expect(r); }")).toBe(false);
	});

	it("blockHasLengthThrowGuard: recognizes an if(C.length===0) throw guard", () => {
		expect(blockHasLengthThrowGuard("if (rows.length === 0) throw new Error('empty');", "rows")).toBe(true);
	});

	it("loopBodyHasThrowOrFail: recognizes a throw inside the loop body", () => {
		expect(loopBodyHasThrowOrFail("if (!r) throw new Error('bad');")).toBe(true);
	});

	it("loopBodyHasThrowOrFail: false when the body has no throw/expect.fail", () => {
		expect(loopBodyHasThrowOrFail("expect(r.ok).toBe(true);")).toBe(false);
	});
});
