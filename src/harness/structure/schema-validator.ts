// ===========================================
// Generic Artifact Structure V1 — Schema Validation
// ===========================================
// Validates structure.json and all artifact files per spec sections 7–9.
// Unknown keys are invalid at every level for committed structure files.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import {
	checkUnknownKeys,
	err,
	fail,
	isRepoRelativePath,
	ok,
	type ValidationError,
	type ValidationResult,
} from "./schema-validator-helpers.js";
import type { ArtifactFileKey, StructureConfig, StructureMode } from "./types.js";
import {
	DEFAULT_ADOPTION_THRESHOLDS,
	DEFAULT_BUILTINS,
	MODE_DEFAULTS,
	VALID_MODES,
} from "./types.js";

// -------------------------------------------
// Re-export types and per-artifact validators
// -------------------------------------------


export {
	validateArtifactFile,
	validateConfigFile,
	validateDocsFile,
	validateEnvFile,
	validateExamplesFile,
	validateGlossaryFile,
	validateLayersFile,
	validatePackagesFile,
	validatePublicApiFile,
	validateTestsFile,
} from "./schema-validator-artifacts.js";
export type { ValidationError, ValidationResult } from "./schema-validator-helpers.js";

// -------------------------------------------
// structure.json Validation
// -------------------------------------------

const STRUCTURE_ROOT_KEYS = [
	"version",
	"mode",
	"artifacts",
	"verify",
	"posttooluse",
	"adoption",
	"builtins",
];
const VERIFY_KEYS = [
	"fail_on_deterministic",
	"fail_on_invalid_structure",
	"fail_on_partial",
	"fail_on_heuristic",
];
const POSTTOOLUSE_KEYS = ["emit_deterministic", "emit_partial", "emit_heuristic", "max_heuristics"];
const ADOPTION_KEYS = ["coverage_thresholds"];
const BUILTINS_KEYS = [
	"public_symbol_companions",
	"public_symbol_test_case",
	"env_key_companions",
	"config_key_companions",
	"layer_boundary_violations",
	"glossary_residue",
	"package_boundary_violations",
];
const ARTIFACT_FILE_KEYS: ArtifactFileKey[] = [
	"public_api",
	"env",
	"config",
	"tests",
	"docs",
	"examples",
	"glossary",
	"layers",
	"packages",
];
const COVERAGE_KEYS = ARTIFACT_FILE_KEYS;

export function validateStructureJson(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors: ValidationError[] = [
		...checkUnknownKeys(obj, STRUCTURE_ROOT_KEYS, "$"),
		...validateVersionField(obj),
		...validateModeField(obj),
		...validateArtifactsField(obj),
		...validateVerifyField(obj),
		...validatePosttooluseField(obj),
		...validateAdoptionField(obj),
		...validateBuiltinsField(obj),
	];

	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// Per-key validators for structure.json (internal)
// -------------------------------------------
// Each takes the root object and returns errors for one top-level key, so
// validateStructureJson stays a thin orchestrator. They duplicate the
// "is a plain object" guard inline to preserve exact error paths/messages.

function isPlainObject(v: unknown): v is JsonObject {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateVersionField(obj: JsonObject): ValidationError[] {
	return obj.version === 1 ? [] : [err("$.version", "Must be 1")];
}

function validateModeField(obj: JsonObject): ValidationError[] {
	if (typeof obj.mode !== "string" || !VALID_MODES.includes(obj.mode as StructureMode)) {
		return [err("$.mode", `Must be one of: ${VALID_MODES.join(", ")}`)];
	}
	return [];
}

function validateArtifactsField(obj: JsonObject): ValidationError[] {
	if (obj.artifacts === undefined) return [];
	if (!isPlainObject(obj.artifacts)) {
		return [err("$.artifacts", "Must be an object")];
	}
	const errors: ValidationError[] = [];
	const arts = obj.artifacts;
	errors.push(...checkUnknownKeys(arts, ARTIFACT_FILE_KEYS, "$.artifacts"));
	for (const [key, val] of Object.entries(arts)) {
		if (typeof val !== "string") {
			errors.push(err(`$.artifacts.${key}`, "Must be a string path"));
		} else if (!isRepoRelativePath(val)) {
			errors.push(err(`$.artifacts.${key}`, "Must be a repo-relative POSIX path"));
		}
	}
	return errors;
}

function validateVerifyField(obj: JsonObject): ValidationError[] {
	if (obj.verify === undefined) return [];
	if (!isPlainObject(obj.verify)) {
		return [err("$.verify", "Must be an object")];
	}
	const errors: ValidationError[] = [];
	const v = obj.verify;
	errors.push(...checkUnknownKeys(v, VERIFY_KEYS, "$.verify"));
	for (const k of VERIFY_KEYS) {
		if (k in v && typeof v[k] !== "boolean") {
			errors.push(err(`$.verify.${k}`, "Must be a boolean"));
		}
	}
	return errors;
}

function validatePosttooluseField(obj: JsonObject): ValidationError[] {
	if (obj.posttooluse === undefined) return [];
	if (!isPlainObject(obj.posttooluse)) {
		return [err("$.posttooluse", "Must be an object")];
	}
	const errors: ValidationError[] = [];
	const p = obj.posttooluse;
	errors.push(...checkUnknownKeys(p, POSTTOOLUSE_KEYS, "$.posttooluse"));
	for (const k of ["emit_deterministic", "emit_partial", "emit_heuristic"]) {
		if (k in p && typeof p[k] !== "boolean") {
			errors.push(err(`$.posttooluse.${k}`, "Must be a boolean"));
		}
	}
	if ("max_heuristics" in p && (typeof p.max_heuristics !== "number" || p.max_heuristics < 0)) {
		errors.push(err("$.posttooluse.max_heuristics", "Must be a non-negative number"));
	}
	return errors;
}

function validateCoverageThresholds(ct: JsonObject): ValidationError[] {
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(ct, COVERAGE_KEYS, "$.adoption.coverage_thresholds"));
	for (const [k, v] of Object.entries(ct)) {
		if (typeof v !== "number" || v < 0 || v > 1) {
			errors.push(
				err(`$.adoption.coverage_thresholds.${k}`, "Must be a number between 0.0 and 1.0"),
			);
		}
	}
	return errors;
}

function validateAdoptionField(obj: JsonObject): ValidationError[] {
	if (obj.adoption === undefined) return [];
	if (!isPlainObject(obj.adoption)) {
		return [err("$.adoption", "Must be an object")];
	}
	const errors: ValidationError[] = [];
	const a = obj.adoption;
	errors.push(...checkUnknownKeys(a, ADOPTION_KEYS, "$.adoption"));
	if (a.coverage_thresholds !== undefined) {
		if (typeof a.coverage_thresholds !== "object" || a.coverage_thresholds === null) {
			errors.push(err("$.adoption.coverage_thresholds", "Must be an object"));
		} else {
			errors.push(...validateCoverageThresholds(a.coverage_thresholds as JsonObject));
		}
	}
	return errors;
}

function validateBuiltinsField(obj: JsonObject): ValidationError[] {
	if (obj.builtins === undefined) return [];
	if (!isPlainObject(obj.builtins)) {
		return [err("$.builtins", "Must be an object")];
	}
	const errors: ValidationError[] = [];
	const b = obj.builtins;
	errors.push(...checkUnknownKeys(b, BUILTINS_KEYS, "$.builtins"));
	for (const k of BUILTINS_KEYS) {
		if (k in b && typeof b[k] !== "boolean") {
			errors.push(err(`$.builtins.${k}`, "Must be a boolean"));
		}
	}
	return errors;
}

// -------------------------------------------
// Resolve StructureConfig with mode defaults
// -------------------------------------------

export function resolveStructureConfig(data: JsonObject): StructureConfig {
	const mode = (data.mode as StructureMode | undefined) || "standard";
	const defaults = MODE_DEFAULTS[mode];

	const verify: StructureConfig["verify"] = {
		...defaults.verify,
		...((data.verify as Partial<StructureConfig["verify"]> | undefined) || {}),
	};
	const posttooluse: StructureConfig["posttooluse"] = {
		...defaults.posttooluse,
		...((data.posttooluse as Partial<StructureConfig["posttooluse"]> | undefined) || {}),
	};
	const adoption: StructureConfig["adoption"] = {
		coverage_thresholds: {
			...DEFAULT_ADOPTION_THRESHOLDS,
			...((data.adoption as Record<string, Record<string, number>> | undefined)
				?.coverage_thresholds || {}),
		},
	};
	const builtins: StructureConfig["builtins"] = {
		...DEFAULT_BUILTINS,
		...((data.builtins as Partial<StructureConfig["builtins"]> | undefined) || {}),
	};

	return {
		version: 1,
		mode,
		artifacts: (data.artifacts as StructureConfig["artifacts"] | undefined) || {},
		verify,
		posttooluse,
		adoption,
		builtins,
	};
}

// -------------------------------------------
// File-existence validation for declared paths
// -------------------------------------------

export function validateDeclaredPaths(
	config: StructureConfig,
	repoRoot: string,
): ValidationError[] {
	const errors: ValidationError[] = [];

	// Check artifact file paths exist
	for (const [key, relPath] of Object.entries(config.artifacts)) {
		const absPath = resolve(repoRoot, "interlinked", relPath);
		if (!existsSync(absPath)) {
			errors.push(err(`$.artifacts.${key}`, `File not found: interlinked/${relPath}`));
		}
	}

	return errors;
}
