import { wireAbsentOptional, parseWire, wireBoolean, wireObject, wireOptional, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// Mode/wizard posture — composed writer → loader pins (review 2026-08-30 P0)
// ===========================================
// The defect class: `interlinked mode` and the setup wizard WROTE their guard
// posture to the committed guard-rules.json, but the team merge tier refused
// every one of those sections — lenient, balanced, and strict wrote different
// JSON that all LOADED identically. Disk-only assertions cannot catch this,
// so every pin here goes through the real writer AND the real loadRules().

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRules } from "../harness/rules-loader.js";
import { postureEnumChecks } from "./doctor-posture.js";
import { writeMode } from "./mode.js";
import { writeDeadCodeConfig, writeScopeConfig } from "./setup-wizard.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "il-posture-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

/** The four posture facts a loaded config exposes, as one comparable shape. */
function loadedPosture(dir: string) {
	const rules = loadRules(dir);
	const structural = parseWire(rules.structural_checks, wireObject({ "test_first": wireAbsentOptional(wireOptional(wireBoolean)), "test_first_mode": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
	return {
		test_first: structural.test_first,
		test_first_mode: structural.test_first_mode,
		coverage_enabled: rules.per_edit_coverage?.enabled,
		coverage_debt: rules.per_edit_coverage?.debt_mode,
		stop_checks: (parseWire(rules.verification_stop_checks, wireObject({ "enabled": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value"))?.enabled,
		cadence: (parseWire(rules.commit_cadence, wireObject({ "enabled": wireAbsentOptional(wireOptional(wireBoolean)) }), "test JSON value"))?.enabled,
	};
}

describe("writeMode → loadRules (shared/team tier)", () => {
	// test-contract: bug — the reviewer's repro: three modes loaded the SAME
	// effective posture. Strict and lenient must now load differently.
	it("P1: strict and lenient load DIFFERENT effective guard postures", () => {
		writeMode(cwd, "strict", false);
		const strict = loadedPosture(cwd);
		writeMode(cwd, "lenient", false);
		const lenient = loadedPosture(cwd);
		expect(strict).not.toEqual(lenient);
		expect(strict.test_first).toBe(true);
		expect(strict.test_first_mode).toBe("enforce");
		expect(strict.coverage_enabled).toBe(true);
		expect(strict.coverage_debt).toBe(false);
		expect(lenient.test_first).toBe(false);
		expect(lenient.coverage_enabled).toBe(false);
		expect(lenient.stop_checks).toBe(false);
		expect(lenient.cadence).toBe(false);
	});

	// test-contract: public-api — balanced's debt-mode coverage posture loads.
	it("P2: balanced loads coverage-with-debt and warn-tier TDD", () => {
		writeMode(cwd, "balanced", false);
		const posture = loadedPosture(cwd);
		expect(posture.test_first).toBe(true);
		expect(posture.test_first_mode).toBe("warn");
		expect(posture.coverage_enabled).toBe(true);
		expect(posture.coverage_debt).toBe(true);
	});
});

describe("writeMode --local → loadRules (personal tier)", () => {
	// test-contract: bug — the second reviewer repro: `mode --local` wrote its
	// check-policy half locally but its guard posture into the COMMITTED file.
	it("P3: a local mode switch leaves the shared guard-rules.json untouched", () => {
		const teamPath = join(cwd, ".interlinked", "guard-rules.json");
		writeFileSync(teamPath, JSON.stringify({ mutation_directed_strict_profile: { enabled: true } }));
		const teamBefore = readFileSync(teamPath, "utf-8");
		writeMode(cwd, "strict", true);
		expect(readFileSync(teamPath, "utf-8")).toBe(teamBefore);
		expect(existsSync(join(cwd, ".interlinked", "guard-rules.local.json"))).toBe(true);
		// And the posture is still EFFECTIVE, through the local tier.
		const posture = loadedPosture(cwd);
		expect(posture.test_first).toBe(true);
		expect(posture.cadence).toBe(true);
	});
});

describe("writeMode — inverse-direction rollback (review 2026-08-30 second pass)", () => {
	it("initializes a fresh custom policy without imposing a guard preset", () => {
		rmSync(join(cwd, ".interlinked"), { recursive: true });
		expect(writeMode(cwd, "custom", false)).toBe(true);
		expect(JSON.parse(readFileSync(join(cwd, ".interlinked", "check-policy.json"), "utf-8")))
			.toEqual({ version: 1, mode: "custom" });
		expect(existsSync(join(cwd, ".interlinked", "guard-rules.json"))).toBe(false);
	});

	it("reports a failed custom policy write while leaving the absent guard file absent", () => {
		mkdirSync(join(cwd, ".interlinked", "check-policy.json"));
		try {
			expect(writeMode(cwd, "custom", false)).toBe(false);
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(cwd, ".interlinked", "guard-rules.json"))).toBe(false);
		} finally {
			process.exitCode = 0;
		}
	});

	// test-contract: bug — the guard half landed, then the check-policy write
	// failed (its path was a DIRECTORY); the command threw and left a split
	// posture. It must restore the guard file and return false.
	it("P: a failed check-policy write rolls the guard file back", () => {
		const guardPath = join(cwd, ".interlinked", "guard-rules.json");
		writeFileSync(guardPath, JSON.stringify({ mutation_directed_strict_profile: { enabled: true } }));
		const guardBefore = readFileSync(guardPath, "utf-8");
		// The reviewer's failure injection: make check-policy.json a directory.
		mkdirSync(join(cwd, ".interlinked", "check-policy.json"), { recursive: true });
		const ok = writeMode(cwd, "strict", false);
		expect(ok).toBe(false);
		expect(readFileSync(guardPath, "utf-8")).toBe(guardBefore);
		process.exitCode = 0;
	});
});

describe("setup wizard writers → loadRules", () => {
	// test-contract: bug — writeScopeConfig wrote diff_aware to a tier that
	// rejected it; the loaded value never moved off the default.
	it("P4: the wizard's scope choice loads (diff on, whole-file off)", () => {
		writeScopeConfig(cwd, "diff");
		expect(loadRules(cwd).diff_aware?.enabled).toBe(true);
		writeScopeConfig(cwd, "whole-file");
		expect(loadRules(cwd).diff_aware?.enabled).toBe(false);
	});

	// test-contract: bug — same class for the dead-code posture write.
	it("P5: the wizard's dead-code posture loads", () => {
		writeDeadCodeConfig(cwd, "flag");
		const structural = parseWire(loadRules(cwd).structural_checks, wireObject({ "dead_imports": wireAbsentOptional(wireOptional(wireBoolean)), "dead_exports": wireAbsentOptional(wireOptional(wireBoolean)), "dead_code_action": wireAbsentOptional(wireOptional(wireString)) }), "test JSON value");
		expect(structural.dead_imports).toBe(true);
		expect(structural.dead_exports).toBe(true);
		expect(structural.dead_code_action).toBe("flag");
	});
});

describe("unsafe posture fields never merge from the committed file", () => {
	function writeTeam(body: object): void {
		writeFileSync(join(cwd, ".interlinked", "guard-rules.json"), JSON.stringify(body));
	}

	// test-contract: security — the whitelist is fields, not sections: numeric
	// runtime knobs in a committed (PR-editable) file must not reach the
	// loaded config.
	it("N1: per_edit_coverage.budget_ms from team config is dropped", () => {
		const defaultBudget = loadRules(cwd).per_edit_coverage?.budget_ms;
		writeTeam({ per_edit_coverage: { enabled: true, budget_ms: 1 } });
		const rules = loadRules(cwd);
		expect(rules.per_edit_coverage?.enabled).toBe(true);
		expect(rules.per_edit_coverage?.budget_ms).toBe(defaultBudget);
	});

	// test-contract: security — a number smuggled into structural_checks (a
	// timeout, a budget) is dropped; only booleans and the three enums pass.
	it("N2: non-boolean, non-enum structural fields from team config are dropped", () => {
		writeTeam({ structural_checks: { test_first: true, timeout_ms: 1, test_first_mode: "enforce" } });
		const structural = parseWire(loadRules(cwd).structural_checks, wireRecord(wireUnknown), "test JSON value");
		expect(structural.test_first).toBe(true);
		expect(structural.test_first_mode).toBe("enforce");
		expect(structural.timeout_ms).not.toBe(1);
	});

	// test-contract: bug — review 2026-08-30: field-name whitelisting alone
	// let `test_first_mode: "typo"` into the runtime config. Enum VALUES are
	// now validated; invalid ones never enter the loaded configuration.
	it("N4: invalid posture enum values are dropped", () => {
		writeTeam({
			structural_checks: {
				test_first: true,
				test_first_mode: "typo",
				characterize_mode: "typo",
				dead_code_action: "typo",
			},
		});
		const structural = parseWire(loadRules(cwd).structural_checks, wireRecord(wireUnknown), "test JSON value");
		expect(structural.test_first).toBe(true);
		expect(structural.test_first_mode).not.toBe("typo");
		expect(structural.characterize_mode).not.toBe("typo");
		expect(structural.dead_code_action).not.toBe("typo");
	});

	// test-contract: bug — review 2026-08-30 third pass: the sanitizer used
	// to DELETE an invalid value, so the field read as `undefined` and
	// consumers applied their own fallbacks (an invalid test_first_mode
	// silently downgraded the built-in `enforce` to a consumer's `warn`).
	// Invalid local values must load as the EXACT built-in defaults.
	it("N5: invalid LOCAL enum values load as the three built-in defaults", () => {
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({
				structural_checks: {
					test_first_mode: "typo",
					characterize_mode: "typo",
					dead_code_action: "typo",
				},
			}),
		);
		const structural = parseWire(loadRules(cwd).structural_checks, wireRecord(wireUnknown), "test JSON value");
		expect(structural.test_first_mode).toBe("enforce");
		expect(structural.characterize_mode).toBe("warn");
		expect(structural.dead_code_action).toBe("flag");
	});

	// test-contract: bug — review 2026-08-30 third pass: doctor passed the
	// team file through mergeTeamRules, which DROPS invalid values before
	// they could be reported — three bad team enums produced zero findings.
	// The raw-file validator must name file, field, and value for BOTH tiers.
	it("N6: invalid TEAM enum values produce doctor findings naming file/field/value", () => {
		writeTeam({
			structural_checks: {
				test_first_mode: "bogus1",
				characterize_mode: "bogus2",
				dead_code_action: "bogus3",
			},
		});
		const rows = postureEnumChecks(cwd);
		expect(rows).toHaveLength(3);
		const text = rows.map((r) => r.message).join("\n");
		expect(text).toContain("guard-rules.json");
		expect(text).toContain('test_first_mode = "bogus1"');
		expect(text).toContain('characterize_mode = "bogus2"');
		expect(text).toContain('dead_code_action = "bogus3"');
	});

	it("N7: invalid LOCAL enum values produce equivalent doctor findings", () => {
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ structural_checks: { test_first_mode: "typo" } }),
		);
		const rows = postureEnumChecks(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.message).toContain("guard-rules.local.json");
		expect(rows[0]?.message).toContain('test_first_mode = "typo"');
	});

	// test-contract: bug — review 2026-08-30 fourth pass: 7 / null / [] / {}
	// were neither valid nor reported. Every non-string JSON type must both
	// LOAD as the built-in default and produce a doctor finding, at both tiers.
	it("N9: non-string enum values are invalid at both tiers — default + finding", () => {
		writeTeam({ structural_checks: { test_first_mode: 7, characterize_mode: null } });
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ structural_checks: { dead_code_action: ["flag"], test_first_mode: {} } }),
		);
		const structural = parseWire(loadRules(cwd).structural_checks, wireRecord(wireUnknown), "test JSON value");
		expect(structural.test_first_mode).toBe("enforce");
		expect(structural.characterize_mode).toBe("warn");
		expect(structural.dead_code_action).toBe("flag");
		const rows = postureEnumChecks(cwd);
		expect(rows).toHaveLength(4);
		const text = rows.map((r) => r.message).join("\n");
		expect(text).toContain("test_first_mode = 7");
		expect(text).toContain("characterize_mode = null");
		expect(text).toContain('dead_code_action = ["flag"]');
		expect(text).toContain("test_first_mode = {}");
	});

	// test-contract: boundary — valid values are not findings.
	it("N8: valid enum values in both files produce no doctor findings", () => {
		writeTeam({ structural_checks: { test_first_mode: "enforce" } });
		writeFileSync(
			join(cwd, ".interlinked", "guard-rules.local.json"),
			JSON.stringify({ structural_checks: { characterize_mode: "off", dead_code_action: "delete" } }),
		);
		expect(postureEnumChecks(cwd)).toEqual([]);
	});

	// test-contract: security — diff_aware accepts ONLY `enabled` from team.
	it("N3: diff_aware sub-settings beyond `enabled` are dropped", () => {
		const defaultComplexity = loadRules(cwd).diff_aware?.complexity;
		writeTeam({ diff_aware: { enabled: true, complexity: "everything" } });
		const rules = loadRules(cwd);
		expect(rules.diff_aware?.enabled).toBe(true);
		expect(rules.diff_aware?.complexity).toBe(defaultComplexity);
	});
});
