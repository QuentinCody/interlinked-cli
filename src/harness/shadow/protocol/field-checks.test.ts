import { describe, expect, it } from "vitest";
import {
	checkArray,
	checkBool,
	checkBoundedString,
	checkBoundedText,
	checkEnum,
	checkGitSha,
	checkLiteral,
	checkNoUnknownKeys,
	checkOpaqueId,
	checkRfc3339,
	checkSafeNonNegInt,
	checkSha256Hex,
	firstReason,
	isRecord,
	MAX_ID_BYTES,
	unknownKeysIn,
} from "./field-checks.js";

const HEX64 = "a".repeat(64);
const SHA40 = "b".repeat(40);

describe("field-checks — positive (must accept)", () => {
	it("P1: accepts a bounded non-empty string, an opaque id, a sha, a git sha and a timestamp", () => {
		expect(checkBoundedString("detail", "x")).toBeNull();
		expect(checkOpaqueId("sess_01ABC-def.~", "x")).toBeNull();
		expect(checkSha256Hex(HEX64, "x")).toBeNull();
		expect(checkGitSha(SHA40, "x")).toBeNull();
		expect(checkRfc3339("2026-09-03T00:00:00Z", "x")).toBeNull();
		expect(checkRfc3339("2026-09-03T00:00:00.123+02:00", "x")).toBeNull();
	});

	it("P2: accepts empty TEXT (an empty Write) but not an empty STRING", () => {
		expect(checkBoundedText("", "x")).toBeNull();
		expect(checkBoundedString("", "x")).not.toBeNull();
	});

	it("P3: accepts zero and safe integers, arrays within bound, booleans, enums and literals", () => {
		expect(checkSafeNonNegInt(0, "x")).toBeNull();
		expect(checkSafeNonNegInt(7, "x", 7)).toBeNull();
		expect(checkArray([1, 2], "x", 2)).toBeNull();
		expect(checkBool(false, "x")).toBeNull();
		expect(checkEnum("W", ["W", "D"], "x")).toBeNull();
		expect(checkLiteral(1, 1, "x")).toBeNull();
	});

	it("P4: unknownKeysIn reports nothing when every key is declared", () => {
		expect(unknownKeysIn({ a: 1, b: 2 }, ["a", "b", "c"])).toEqual([]);
		expect(checkNoUnknownKeys({ a: 1 }, ["a"], "x")).toBeNull();
	});
});

describe("field-checks — negative (must reject)", () => {
	it("N1: rejects an empty-string brand, an over-long id, and a non-URL-safe id", () => {
		expect(checkOpaqueId("", "x")).toContain("opaque");
		expect(checkOpaqueId("a".repeat(MAX_ID_BYTES + 1), "x")).not.toBeNull();
		expect(checkOpaqueId("has/slash", "x")).not.toBeNull();
		expect(checkOpaqueId("-leading-dash", "x")).not.toBeNull();
	});

	it("N2: rejects uppercase, short and non-hex digests", () => {
		expect(checkSha256Hex(HEX64.toUpperCase(), "x")).not.toBeNull();
		expect(checkSha256Hex("abc", "x")).not.toBeNull();
		expect(checkGitSha(HEX64, "x")).not.toBeNull();
	});

	it("N3: rejects out-of-range integers — negative, fractional, unsafe, over max", () => {
		expect(checkSafeNonNegInt(-1, "x")).not.toBeNull();
		expect(checkSafeNonNegInt(1.5, "x")).not.toBeNull();
		expect(checkSafeNonNegInt(Number.MAX_SAFE_INTEGER + 2, "x")).not.toBeNull();
		expect(checkSafeNonNegInt(9, "x", 8)).toContain("exceeds");
	});

	it("N4: rejects lone surrogates in both string and text", () => {
		expect(checkBoundedString("\uD800", "x")).toContain("well-formed");
		expect(checkBoundedText("\uDC00", "x")).toContain("well-formed");
	});

	it("N5: rejects unknown keys, malformed timestamps and non-arrays", () => {
		expect(checkNoUnknownKeys({ a: 1, zz: 2, yy: 3 }, ["a"], "obj")).toContain("yy, zz");
		expect(checkRfc3339("2026-13-40T99:00:00Z", "x")).not.toBeNull();
		expect(checkRfc3339("yesterday", "x")).not.toBeNull();
		expect(checkArray("nope", "x", 4)).toContain("array");
		expect(checkArray([1, 2, 3], "x", 2)).toContain("exceeds");
	});

	it("N7: measures BYTES, not JavaScript characters (review 2026-09-04)", () => {
		// 600k two-byte characters = 1.2 MB of UTF-8 but only 600k UTF-16 units:
		// a character count let a payload 20% over the cap through.
		const twoByte = "é".repeat(600_000);
		expect(twoByte.length).toBeLessThan(1_000_000);
		expect(checkBoundedText(twoByte, "x", 1_000_000)).toContain("bytes");
		expect(checkBoundedString(twoByte, "x", 1_000_000)).toContain("bytes");
		// a four-byte character counts as four
		expect(checkBoundedText("\u{1F600}", "x", 3)).toContain("bytes");
		expect(checkBoundedText("\u{1F600}", "x", 4)).toBeNull();
	});

	it("N8: rejects a timestamp that parses as a shape but is not a real instant", () => {
		for (const stamp of [
			"2026-02-30T12:00:00Z", // February has 30 days in no year
			"2025-02-29T12:00:00Z", // 2025 is not a leap year
			"2026-13-01T12:00:00Z", // month 13
			"2026-00-10T12:00:00Z", // month 0
			"2026-01-00T12:00:00Z", // day 0
			"2026-01-32T12:00:00Z", // day 32
			"2026-01-01T24:00:00Z", // hour 24
			"2026-01-01T12:60:00Z", // minute 60
			"2026-01-01T12:00:60Z", // second 60 (leap seconds are not accepted)
			"2026-01-01T12:00:00+24:00", // offset hour 24
			"2026-01-01T12:00:00+00:60", // offset minute 60
		]) {
			expect(checkRfc3339(stamp, "x"), stamp).not.toBeNull();
		}
	});

	it("P5: accepts real calendar edges, including a leap day and a maximal offset", () => {
		for (const stamp of ["2028-02-29T00:00:00Z", "2026-12-31T23:59:59Z", "2026-01-01T00:00:00-23:59"]) {
			expect(checkRfc3339(stamp, "x"), stamp).toBeNull();
		}
	});

	it("N6: isRecord rejects arrays and null; firstReason returns the first failure", () => {
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord({})).toBe(true);
		expect(firstReason(null, "second", "third")).toBe("second");
		expect(firstReason(null, null)).toBeNull();
	});
});
