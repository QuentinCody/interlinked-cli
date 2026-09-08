import { describe, expect, it } from "vitest";
import { resolveScreenVersion } from "./package-version-range.js";

// Mutation-kill suite for src/harness/package-version-range.ts (wave pass1_w50).
// Every test targets a specific listed survivor mutant; see the brief packet
// at scratch/fleet-r3/w50-briefs/src_harness_package-version-range.ts.json.

describe("resolveScreenVersion — hyphen-range extra-dot-components probe", () => {
	// Baseline: with 5 numeric components the hyphen regex still captures the
	// FULL literal (its char class allows extra dots); normalizeVersionLiteral's
	// anchored ^...$ pattern then fails to fully match it (only 2 extra dot
	// groups allowed) and falls back to returning it RAW/unchanged.
	// This single input differentiates a large cluster of hyphen-regex mutants:
	// each one breaks the hyphen match (forcing the comparator-clause fallback,
	// which via FLOOR_LITERAL_RE's un-anchored partial match yields "1.2.3"
	// instead), producing a DIFFERENT value than the unmutated "1.2.3.4.5".
	// kills: f427cead3a551440, d1f2bd6519ec1391, 2700345fbf49f5f1, c74fbc2aa05456dd,
	// b896884ff18166ed, e5584c87ee485762, 70a3970041e48598, 014adb37c5d939fd, b14aa2d8ad1438b5.
	// test-contract: public-api — resolveScreenVersion(range) must resolve the npm hyphen-range floor via the LEFT endpoint literal (module doc: "An npm hyphen range floors at its left endpoint").
	it("preserves the full un-normalizable literal via the hyphen path and accepts a bare right-hand endpoint", () => {
		expect(resolveScreenVersion("1.2.3.4.5 - 9.0.0")).toBe("1.2.3.4.5");
	});

	// test-contract: public-api — the hyphen-range left-endpoint capture must
	// keep an optional Go-style `v` prefix (module doc comment); kills de0071c9ffc5bf5b.
	it("v-prefixed literal still resolves via the hyphen path, not the comparator fallback", () => {
		expect(resolveScreenVersion("v1.2.3.4.5 - 9.0.0")).toBe("v1.2.3.4.5");
	});

	// test-contract: public-api — the hyphen separator tolerates any amount of
	// surrounding whitespace ("1.2.3 - 2.3.4" doc example); kills 4f48c55d2615219f.
	it("two spaces before the dash are still accepted (\\s+, not a single \\s)", () => {
		expect(resolveScreenVersion("1.2.3.4.5  - 9.0.0")).toBe("1.2.3.4.5");
	});

	// test-contract: public-api — the hyphen separator tolerates any amount of
	// surrounding whitespace; kills 117f169f5cec4e36.
	it("two spaces after the dash are still accepted (\\s+, not a single \\s)", () => {
		expect(resolveScreenVersion("1.2.3.4.5 -  9.0.0")).toBe("1.2.3.4.5");
	});

	// test-contract: public-api — the hyphen range's right endpoint also
	// accepts a `v`-prefixed version; kills b8395f5b6ce686e9.
	it("right-hand endpoint WITH a v prefix is still accepted ([vV]? not negated)", () => {
		expect(resolveScreenVersion("1.2.3.4.5 - v9.0.0")).toBe("1.2.3.4.5");
	});
});

describe("resolveScreenVersion — hyphen anchoring / prefix probes", () => {
	// test-contract: public-api — the hyphen-range regex must anchor at the
	// start of the range string, never match starting mid-string; kills 2fe2303e131d019b.
	it("a garbage leading char with no whitespace before it must NOT let the hyphen regex match mid-string (^ anchor required)", () => {
		// Without the leading ^ anchor, the regex could match starting at index 1
		// (skipping the stray "x"), wrongly treating "1.2.3 - 2.0.0" as a hyphen
		// range and returning "1.2.3" instead of falling through to the
		// comparator-clause scan, which picks up the later bare "2.0.0" token.
		expect(resolveScreenVersion("x1.2.3 - 2.0.0")).toBe("2.0.0");
	});
});

describe("resolveScreenVersion — comparator-clause fallback regexes", () => {
	// test-contract: public-api — resolveScreenVersion returns null when no
	// clause supplies a lower-bound literal (module doc: "Returns null when
	// the range has no lower bound"); kills 92be11704451686c.
	it("FLOOR_LITERAL_RE must not match a floor literal that doesn't start the clause (^ anchor required)", () => {
		// ">=x1.2.3": after stripping ">=" the remainder is "x1.2.3", which does
		// not start with a version literal, so no floor is found -> null.
		expect(resolveScreenVersion(">=x1.2.3")).toBeNull();
	});

	// test-contract: public-api — a bare multi-digit-major version clause must
	// resolve to itself as the floor; kills 42034d0759ec6ab5.
	it("FLOOR_LITERAL_RE major-version group must accept multi-digit majors (\\d+, not \\d)", () => {
		expect(resolveScreenVersion("42.0.0")).toBe("42.0.0");
	});

	// test-contract: public-api — RANGE_OP_RE must only recognize a comparator
	// operator anchored at the clause's own start; kills 636ad31fa1d4bb49.
	it("RANGE_OP_RE must only match an operator at the START of the clause (^ anchor required)", () => {
		// Without the ^ anchor, RANGE_OP_RE finds the "~" INSIDE the clause and
		// mis-slices from the front, corrupting the floor-literal scan and
		// yielding null instead of the correct floor "1.2.3".
		expect(resolveScreenVersion("1.2.3~4.5.6")).toBe("1.2.3");
	});

	// test-contract: public-api — a bare multi-digit minor/patch version clause
	// must resolve to itself as the floor; kills 7aa0a16d17e9607c.
	it("FLOOR_LITERAL_RE's minor/patch groups must accept multi-digit values ({0,2} of \\.\\d+, not \\.\\d)", () => {
		expect(resolveScreenVersion("1.23.45")).toBe("1.23.45");
	});
});

describe("resolveScreenVersion — normalizeVersionLiteral (major.minor.patch padding)", () => {
	// test-contract: public-api — a bare multi-digit-major floor must pad to
	// major.0.0 with the major preserved intact; kills 8052ebd94021c01c.
	it("major-version group in the pad regex must accept multi-digit majors (\\d+, not \\d)", () => {
		expect(resolveScreenVersion("42 - 100")).toBe("42.0.0");
	});

	// test-contract: public-api — a 2-component floor (major.minor) must pad
	// its missing patch to .0, keeping the minor value in the minor slot;
	// kills b184ceb1b62b49ad.
	it("a 2-component literal (major.minor, multi-digit minor) must pad as major.minor.0, not major.0.minor", () => {
		expect(resolveScreenVersion("1.23 - 2.0.0")).toBe("1.23.0");
	});

	// test-contract: public-api — a prerelease/build suffix on a bare-major
	// floor must be preserved in full when padding to major.minor.patch;
	// kills 447b654e5adcdd84.
	it("a multi-char prerelease/build suffix must be captured in full ([-+].*, not [-+].)", () => {
		expect(resolveScreenVersion("1-rc1 - 2.0.0")).toBe("1.0.0-rc1");
	});

	// test-contract: invariant — the pad regex's patch group must require
	// digits, so a non-numeric trailing segment fails the whole match and
	// falls back to the raw literal, per normalizeVersionLiteral's documented
	// "if (!m) return lit" fallback; kills 17506e29b421def9.
	it("the patch group must require DIGITS (\\d+), not accept non-digits (\\D+), when shifted into the patch slot", () => {
		// "1.abc" has no valid minor (non-digit), so the minor group is skipped;
		// under the mutant the mutated patch group's \\D+ would then greedily
		// consume ".abc" as a bogus "patch", succeeding and padding minor to 0.
		// The correct regex requires digits there and the whole match fails,
		// so the literal is returned unchanged.
		expect(resolveScreenVersion("1.abc - 2.0.0")).toBe("1.abc");
	});

	// test-contract: boundary — a literal with a stray extra dot-component
	// exceeds normalizeVersionLiteral's major.minor.patch(+suffix) grammar and
	// must be returned unchanged, not silently truncated; kills b81222bb8e9a2418.
	it("the trailing $ anchor must reject a literal with a stray extra dot-component", () => {
		// "1.2.3.4" has one dot-component too many for normalizeVersionLiteral's
		// major.minor.patch(+suffix) grammar; with the $ anchor in place the
		// match fails and the literal is returned unchanged.
		expect(resolveScreenVersion("1.2.3.4 - 2.0.0")).toBe("1.2.3.4");
	});

	// test-contract: invariant — the pad regex must anchor at the literal's
	// own start, never match starting mid-literal; kills 7c611eed8bf1c889.
	it("the leading ^ anchor must not let the pad regex match starting mid-literal", () => {
		expect(resolveScreenVersion("1v2.3 - v2.0.0")).toBe("1v2.3");
	});

	// test-contract: bug — normalizeVersionLiteral's `if (!m) return lit` guard
	// must actually run for an unmatched literal instead of falling through to
	// destructure `null`, which would throw; kills b7b91bbe6d082072.
	it("an unmatched literal must return early (!m), not fall through to destructuring null", () => {
		// If the `!m` guard were replaced by `false`, this call would throw a
		// TypeError trying to destructure `null` instead of returning the raw
		// literal — asserting a normal return value proves the guard still runs.
		expect(() => resolveScreenVersion("1.2.3.4 - 2.0.0")).not.toThrow();
		expect(resolveScreenVersion("1.2.3.4 - 2.0.0")).toBe("1.2.3.4");
	});
});
