import { describe, expect, it } from "vitest";
import { stripAllLiterals } from "../strip-helpers.js";
import { normalizeTarget } from "./test-discrimination-posneg.js";
import {
	buildTargetLiteralSets,
	collectTargetMembers,
	computeExpectedLiteralSet,
	isLiteralSubset,
	isTargetInvariantAcrossFile,
} from "./test-discrimination-posneg-literals.js";

function litSet(body: string): Set<string> {
	// Mirror the parent detector's contract: `bodyMasked` is always
	// `stripAllLiterals(bodyOriginal)`, offset-aligned.
	return computeExpectedLiteralSet(body, stripAllLiterals(body));
}

function members(body: string): Array<{ target: string; literal: string }> {
	return collectTargetMembers(stripAllLiterals(body), body, normalizeTarget);
}

describe("computeExpectedLiteralSet — positive (must fire / extract)", () => {
	it("P1: a bare toBe number literal is collected", () => {
		const set = litSet(`expect(parse(x)).toBe(-42);`);
		expect(set.has("num:-42")).toBe(true);
	});

	it("P2: a bare toEqual string literal is collected", () => {
		const set = litSet(`expect(parse(x)).toEqual("bad token");`);
		expect(Array.from(set).some((v) => v === 'str:"bad token"')).toBe(true);
	});

	it("P3: a toMatch regex literal is collected by its source text", () => {
		const set = litSet(`expect(msg).toMatch(/1\\/1/);`);
		expect(set.has("regex:/1\\/1/")).toBe(true);
	});

	it("P4: an empty array argument is collected as a distinct empty-array literal", () => {
		const set = litSet(`expect(compute(x)).toEqual([]);`);
		expect(set.has("arr:empty")).toBe(true);
	});

	it("P5: an empty object argument is collected as a distinct empty-object literal", () => {
		const set = litSet(`expect(compute(x)).toEqual({});`);
		expect(set.has("obj:empty")).toBe(true);
	});

	it("P6: boolean/null/undefined arguments are each collected", () => {
		const set = litSet(`
			expect(a).toBe(true);
			expect(b).toBe(null);
			expect(c).toBe(undefined);
		`);
		expect(set.has("bool:true")).toBe(true);
		expect(set.has("null")).toBe(true);
		expect(set.has("undefined")).toBe(true);
	});

	it("P7: a string literal nested one level inside a toEqual({...}) object argument is collected", () => {
		const set = litSet(`expect(coverageStep(tmp)).toEqual({ "src/foo.ts": { lines: 99 } });`);
		// The nested value is itself an object (two levels deep) so it does
		// NOT get flattened past one level — the outer key's value is skipped
		// because it isn't a plain literal, matching the "one level" contract.
		expect(set.has('str:"src/foo.ts"')).toBe(false);
	});

	it("P8: a number literal nested one level inside a toEqual({...}) object argument is collected", () => {
		const set = litSet(`expect(result).toEqual({ lines: 99, path: "x" });`);
		expect(set.has("num:99")).toBe(true);
		expect(set.has('str:"x"')).toBe(true);
	});

	it("P9: a string literal nested one level inside a toEqual([...]) array argument is collected", () => {
		const set = litSet(`expect(result).toEqual(["a", "b"]);`);
		expect(set.has('str:"a"')).toBe(true);
		expect(set.has('str:"b"')).toBe(true);
	});

	it("P10: a literal nested inside a toContain(...) object argument is collected", () => {
		const set = litSet(`expect(result).toContain({ id: 7 });`);
		expect(set.has("num:7")).toBe(true);
	});

	it("P11: a literal nested inside a toHaveBeenCalledWith(...) argument is collected", () => {
		const set = litSet(`expect(fn).toHaveBeenCalledWith({ id: 7 });`);
		expect(set.has("num:7")).toBe(true);
	});

	it("P12: isLiteralSubset is true when every element of the sub set is present in the sup set", () => {
		const sub = new Set(["num:1", "str:\"a\""]);
		const sup = new Set(["num:1", "str:\"a\"", "num:2"]);
		expect(isLiteralSubset(sub, sup)).toBe(true);
	});

	it("P13: buildTargetLiteralSets aggregates literals per exact target across all pairs", () => {
		const map = buildTargetLiteralSets([
			{ target: "runGuard", literal: "allow" },
			{ target: "runGuard", literal: "allow" },
			{ target: "runGuard", literal: "block" },
			{ target: "other", literal: "x" },
		]);
		expect(map.get("runGuard")).toEqual(new Set(["allow", "block"]));
		expect(map.get("other")).toEqual(new Set(["x"]));
	});

	it("P14: isTargetInvariantAcrossFile is true for a target with exactly one distinct literal", () => {
		const map = buildTargetLiteralSets([{ target: "runGuard", literal: "allow" }]);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(true);
	});

	it("P15: isTargetInvariantAcrossFile is true for a target never observed at all", () => {
		const map = buildTargetLiteralSets([{ target: "other", literal: "x" }]);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(true);
	});

	it("P16: collectTargetMembers collects a plain literal member for a direct call target", () => {
		const found = members(`expect(runGuard(cmd)).toBe("allow");`);
		expect(found).toEqual([{ target: "runGuard", literal: 'str:"allow"' }]);
	});

	it("P17: repeating the SAME literal on the same target yields the SAME member, so it stays invariant", () => {
		const found = members(`
			expect(runGuard(cmd)).toBe("allow");
			expect(runGuard(other)).toBe("allow");
		`);
		const map = buildTargetLiteralSets(found);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(true);
	});
});

describe("computeExpectedLiteralSet — negative (must not fire / must not extract)", () => {
	it("N1: a negated matcher chain (.not.toBe) contributes no literal", () => {
		const set = litSet(`expect(parse(x)).not.toBe(-42);`);
		expect(set.size).toBe(0);
	});

	it("N2: a literal nested two levels deep (object inside object) is not extracted", () => {
		const set = litSet(`expect(result).toEqual({ outer: { inner: 5 } });`);
		expect(set.has("num:5")).toBe(false);
	});

	it("N3: a variable argument (no literal shape) contributes nothing", () => {
		const set = litSet(`expect(parse(x)).toBe(someVariable);`);
		expect(set.size).toBe(0);
	});

	it("N4: a trivial-looking argument to a non-nested matcher outside toEqual/toMatchObject/toContain/toHaveBeenCalledWith is NOT nested-extracted", () => {
		const set = litSet(`expect(fn).toThrow({ code: 7 });`);
		expect(set.has("num:7")).toBe(false);
	});

	it("N5: isLiteralSubset is false when the sub set has an element the sup set lacks", () => {
		const sub = new Set(["num:1", "str:\"zz\""]);
		const sup = new Set(["num:1"]);
		expect(isLiteralSubset(sub, sup)).toBe(false);
	});

	it("N6: an empty sub set is always a subset, even of an empty sup set", () => {
		expect(isLiteralSubset(new Set(), new Set())).toBe(true);
	});

	it("N7: isTargetInvariantAcrossFile is false for a target asserted with two distinct literals", () => {
		const map = buildTargetLiteralSets([
			{ target: "runGuard", literal: "allow" },
			{ target: "runGuard", literal: "block" },
		]);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(false);
	});

	it("N8: a toBeNull() call on a target contributes a distinct <null> member, breaking invariance with a literal elsewhere", () => {
		const found = members(`
			expect(runGuard(cmd)).toBe("allow");
			expect(runGuard(disabled)).toBeNull();
		`);
		const map = buildTargetLiteralSets(found);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(false);
	});

	it("N9: a toBe(<variable>) call on a target contributes a distinct <expr:...> member, breaking invariance with a literal elsewhere", () => {
		const found = members(`
			expect(runGuard(cmd)).toBe("allow");
			expect(runGuard(cfg)).toBe(mode);
		`);
		const map = buildTargetLiteralSets(found);
		expect(isTargetInvariantAcrossFile("runGuard", map)).toBe(false);
	});

	it("N10: a negated (.not.) chain contributes no member at all", () => {
		const found = members(`expect(runGuard(cmd)).not.toBe("allow");`);
		expect(found).toEqual([]);
	});
});
