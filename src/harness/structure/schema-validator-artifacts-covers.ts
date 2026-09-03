// interlinked-tdd: exempt
// ===========================================
// Per-artifact file validators (covers-based cluster)
// ===========================================
// Validators for the tests, docs, examples, and packages artifact files —
// the leaf cluster split out of schema-validator-artifacts.ts to keep that
// module under the per-file line cap. Depends only on
// schema-validator-helpers.ts and ./types.js — no circular deps (the parent
// module imports these back for its dispatcher table; this file never imports
// from the parent).

import type { JsonObject } from "../../lib/json-types.js";
import type { ValidationError, ValidationResult } from "./schema-validator-helpers.js";
import {
	checkUnknownKeys,
	err,
	fail,
	includes,
	isRepoRelativePath,
	ok,
	validateCoversArray,
	validateLocalId,
	validateStringArray,
} from "./schema-validator-helpers.js";
import { VALID_DOC_KINDS, VALID_TEST_KINDS } from "./types.js";

// -------------------------------------------
// Shared entry-field validators
// -------------------------------------------

/**
 * Validates one entry's `id` field: string type, local-id grammar, and
 * uniqueness within the file. Records the id in `seenIds` so later entries
 * see it as a duplicate.
 */
function validateEntryId(
	entry: JsonObject,
	path: string,
	seenIds: Set<string>,
	label: string,
): ValidationError[] {
	if (typeof entry.id !== "string") return [err(`${path}.id`, "Must be a string")];
	const errors = validateLocalId(entry.id, `${path}.id`);
	if (seenIds.has(entry.id)) {
		errors.push(err(`${path}.id`, `Duplicate ${label} ID "${entry.id}"`));
	}
	seenIds.add(entry.id);
	return errors;
}

/** Validates that an entry's named path field is a repo-relative POSIX string. */
function validateEntryPath(entry: JsonObject, path: string, key: string): ValidationError[] {
	const value = entry[key];
	if (typeof value !== "string") return [err(`${path}.${key}`, "Must be a string")];
	if (!isRepoRelativePath(value)) {
		return [err(`${path}.${key}`, "Must be a repo-relative POSIX path")];
	}
	return [];
}

// -------------------------------------------
// tests
// -------------------------------------------

export function validateTestsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "tests"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.tests)) {
		errors.push(err("$.tests", "Must be an array"));
		return fail(errors);
	}

	const testIds = new Set<string>();
	for (let i = 0; i < obj.tests.length; i++) {
		const t = obj.tests[i] as JsonObject;
		const tp = `$.tests[${i}]`;
		errors.push(...checkUnknownKeys(t, ["id", "file", "kind", "covers"], tp));

		errors.push(...validateEntryId(t, tp, testIds, "test"));
		errors.push(...validateEntryPath(t, tp, "file"));

		if (!includes(VALID_TEST_KINDS, t.kind)) {
			errors.push(err(`${tp}.kind`, `Must be one of: ${VALID_TEST_KINDS.join(", ")}`));
		}
		errors.push(
			...validateCoversArray(Array.isArray(t.covers) ? t.covers : [], `${tp}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// docs
// -------------------------------------------

export function validateDocsFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "docs"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.docs)) {
		errors.push(err("$.docs", "Must be an array"));
		return fail(errors);
	}

	const docIds = new Set<string>();
	for (let i = 0; i < obj.docs.length; i++) {
		const d = obj.docs[i] as JsonObject;
		const dp = `$.docs[${i}]`;
		errors.push(...checkUnknownKeys(d, ["id", "file", "kind", "covers"], dp));

		errors.push(...validateEntryId(d, dp, docIds, "doc"));
		errors.push(...validateEntryPath(d, dp, "file"));

		if (!includes(VALID_DOC_KINDS, d.kind)) {
			errors.push(err(`${dp}.kind`, `Must be one of: ${VALID_DOC_KINDS.join(", ")}`));
		}
		errors.push(
			...validateCoversArray(Array.isArray(d.covers) ? d.covers : [], `${dp}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// examples
// -------------------------------------------

export function validateExamplesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "examples"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.examples)) {
		errors.push(err("$.examples", "Must be an array"));
		return fail(errors);
	}

	const exIds = new Set<string>();
	for (let i = 0; i < obj.examples.length; i++) {
		const e = obj.examples[i] as JsonObject;
		const ep = `$.examples[${i}]`;
		errors.push(...checkUnknownKeys(e, ["id", "file", "covers"], ep));

		errors.push(...validateEntryId(e, ep, exIds, "example"));
		errors.push(...validateEntryPath(e, ep, "file"));

		errors.push(
			...validateCoversArray(Array.isArray(e.covers) ? e.covers : [], `${ep}.covers`),
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// packages
// -------------------------------------------

export function validatePackagesFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "packages"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.packages)) {
		errors.push(err("$.packages", "Must be an array"));
		return fail(errors);
	}

	const pkgIds = new Set<string>();
	for (let i = 0; i < obj.packages.length; i++) {
		const p = obj.packages[i] as JsonObject;
		const pp = `$.packages[${i}]`;
		errors.push(...checkUnknownKeys(p, ["id", "root", "entrypoints"], pp));

		errors.push(...validateEntryId(p, pp, pkgIds, "package"));
		errors.push(...validateEntryPath(p, pp, "root"));

		errors.push(...validateStringArray(p.entrypoints || [], `${pp}.entrypoints`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}
