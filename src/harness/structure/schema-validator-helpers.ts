// ===========================================
// Schema Validation Helpers — shared primitives
// ===========================================
// Shared by schema-validator.ts and schema-validator-artifacts.ts.
// No imports from either of those files (avoids circular deps).

import { posix } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { ENV_KEY_PATTERN, LOCAL_ID_PATTERN, VALID_ARTIFACT_KINDS } from "./types.js";

// -------------------------------------------
// Validation Result Types
// -------------------------------------------

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

export function ok(): ValidationResult {
	return { valid: true, errors: [] };
}

export function fail(errors: ValidationError[]): ValidationResult {
	return { valid: false, errors };
}

export function err(path: string, message: string): ValidationError {
	return { path, message };
}

// -------------------------------------------
// Shared Helpers
// -------------------------------------------

export function includes<T>(arr: readonly T[], val: unknown): val is T {
	return (arr as readonly unknown[]).includes(val);
}

export function isRepoRelativePath(p: string): boolean {
	return !p.startsWith("/") && !p.startsWith("../") && p === posix.normalize(p);
}

export function hasNoDuplicates(arr: string[]): boolean {
	return new Set(arr).size === arr.length;
}

export function checkUnknownKeys(obj: JsonObject, allowed: string[], path: string): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) {
			errors.push(err(`${path}.${key}`, `Unknown key "${key}"`));
		}
	}
	return errors;
}

// LOCAL_ID_PATTERN's character class excludes ":", so a pattern-valid id can never
// carry one — that is what keeps the global `${kind}:${id}` artifact ref unambiguous
// (artifact-graph.ts:12). A separate colon check would be unreachable, so there is none.
export function validateLocalId(id: string, path: string): ValidationError[] {
	if (!LOCAL_ID_PATTERN.test(id)) {
		return [err(path, `Invalid local ID "${id}" — must match ${LOCAL_ID_PATTERN.source}`)];
	}
	return [];
}

export function validateCoversArray(covers: unknown[], path: string): ValidationError[] {
	const errors: ValidationError[] = [];
	if (!Array.isArray(covers)) {
		errors.push(err(path, "covers must be an array"));
		return errors;
	}
	for (let i = 0; i < covers.length; i++) {
		const c = covers[i] as JsonObject;
		const cp = `${path}[${i}]`;
		errors.push(...checkUnknownKeys(c, ["artifact_kind", "artifact_id"], cp));
		if (
			typeof c.artifact_kind !== "string" ||
			!includes(VALID_ARTIFACT_KINDS, c.artifact_kind)
		) {
			errors.push(
				err(`${cp}.artifact_kind`, `Must be one of: ${VALID_ARTIFACT_KINDS.join(", ")}`),
			);
		}
		if (typeof c.artifact_id !== "string" || c.artifact_id.length === 0) {
			errors.push(err(`${cp}.artifact_id`, "Must be a non-empty string"));
		}
	}
	return errors;
}

export function validateStringArray(arr: unknown, path: string): ValidationError[] {
	if (!Array.isArray(arr)) return [err(path, "Must be an array")];
	const errors: ValidationError[] = [];
	for (let i = 0; i < arr.length; i++) {
		if (typeof arr[i] !== "string") {
			errors.push(err(`${path}[${i}]`, "Must be a string"));
		}
	}
	if (!hasNoDuplicates(arr.filter((x): x is string => typeof x === "string"))) {
		errors.push(err(path, "Array must not contain duplicates"));
	}
	return errors;
}

// Re-export types needed by consumers
export type { JsonObject };
export { ENV_KEY_PATTERN, LOCAL_ID_PATTERN };
