import { describe, expect, it } from "vitest";
import {
	getPath,
	matchesClause,
	parseWhereClause,
	recordTimestampMs,
	resolveTimeBound,
	stringifyValue,
} from "./filters.js";

describe("parseWhereClause — whitespace trimming", () => {
	// test-contract: public-api — path segment must be trimmed of surrounding whitespace
	it("trims whitespace off the path", () => {
		expect(parseWhereClause(" key =x")).toEqual({ path: "key", op: "=", value: "x" });
	});

	// test-contract: public-api — value segment must be trimmed of surrounding whitespace
	it("trims whitespace off the value", () => {
		expect(parseWhereClause("key= val ")).toEqual({ path: "key", op: "=", value: "val" });
	});
});

describe("getPath — null-guarded array/object walk", () => {
	// test-contract: boundary — stepInto must not treat null as an indexable object
	it("does not throw when a path segment resolves to null", () => {
		expect(() => getPath({ a: null }, "a.b")).not.toThrow();
		expect(getPath({ a: null }, "a.b")).toEqual([]);
	});
});

describe("stringifyValue — undefined fallthrough", () => {
	// test-contract: public-api — the object branch must not swallow non-object values into JSON.stringify
	it("renders undefined as the string \"undefined\", not JSON.stringify's undefined", () => {
		expect(stringifyValue(undefined)).toBe("undefined");
	});
});

describe("matchesClause — vacuous quantifier for = / ~= / numeric ops", () => {
	// test-contract: invariant — no matching values must fail "=", not vacuously pass
	it("returns false for '=' when the path resolves to nothing", () => {
		expect(matchesClause({}, parseWhereClause("missing=x"))).toBe(false);
	});

	// test-contract: invariant — no matching values must fail "~=", not vacuously pass
	it("returns false for '~=' when the path resolves to nothing", () => {
		expect(matchesClause({}, parseWhereClause("missing~=x"))).toBe(false);
	});

	// test-contract: invariant — no matching values must fail numeric ops, not vacuously pass
	it("returns false for numeric ops when the path resolves to nothing", () => {
		expect(matchesClause({}, parseWhereClause("missing>5"))).toBe(false);
	});

	// test-contract: invariant — "!=" must be true only when every present value differs
	it("returns true for '!=' when the sole present value genuinely differs", () => {
		expect(matchesClause({ type: "foo" }, parseWhereClause("type!=bar"))).toBe(true);
	});
});

describe("compareNumeric — via matchesClause numeric operators", () => {
	// test-contract: public-api — string-typed numeric values must be coerced, not rejected as non-finite
	it("coerces a string-typed numeric field before comparing", () => {
		expect(matchesClause({ count: "7" }, parseWhereClause("count>5"))).toBe(true);
	});

	// test-contract: boundary — Infinity must be rejected by the finite guard
	it("rejects a non-finite (Infinity) field", () => {
		expect(matchesClause({ count: Infinity }, parseWhereClause("count>5"))).toBe(false);
	});

	// test-contract: boundary — strict ">" must be false when the value is below the bound
	it("'>' is false when value is below bound", () => {
		expect(matchesClause({ count: 3 }, parseWhereClause("count>5"))).toBe(false);
	});

	// test-contract: boundary — strict ">" must be false (not >=) at exact equality
	it("'>' is false at exact equality with the bound", () => {
		expect(matchesClause({ count: 5 }, parseWhereClause("count>5"))).toBe(false);
	});

	// test-contract: boundary — ">=" must be false when value is below bound (not swallowed by "<")
	it("'>=' is false when value is below bound", () => {
		expect(matchesClause({ count: 3 }, parseWhereClause("count>=5"))).toBe(false);
	});

	// test-contract: boundary — strict "<" must be false (not <=) at exact equality
	it("'<' is false at exact equality with the bound", () => {
		expect(matchesClause({ count: 5 }, parseWhereClause("count<5"))).toBe(false);
	});

	// test-contract: boundary — strict "<" must be true when value is below bound
	it("'<' is true when value is below bound", () => {
		expect(matchesClause({ count: 3 }, parseWhereClause("count<5"))).toBe(true);
	});
});

describe("resolveTimeBound — anchored duration regex", () => {
	const now = Date.parse("2026-07-24T12:00:00Z");

	// test-contract: boundary — the regex must be start-anchored; leading garbage must not parse as a duration
	it("rejects a spec with leading garbage before the duration", () => {
		expect(() => resolveTimeBound("abc2h", now)).toThrow(/Invalid --since/);
	});

	// test-contract: boundary — the regex must be end-anchored; trailing garbage must not parse as a duration
	it("rejects a spec with trailing garbage after the duration", () => {
		expect(() => resolveTimeBound("2hxx", now)).toThrow(/Invalid --since/);
	});

	// test-contract: boundary — multi-digit magnitudes must be accepted
	it("accepts a multi-digit duration magnitude", () => {
		expect(resolveTimeBound("10h", now)).toBe(now - 10 * 3600 * 1000);
	});

	// test-contract: boundary — whitespace between magnitude and unit must be accepted
	it("accepts whitespace between magnitude and unit", () => {
		expect(resolveTimeBound("2 h", now)).toBe(now - 2 * 3600 * 1000);
	});

	// test-contract: public-api — the spec must be trimmed before matching
	it("accepts a duration with surrounding whitespace", () => {
		expect(resolveTimeBound(" 2h ", now)).toBe(now - 2 * 3600 * 1000);
	});
});

describe("recordTimestampMs — string-only guard", () => {
	// test-contract: boundary — a non-string ts (e.g. a Date object whose toString() is itself parseable) must be rejected
	it("rejects a non-string ts field even when it would stringify to a parseable date", () => {
		const d = new Date("2026-07-24T00:00:00Z");
		// SAFETY: deliberately passing a non-string ts to exercise the runtime typeof guard.
		expect(recordTimestampMs({ ts: d })).toBeUndefined();
		// Pin the non-default outcome in the same block: a string ts with the SAME
		// wall-clock instant must resolve, ruling out a stub that always returns
		// undefined regardless of the value's type.
		expect(recordTimestampMs({ ts: d.toISOString() })).toBe(Date.parse("2026-07-24T00:00:00Z"));
	});
});
