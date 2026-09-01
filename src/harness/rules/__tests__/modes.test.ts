// ===========================================
// Phase C — Tiered Harness Modes
// ===========================================
// Operational tiers tied to provider hook timeouts. Distinct from the
// check-policy "mode" concept in src/harness/modes.ts (which governs
// per-check action overrides). These modes drive HARNESS_POST_TIMEOUT_MS
// and which heavy quality checks are enabled.

import { describe, expect, it } from "vitest";
import {
	BUDGET_MODE,
	CI_MODE,
	getModePreset,
	HARNESS_MODE_NAMES,
	isKnownMode,
	migrateLegacyMode,
	QUALITY_MODE,
} from "../modes.js";

describe("HarnessMode preset shape", () => {
	it("exposes three operational tiers in declaration order", () => {
		expect(HARNESS_MODE_NAMES).toEqual(["budget", "quality", "ci"]);
	});

	it("budget targets the 30 s Copilot CLI floor", () => {
		expect(BUDGET_MODE.name).toBe("budget");
		expect(BUDGET_MODE.post_timeout_ms).toBe(30_000);
		expect(BUDGET_MODE.description).toMatch(/copilot/i);
	});

	it("quality targets the 60 s default for Claude/Cursor/Gemini", () => {
		expect(QUALITY_MODE.name).toBe("quality");
		expect(QUALITY_MODE.post_timeout_ms).toBe(50_000);
		expect(QUALITY_MODE.description).toMatch(/claude|cursor|gemini/i);
	});

	it("ci unlocks the longer Codex / CI runner budget", () => {
		expect(CI_MODE.name).toBe("ci");
		expect(CI_MODE.post_timeout_ms).toBe(60_000);
		expect(CI_MODE.description).toMatch(/ci|codex/i);
	});
});

describe("HarnessMode quality_checks_enabled", () => {
	it("budget disables every heavy check", () => {
		// budget = no heavy checks enabled (only the always-on inline detectors)
		expect(BUDGET_MODE.quality_checks_enabled.structural_checks).toBe(false);
		expect(BUDGET_MODE.quality_checks_enabled.affected_tests).toBe(false);
		expect(BUDGET_MODE.quality_checks_enabled.prompt_injection).toBe(false);
		expect(BUDGET_MODE.quality_checks_enabled.semgrep).toBe(false);
	});

	it("quality enables structural_checks and affected_tests, leaves CI-only checks off", () => {
		expect(QUALITY_MODE.quality_checks_enabled.structural_checks).toBe(true);
		expect(QUALITY_MODE.quality_checks_enabled.affected_tests).toBe(true);
		expect(QUALITY_MODE.quality_checks_enabled.semgrep).toBe(true);
		// ci-only checks
		expect(QUALITY_MODE.quality_checks_enabled.prompt_injection).toBe(false);
	});

	it("ci enables every heavy check", () => {
		expect(CI_MODE.quality_checks_enabled.structural_checks).toBe(true);
		expect(CI_MODE.quality_checks_enabled.affected_tests).toBe(true);
		expect(CI_MODE.quality_checks_enabled.prompt_injection).toBe(true);
		expect(CI_MODE.quality_checks_enabled.semgrep).toBe(true);
	});
});

describe("getModePreset", () => {
	it("returns the matching preset", () => {
		expect(getModePreset("budget")).toBe(BUDGET_MODE);
		expect(getModePreset("quality")).toBe(QUALITY_MODE);
		expect(getModePreset("ci")).toBe(CI_MODE);
	});

});

describe("isKnownMode", () => {
	it("accepts the three operational tiers", () => {
		expect(isKnownMode("budget")).toBe(true);
		expect(isKnownMode("quality")).toBe(true);
		expect(isKnownMode("ci")).toBe(true);
	});

	it("rejects unknown / legacy / empty", () => {
		expect(isKnownMode("balanced")).toBe(false);
		expect(isKnownMode("strict")).toBe(false);
		expect(isKnownMode("lenient")).toBe(false);
		expect(isKnownMode("")).toBe(false);
		expect(isKnownMode("custom")).toBe(false);
	});
});

describe("migrateLegacyMode (auto-migration of `balanced` and friends)", () => {
	// Per the master plan's four-question Q&A: auto-migrate `balanced` to
	// `quality` for non-Copilot runners and to `budget` for Copilot CLI users.
	// `strict` and `lenient` from the old check-policy ModeName are not the
	// same concept; we treat them as legacy aliases for `quality` (the safe
	// default) and surface a CHANGELOG note on first invocation.
	it("maps balanced to quality on a non-Copilot runner", () => {
		expect(migrateLegacyMode("balanced", "claude-code")).toBe("quality");
		expect(migrateLegacyMode("balanced", "cursor")).toBe("quality");
		expect(migrateLegacyMode("balanced", "codex")).toBe("quality");
	});

	it("maps balanced to budget on Copilot CLI (30 s floor)", () => {
		expect(migrateLegacyMode("balanced", "copilot-cli")).toBe("budget");
	});

	it("returns the input unchanged when already a valid HarnessMode", () => {
		expect(migrateLegacyMode("budget", "copilot-cli")).toBe("budget");
		expect(migrateLegacyMode("quality", "claude-code")).toBe("quality");
		expect(migrateLegacyMode("ci", "codex")).toBe("ci");
	});

	it("falls back to quality on unrecognised legacy strings", () => {
		expect(migrateLegacyMode("strict", "claude-code")).toBe("quality");
		expect(migrateLegacyMode("lenient", "claude-code")).toBe("quality");
		expect(migrateLegacyMode("custom", "claude-code")).toBe("quality");
		expect(migrateLegacyMode(undefined, "claude-code")).toBe("quality");
	});
});
