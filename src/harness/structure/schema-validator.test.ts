import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import {
	resolveStructureConfig,
	validateArtifactFile,
	validateDeclaredPaths,
	validateEnvFile,
	validatePublicApiFile,
	validateStructureJson,
} from "./schema-validator.js";
import {
	DEFAULT_ADOPTION_THRESHOLDS,
	DEFAULT_BUILTINS,
	MODE_DEFAULTS,
} from "./types.js";

/** Convenience: find the first error whose path matches exactly. */
function errAt(result: { errors: Array<{ path: string; message: string }> }, path: string) {
	return result.errors.find((e) => e.path === path);
}

describe("validateStructureJson", () => {
	it("accepts a minimal valid structure", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: {},
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects unknown top-level keys", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			unknownProp: true,
		});
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unknown key"))).toBe(true);
	});

	it("rejects invalid mode values", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "bogus",
		});
		expect(result.valid).toBe(false);
	});

	it("rejects missing version", () => {
		const result = validateStructureJson({ mode: "minimal" });
		expect(result.valid).toBe(false);
	});

	it("rejects a non-object payload", () => {
		expect(validateStructureJson("not an object").valid).toBe(false);
		expect(validateStructureJson(null).valid).toBe(false);
		expect(validateStructureJson([]).valid).toBe(false);
	});
});

describe("validatePublicApiFile", () => {
	it("accepts a valid public-api file", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "foo",
					file: "src/foo.ts",
					symbols: [
						{
							name: "foo",
							kind: "function",
							stability: "public",
							docs: ["docs/foo.md"],
							tests: [],
							examples: [],
						},
					],
				},
			],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects unknown keys on a module entry", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "foo",
					file: "src/foo.ts",
					symbols: [],
					badKey: true,
				},
			],
		});
		expect(result.valid).toBe(false);
	});
});

describe("validateEnvFile", () => {
	it("accepts a valid env file", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "VALID_KEY", required: true, docs: [], tests: [], examples: [] }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects an env key that doesn't match UPPER_SNAKE_CASE", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "lowercase", required: true, docs: [], tests: [], examples: [] }],
		});
		expect(result.valid).toBe(false);
	});
});

describe("validateArtifactFile dispatch", () => {
	it("routes to the right validator based on key", () => {
		const ok = validateArtifactFile("env", {
			version: 1,
			keys: [],
		});
		expect(ok.valid).toBe(true);
		const bad = validateArtifactFile("env", { not: "valid" });
		expect(bad.valid).toBe(false);
	});
});

// -------------------------------------------
// validateStructureJson — exhaustive per-field branch coverage
// -------------------------------------------

describe("validateStructureJson: version field", () => {
	it("rejects a version that is not 1", () => {
		const result = validateStructureJson({ version: 2, mode: "minimal" });
		expect(result.valid).toBe(false);
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});
});

describe("validateStructureJson: mode field", () => {
	it("rejects a non-string mode with the list of valid modes", () => {
		const result = validateStructureJson({ version: 1, mode: 5 });
		expect(result.valid).toBe(false);
		const e = errAt(result, "$.mode");
		expect(e?.message).toContain("minimal");
		expect(e?.message).toContain("strict");
	});

	it("accepts every valid mode", () => {
		for (const mode of ["minimal", "standard", "strict"]) {
			const result = validateStructureJson({ version: 1, mode });
			expect(errAt(result, "$.mode")).toBeUndefined();
		}
	});
});

describe("validateStructureJson: artifacts field", () => {
	it("treats an absent artifacts key as valid (no error)", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal" });
		expect(result.errors.some((e) => e.path.startsWith("$.artifacts"))).toBe(false);
	});

	it("rejects artifacts that is not a plain object (array)", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", artifacts: [] });
		expect(errAt(result, "$.artifacts")?.message).toBe("Must be an object");
	});

	it("rejects artifacts that is null", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", artifacts: null });
		expect(errAt(result, "$.artifacts")?.message).toBe("Must be an object");
	});

	it("rejects an unknown artifact key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: { not_a_real_artifact: "x.json" },
		});
		expect(errAt(result, "$.artifacts.not_a_real_artifact")?.message).toContain("Unknown key");
	});

	it("rejects a non-string artifact value", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: { env: 123 },
		});
		expect(errAt(result, "$.artifacts.env")?.message).toBe("Must be a string path");
	});

	it("rejects a non-repo-relative (absolute) artifact path", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: { env: "/etc/env.json" },
		});
		expect(errAt(result, "$.artifacts.env")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("rejects a parent-escaping artifact path", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: { env: "../env.json" },
		});
		expect(errAt(result, "$.artifacts.env")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("accepts a valid repo-relative artifact path", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			artifacts: { env: "structure/env.json", public_api: "structure/public-api.json" },
		});
		expect(result.valid).toBe(true);
	});
});

describe("validateStructureJson: verify field", () => {
	it("treats an absent verify key as valid", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal" });
		expect(result.errors.some((e) => e.path.startsWith("$.verify"))).toBe(false);
	});

	it("rejects verify that is not an object", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", verify: true });
		expect(errAt(result, "$.verify")?.message).toBe("Must be an object");
	});

	it("rejects an unknown verify key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			verify: { fail_on_everything: true },
		});
		expect(errAt(result, "$.verify.fail_on_everything")?.message).toContain("Unknown key");
	});

	it("rejects a non-boolean known verify key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			verify: { fail_on_deterministic: "yes" },
		});
		expect(errAt(result, "$.verify.fail_on_deterministic")?.message).toBe("Must be a boolean");
	});

	it("accepts all known verify keys as booleans", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			verify: {
				fail_on_deterministic: true,
				fail_on_invalid_structure: false,
				fail_on_partial: true,
				fail_on_heuristic: false,
			},
		});
		expect(result.valid).toBe(true);
	});
});

describe("validateStructureJson: posttooluse field", () => {
	it("treats an absent posttooluse key as valid", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal" });
		expect(result.errors.some((e) => e.path.startsWith("$.posttooluse"))).toBe(false);
	});

	it("rejects posttooluse that is not an object", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", posttooluse: 3 });
		expect(errAt(result, "$.posttooluse")?.message).toBe("Must be an object");
	});

	it("rejects an unknown posttooluse key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			posttooluse: { emit_everything: true },
		});
		expect(errAt(result, "$.posttooluse.emit_everything")?.message).toContain("Unknown key");
	});

	it("rejects a non-boolean emit_* key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			posttooluse: { emit_heuristic: "no" },
		});
		expect(errAt(result, "$.posttooluse.emit_heuristic")?.message).toBe("Must be a boolean");
	});

	it("rejects a non-number max_heuristics", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			posttooluse: { max_heuristics: "five" },
		});
		expect(errAt(result, "$.posttooluse.max_heuristics")?.message).toBe(
			"Must be a non-negative number",
		);
	});

	it("rejects a negative max_heuristics", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			posttooluse: { max_heuristics: -1 },
		});
		expect(errAt(result, "$.posttooluse.max_heuristics")?.message).toBe(
			"Must be a non-negative number",
		);
	});

	it("accepts a valid posttooluse block (zero is allowed)", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			posttooluse: {
				emit_deterministic: true,
				emit_partial: false,
				emit_heuristic: true,
				max_heuristics: 0,
			},
		});
		expect(result.valid).toBe(true);
	});
});

describe("validateStructureJson: adoption field", () => {
	it("treats an absent adoption key as valid", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal" });
		expect(result.errors.some((e) => e.path.startsWith("$.adoption"))).toBe(false);
	});

	it("rejects adoption that is not an object", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", adoption: 0 });
		expect(errAt(result, "$.adoption")?.message).toBe("Must be an object");
	});

	it("rejects an unknown adoption key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { something_else: 1 },
		});
		expect(errAt(result, "$.adoption.something_else")?.message).toContain("Unknown key");
	});

	it("validates array-shaped coverage_thresholds by index (arrays pass the typeof-object guard)", () => {
		// An array is `typeof "object"` and not null, so it flows into
		// validateCoverageThresholds, which iterates entries by numeric index.
		// Index "0" is both an unknown key AND (here) an out-of-range value.
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: [2] },
		});
		expect(result.valid).toBe(false);
		const atIndex = result.errors.filter(
			(e) => e.path === "$.adoption.coverage_thresholds.0",
		);
		expect(atIndex.some((e) => e.message.includes("Unknown key"))).toBe(true);
		expect(
			atIndex.some((e) => e.message === "Must be a number between 0.0 and 1.0"),
		).toBe(true);
	});

	it("rejects coverage_thresholds that is null", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: null },
		});
		expect(errAt(result, "$.adoption.coverage_thresholds")?.message).toBe("Must be an object");
	});

	it("rejects an unknown key inside coverage_thresholds", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: { bogus_category: 0.5 } },
		});
		expect(errAt(result, "$.adoption.coverage_thresholds.bogus_category")?.message).toContain(
			"Unknown key",
		);
	});

	it("rejects a non-number coverage threshold", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: { env: "high" } },
		});
		expect(errAt(result, "$.adoption.coverage_thresholds.env")?.message).toBe(
			"Must be a number between 0.0 and 1.0",
		);
	});

	it("rejects a coverage threshold below 0.0", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: { env: -0.1 } },
		});
		expect(errAt(result, "$.adoption.coverage_thresholds.env")?.message).toBe(
			"Must be a number between 0.0 and 1.0",
		);
	});

	it("rejects a coverage threshold above 1.0", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: { env: 1.5 } },
		});
		expect(errAt(result, "$.adoption.coverage_thresholds.env")?.message).toBe(
			"Must be a number between 0.0 and 1.0",
		);
	});

	it("accepts coverage thresholds at the 0.0 and 1.0 boundaries", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			adoption: { coverage_thresholds: { env: 0, packages: 1, docs: 0.5 } },
		});
		expect(result.valid).toBe(true);
	});
});

describe("validateStructureJson: builtins field", () => {
	it("treats an absent builtins key as valid", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal" });
		expect(result.errors.some((e) => e.path.startsWith("$.builtins"))).toBe(false);
	});

	it("rejects builtins that is not an object", () => {
		const result = validateStructureJson({ version: 1, mode: "minimal", builtins: "all" });
		expect(errAt(result, "$.builtins")?.message).toBe("Must be an object");
	});

	it("rejects an unknown builtins key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			builtins: { unknown_rule: true },
		});
		expect(errAt(result, "$.builtins.unknown_rule")?.message).toContain("Unknown key");
	});

	it("rejects a non-boolean known builtins key", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			builtins: { glossary_residue: 1 },
		});
		expect(errAt(result, "$.builtins.glossary_residue")?.message).toBe("Must be a boolean");
	});

	it("accepts all known builtins keys as booleans", () => {
		const result = validateStructureJson({
			version: 1,
			mode: "minimal",
			builtins: {
				public_symbol_companions: true,
				public_symbol_test_case: true,
				env_key_companions: false,
				config_key_companions: true,
				layer_boundary_violations: false,
				glossary_residue: true,
				package_boundary_violations: false,
			},
		});
		expect(result.valid).toBe(true);
	});
});

describe("validateStructureJson: accumulates errors across multiple fields", () => {
	it("returns one error per malformed field", () => {
		const result = validateStructureJson({
			version: 99,
			mode: "bogus",
			verify: { fail_on_partial: "x" },
			builtins: { glossary_residue: "x" },
		});
		expect(result.valid).toBe(false);
		expect(errAt(result, "$.version")).toBeDefined();
		expect(errAt(result, "$.mode")).toBeDefined();
		expect(errAt(result, "$.verify.fail_on_partial")).toBeDefined();
		expect(errAt(result, "$.builtins.glossary_residue")).toBeDefined();
	});
});

// -------------------------------------------
// resolveStructureConfig — defaults + override merging
// -------------------------------------------

describe("resolveStructureConfig", () => {
	it("falls back to standard mode when mode is absent", () => {
		const config = resolveStructureConfig({ version: 1 });
		expect(config.mode).toBe("standard");
		expect(config.verify).toEqual(MODE_DEFAULTS.standard.verify);
		expect(config.posttooluse).toEqual(MODE_DEFAULTS.standard.posttooluse);
	});

	it("applies minimal-mode verify defaults when no verify block is given", () => {
		const config = resolveStructureConfig({ version: 1, mode: "minimal" });
		expect(config.verify).toEqual(MODE_DEFAULTS.minimal.verify);
	});

	it("merges a partial verify block over mode defaults", () => {
		const config = resolveStructureConfig({
			version: 1,
			mode: "minimal",
			verify: { fail_on_heuristic: true },
		});
		expect(config.verify.fail_on_heuristic).toBe(true);
		// Untouched keys retain the minimal default.
		expect(config.verify.fail_on_deterministic).toBe(
			MODE_DEFAULTS.minimal.verify.fail_on_deterministic,
		);
	});

	it("merges a partial posttooluse block over mode defaults", () => {
		const config = resolveStructureConfig({
			version: 1,
			mode: "standard",
			posttooluse: { max_heuristics: 7 },
		});
		expect(config.posttooluse.max_heuristics).toBe(7);
		expect(config.posttooluse.emit_partial).toBe(
			MODE_DEFAULTS.standard.posttooluse.emit_partial,
		);
	});

	it("uses default adoption thresholds when none are provided", () => {
		const config = resolveStructureConfig({ version: 1, mode: "standard" });
		expect(config.adoption.coverage_thresholds).toEqual(DEFAULT_ADOPTION_THRESHOLDS);
	});

	it("merges partial coverage_thresholds over the defaults", () => {
		const config = resolveStructureConfig({
			version: 1,
			mode: "standard",
			adoption: { coverage_thresholds: { env: 0.99 } },
		});
		expect(config.adoption.coverage_thresholds.env).toBe(0.99);
		// Unspecified categories keep the global default.
		expect(config.adoption.coverage_thresholds.packages).toBe(
			DEFAULT_ADOPTION_THRESHOLDS.packages,
		);
	});

	it("handles an adoption block that omits coverage_thresholds", () => {
		// Exercises the optional-chaining `?.coverage_thresholds` falsy branch.
		const config = resolveStructureConfig({ version: 1, mode: "standard", adoption: {} });
		expect(config.adoption.coverage_thresholds).toEqual(DEFAULT_ADOPTION_THRESHOLDS);
	});

	it("uses default builtins when none are provided", () => {
		const config = resolveStructureConfig({ version: 1, mode: "standard" });
		expect(config.builtins).toEqual(DEFAULT_BUILTINS);
	});

	it("merges a partial builtins block over the defaults", () => {
		const config = resolveStructureConfig({
			version: 1,
			mode: "standard",
			builtins: { glossary_residue: false },
		});
		expect(config.builtins.glossary_residue).toBe(false);
		expect(config.builtins.public_symbol_companions).toBe(
			DEFAULT_BUILTINS.public_symbol_companions,
		);
	});

	it("defaults artifacts to an empty object when absent", () => {
		const config = resolveStructureConfig({ version: 1, mode: "minimal" });
		expect(config.artifacts).toEqual({});
	});

	it("passes through declared artifacts verbatim", () => {
		const artifacts = { env: "structure/env.json" };
		const config = resolveStructureConfig({
			version: 1,
			mode: "minimal",
			artifacts: artifacts as JsonObject,
		});
		expect(config.artifacts).toEqual(artifacts);
	});

	it("always pins version to 1 regardless of input", () => {
		const config = resolveStructureConfig({ version: 1, mode: "strict" });
		expect(config.version).toBe(1);
	});
});

// -------------------------------------------
// validateDeclaredPaths — filesystem existence checks
// -------------------------------------------

describe("validateDeclaredPaths", () => {
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "schema-validator-paths-"));
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	function configWith(artifacts: Record<string, string>) {
		return resolveStructureConfig({
			version: 1,
			mode: "minimal",
			artifacts: artifacts as JsonObject,
		});
	}

	it("returns no errors when every declared artifact file exists", () => {
		mkdirSync(join(repoRoot, "interlinked", "structure"), { recursive: true });
		writeFileSync(
			join(repoRoot, "interlinked", "structure", "env.json"),
			JSON.stringify({ version: 1, keys: [] }),
			"utf-8",
		);
		const errors = validateDeclaredPaths(
			configWith({ env: "structure/env.json" }),
			repoRoot,
		);
		expect(errors).toEqual([]);
	});

	it("reports a missing declared artifact file with the interlinked-relative path", () => {
		const errors = validateDeclaredPaths(
			configWith({ env: "structure/env.json" }),
			repoRoot,
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.path).toBe("$.artifacts.env");
		expect(errors[0]?.message).toBe("File not found: interlinked/structure/env.json");
	});

	it("reports one error per missing file and skips the ones that exist", () => {
		mkdirSync(join(repoRoot, "interlinked"), { recursive: true });
		writeFileSync(
			join(repoRoot, "interlinked", "present.json"),
			JSON.stringify({ version: 1 }),
			"utf-8",
		);
		const errors = validateDeclaredPaths(
			configWith({ env: "present.json", config: "absent.json" }),
			repoRoot,
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.path).toBe("$.artifacts.config");
	});

	it("returns no errors when there are no declared artifacts", () => {
		const errors = validateDeclaredPaths(configWith({}), repoRoot);
		expect(errors).toEqual([]);
	});
});
