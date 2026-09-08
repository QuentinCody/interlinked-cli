// ===========================================
// Generic Artifact Structure V1 — Schema Validation
// ===========================================
// Validates structure.json and all artifact files per spec sections 7–9.
// Unknown keys are invalid at every level for committed structure files.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	checkUnknownKeys,
	err,
	fail,
	includes,
	isRepoRelativePath,
	ok,
	type ValidationError,
	type ValidationResult,
} from "./schema-validator-helpers.js";
import type { ArtifactFileKey, StructureConfig } from "./types.js";
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
const VERIFY_KEYS: Array<keyof StructureConfig["verify"]> = [
	"fail_on_deterministic",
	"fail_on_invalid_structure",
	"fail_on_partial",
	"fail_on_heuristic",
];
const POSTTOOLUSE_KEYS = ["emit_deterministic", "emit_partial", "emit_heuristic", "max_heuristics"];
const ADOPTION_KEYS = ["coverage_thresholds"];
const BUILTINS_KEYS: Array<keyof StructureConfig["builtins"]> = [
	"public_symbol_companions",
	"public_symbol_test_case",
	"env_key_companions",
	"config_key_companions",
	"layer_boundary_violations",
	"glossary_residue",
	"package_boundary_violations",
];
export const ARTIFACT_FILE_KEYS: ArtifactFileKey[] = [
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
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
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
	if (!includes(VALID_MODES, obj.mode)) {
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
		if (!isJsonObject(a.coverage_thresholds)) {
			errors.push(err("$.adoption.coverage_thresholds", "Must be an object"));
		} else {
			errors.push(...validateCoverageThresholds(a.coverage_thresholds));
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
	const mode = includes(VALID_MODES, data.mode) ? data.mode : "standard";
	const defaults = MODE_DEFAULTS[mode];
	const { artifacts, adoption } = resolveArtifactSettings(data);

	return {
		version: 1,
		mode,
		artifacts,
		verify: resolveBooleanSettings(data.verify, defaults.verify, VERIFY_KEYS),
		posttooluse: resolvePosttooluse(data.posttooluse, defaults.posttooluse),
		adoption,
		builtins: resolveBooleanSettings(data.builtins, DEFAULT_BUILTINS, BUILTINS_KEYS),
	};
}

function resolveBooleanSettings<K extends string>(input: unknown, defaults: Record<K, boolean>, keys: readonly K[]): Record<K, boolean> {
	const result = { ...defaults };
	const values = isJsonObject(input) ? input : {};
	for (const key of keys) {
		const value = values[key];
		if (typeof value === "boolean") result[key] = value;
	}
	return result;
}

function resolveArtifactSettings(data: JsonObject): Pick<StructureConfig, "artifacts" | "adoption"> {
	const coverage_thresholds = { ...DEFAULT_ADOPTION_THRESHOLDS };
	const adoptionInput = isJsonObject(data.adoption) ? data.adoption : {};
	const thresholds = isJsonObject(adoptionInput.coverage_thresholds) ? adoptionInput.coverage_thresholds : {};
	const artifacts: StructureConfig["artifacts"] = {};
	const artifactInput = isJsonObject(data.artifacts) ? data.artifacts : {};
	for (const key of ARTIFACT_FILE_KEYS) {
		const threshold = thresholds[key];
		if (typeof threshold === "number") coverage_thresholds[key] = threshold;
		const path = artifactInput[key];
		if (typeof path === "string") artifacts[key] = path;
	}
	return { artifacts, adoption: { coverage_thresholds } };
}

function resolvePosttooluse(input: unknown, defaults: StructureConfig["posttooluse"]): StructureConfig["posttooluse"] {
	const values = isJsonObject(input) ? input : {};
	return {
		emit_deterministic: typeof values.emit_deterministic === "boolean" ? values.emit_deterministic : defaults.emit_deterministic,
		emit_partial: typeof values.emit_partial === "boolean" ? values.emit_partial : defaults.emit_partial,
		emit_heuristic: typeof values.emit_heuristic === "boolean" ? values.emit_heuristic : defaults.emit_heuristic,
		max_heuristics: typeof values.max_heuristics === "number" ? values.max_heuristics : defaults.max_heuristics,
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
