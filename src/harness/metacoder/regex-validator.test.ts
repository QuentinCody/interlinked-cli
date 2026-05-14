import { describe, expect, it } from "vitest";

import { DEFAULT_METACODER_CONFIG } from "./types.js";
import { validateOverlayPatternCount, validateOverlayRegex } from "./regex-validator.js";

describe("validateOverlayRegex", () => {
	it("accepts a normal anchored pattern with default flags", () => {
		expect(validateOverlayRegex("^src/legacy/payments/", "i", DEFAULT_METACODER_CONFIG)).toBeNull();
	});

	it("accepts empty flags", () => {
		expect(validateOverlayRegex("foo.bar", "", DEFAULT_METACODER_CONFIG)).toBeNull();
	});

	it("rejects empty patterns", () => {
		expect(validateOverlayRegex("", "i", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/empty/);
	});

	it("rejects patterns longer than the configured cap", () => {
		const oversize = "a".repeat(DEFAULT_METACODER_CONFIG.max_pattern_length + 1);
		const failure = validateOverlayRegex(oversize, "i", DEFAULT_METACODER_CONFIG);
		expect(failure?.reason).toMatch(/length/);
	});

	it("rejects the global flag (not in the i/m/s allowlist)", () => {
		expect(validateOverlayRegex("foo", "g", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/flag/);
	});

	it("rejects the sticky flag", () => {
		expect(validateOverlayRegex("foo", "y", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/flag/);
	});

	it("rejects the unicode flag", () => {
		expect(validateOverlayRegex("foo", "u", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/flag/);
	});

	it("rejects nested unbounded quantifiers (ReDoS shape)", () => {
		expect(validateOverlayRegex("^(a+)+$", "i", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/ReDoS|nested/);
		expect(validateOverlayRegex("(a*)*", "i", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/ReDoS|nested/);
		expect(validateOverlayRegex("(ab|c)*", "i", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/ReDoS|nested/);
	});

	it("rejects syntactically invalid regex", () => {
		expect(validateOverlayRegex("[unclosed", "i", DEFAULT_METACODER_CONFIG)?.reason).toMatch(/invalid/i);
	});

	it("treats undefined flags as empty", () => {
		expect(validateOverlayRegex("foo", undefined, DEFAULT_METACODER_CONFIG)).toBeNull();
	});
});

describe("validateOverlayPatternCount", () => {
	it("accepts counts at or below the cap", () => {
		expect(validateOverlayPatternCount(DEFAULT_METACODER_CONFIG.max_patterns_per_rule, DEFAULT_METACODER_CONFIG)).toBeNull();
	});

	it("rejects counts above the cap", () => {
		const failure = validateOverlayPatternCount(
			DEFAULT_METACODER_CONFIG.max_patterns_per_rule + 1,
			DEFAULT_METACODER_CONFIG,
		);
		expect(failure?.reason).toMatch(/patterns/);
	});

	it("accepts zero patterns", () => {
		expect(validateOverlayPatternCount(0, DEFAULT_METACODER_CONFIG)).toBeNull();
	});
});
