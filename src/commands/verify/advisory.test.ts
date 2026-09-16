// ===========================================
// advisory unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_SKIPS, JS_TS_EXTS, TOOL_IDS } from "./advisory.js";

describe("DEFAULT_ADVISORY_SKIPS", () => {
    it("keeps Python simplification advice outside the default gate", () => {
        expect(DEFAULT_ADVISORY_SKIPS.has("python_simplification")).toBe(true);
    });
	it("is a non-empty set", () => {
		expect(DEFAULT_ADVISORY_SKIPS.size).toBeGreaterThan(0);
	});

	it("includes the catch_and_log heuristic", () => {
		expect(DEFAULT_ADVISORY_SKIPS.has("catch_and_log")).toBe(true);
	});
});

describe("TOOL_IDS", () => {
	it("includes tsc + biome + semgrep", () => {
		expect(TOOL_IDS).toContain("tsc");
		expect(TOOL_IDS).toContain("biome");
		expect(TOOL_IDS).toContain("semgrep");
	});
});

describe("JS_TS_EXTS", () => {
	it("includes .ts and .tsx", () => {
		expect(JS_TS_EXTS.has(".ts")).toBe(true);
		expect(JS_TS_EXTS.has(".tsx")).toBe(true);
	});

	it("excludes python and rust extensions", () => {
		expect(JS_TS_EXTS.has(".py")).toBe(false);
		expect(JS_TS_EXTS.has(".rs")).toBe(false);
	});
});

// getEffectiveSkipChecks / getSkipTools moved to ./advisory-skips.ts —
// their tests live in advisory-skips.test.ts alongside.

describe("DEFAULT_ADVISORY_SKIPS — policy pins", () => {
	it("keeps cognitive_complexity advisory until FP calibration promotes it", () => {
		expect(DEFAULT_ADVISORY_SKIPS.has("cognitive_complexity")).toBe(true);
	});
});
