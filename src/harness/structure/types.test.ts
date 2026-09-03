import { describe, expect, it } from "vitest";
import {
	DEFAULT_ADOPTION_THRESHOLDS,
	DEFAULT_BUILTINS,
	ENV_KEY_PATTERN,
	LOCAL_ID_PATTERN,
	MODE_DEFAULTS,
	VALID_ARTIFACT_KINDS,
	VALID_DOC_KINDS,
	VALID_MODES,
	VALID_STABILITY,
	VALID_SYMBOL_KINDS,
	VALID_TEST_KINDS,
} from "./types.js";

describe("structure types (constants)", () => {
	it("VALID_MODES enumerates the three structure modes", () => {
		expect(VALID_MODES).toEqual(["minimal", "standard", "strict"]);
	});

	it("MODE_DEFAULTS exposes the complete defaults for every mode", () => {
		expect(MODE_DEFAULTS).toEqual({
		minimal: {
			verify: {
				fail_on_deterministic: false,
				fail_on_invalid_structure: true,
				fail_on_partial: false,
				fail_on_heuristic: false,
			},
			posttooluse: {
				emit_deterministic: true,
				emit_partial: true,
				emit_heuristic: true,
				max_heuristics: 3,
			},
		},
		standard: {
			verify: {
				fail_on_deterministic: true,
				fail_on_invalid_structure: true,
				fail_on_partial: false,
				fail_on_heuristic: false,
			},
			posttooluse: {
				emit_deterministic: true,
				emit_partial: true,
				emit_heuristic: true,
				max_heuristics: 3,
			},
		},
		strict: {
			verify: {
				fail_on_deterministic: true,
				fail_on_invalid_structure: true,
				fail_on_partial: false,
				fail_on_heuristic: false,
			},
			posttooluse: {
				emit_deterministic: true,
				emit_partial: true,
				emit_heuristic: true,
				max_heuristics: 3,
			},
		},
	});
	});

	it("VALID_ARTIFACT_KINDS enumerates every artifact kind", () => {
		expect(VALID_ARTIFACT_KINDS).toEqual([
		"module",
		"public_symbol",
		"package",
		"env_key",
		"config_key",
		"test",
		"doc",
		"example",
		"term",
		"layer",
	]);
	});

	it("validation arrays enumerate their complete allowed values", () => {
		expect(VALID_SYMBOL_KINDS).toEqual([
		"function",
		"class",
		"type",
		"interface",
		"const",
		"enum",
		"default_export",
	]);
		expect(VALID_STABILITY).toEqual(["public", "beta", "internal"]);
		expect(VALID_DOC_KINDS).toEqual(["reference", "guide", "concept", "readme", "runbook"]);
		expect(VALID_TEST_KINDS).toEqual(["unit", "integration", "contract", "golden", "smoke"]);
	});

	it("DEFAULT_ADOPTION_THRESHOLDS defines each category's coverage threshold", () => {
		expect(DEFAULT_ADOPTION_THRESHOLDS).toEqual({
			public_api: 0.6,
			env: 0.8,
			config: 0.8,
			tests: 0.5,
			docs: 0.5,
			examples: 0.3,
			glossary: 0.4,
			layers: 0.7,
			packages: 1.0,
		});
	});

	it("DEFAULT_BUILTINS enables every built-in rule family", () => {
		expect(DEFAULT_BUILTINS).toEqual({
			public_symbol_companions: true,
			public_symbol_test_case: true,
			env_key_companions: true,
			config_key_companions: true,
			layer_boundary_violations: true,
			glossary_residue: true,
			package_boundary_violations: true,
		});
	});

	it("LOCAL_ID_PATTERN accepts valid identifiers", () => {
		expect(LOCAL_ID_PATTERN.test("foo")).toBe(true);
		expect(LOCAL_ID_PATTERN.test("foo_bar.baz-0")).toBe(true);
	});

	it("LOCAL_ID_PATTERN rejects invalid identifiers", () => {
		expect(LOCAL_ID_PATTERN.test("")).toBe(false);
		expect(LOCAL_ID_PATTERN.test("has spaces")).toBe(false);
	});

	it("ENV_KEY_PATTERN accepts UPPER_SNAKE_CASE", () => {
		expect(ENV_KEY_PATTERN.test("SAMPLE_FLAG")).toBe(true);
		expect(ENV_KEY_PATTERN.test("A_1_B")).toBe(true);
	});

	it("ENV_KEY_PATTERN rejects lowercase or mixed", () => {
		expect(ENV_KEY_PATTERN.test("lower")).toBe(false);
		expect(ENV_KEY_PATTERN.test("MixedCase")).toBe(false);
	});
});
