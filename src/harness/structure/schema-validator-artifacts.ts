// ===========================================
// Per-artifact file validators
// ===========================================
// Validates each of the 9 artifact file schemas (public_api, env, config,
// tests, docs, examples, glossary, layers, packages).
// Depends only on schema-validator-helpers.ts — no circular deps.

import type { JsonObject } from "../../lib/json-types.js";
import {
	validateDocsFile,
	validateExamplesFile,
	validatePackagesFile,
	validateTestsFile,
} from "./schema-validator-artifacts-covers.js";
import type { ValidationError, ValidationResult } from "./schema-validator-helpers.js";
import {
	checkUnknownKeys,
	err,
	fail,
	includes,
	isRepoRelativePath,
	ok,
	validateLocalId,
	validateStringArray,
} from "./schema-validator-helpers.js";
import type { ArtifactFileKey } from "./types.js";
import {
	ENV_KEY_PATTERN,
	VALID_STABILITY,
	VALID_SYMBOL_KINDS,
} from "./types.js";

// Re-export the covers-cluster validators so existing importers that pull
// them from this module (e.g. schema-validator.ts) keep resolving.
export {
	validateDocsFile,
	validateExamplesFile,
	validatePackagesFile,
	validateTestsFile,
};

// -------------------------------------------
// public_api
// -------------------------------------------

// Validates one entry of `modules[].symbols[]`: shape, name, kind, stability,
// and the three string-array fields. The deepest-nested block in the
// original monolithic validator — pulled out so it scores against its own
// (unnested) baseline instead of the module loop's nesting.
function validateModuleSymbol(s: JsonObject, sp: string): ValidationError[] {
	const errors: ValidationError[] = [];
	errors.push(
		...checkUnknownKeys(s, ["name", "kind", "stability", "docs", "tests", "examples"], sp),
	);

	if (typeof s.name !== "string" || s.name.length === 0) {
		errors.push(err(`${sp}.name`, "Must be a non-empty string"));
	}
	if (!includes(VALID_SYMBOL_KINDS, s.kind)) {
		errors.push(err(`${sp}.kind`, `Must be one of: ${VALID_SYMBOL_KINDS.join(", ")}`));
	}
	if (!includes(VALID_STABILITY, s.stability)) {
		errors.push(err(`${sp}.stability`, `Must be one of: ${VALID_STABILITY.join(", ")}`));
	}
	errors.push(...validateStringArray(s.docs, `${sp}.docs`));
	errors.push(...validateStringArray(s.tests, `${sp}.tests`));
	errors.push(...validateStringArray(s.examples, `${sp}.examples`));
	return errors;
}

// Validates a module's `symbols` field: must be an array, each entry checked
// via validateModuleSymbol above.
function validateModuleSymbols(symbols: unknown, mp: string): ValidationError[] {
	const errors: ValidationError[] = [];
	if (!Array.isArray(symbols)) {
		errors.push(err(`${mp}.symbols`, "Must be an array"));
		return errors;
	}
	for (let j = 0; j < symbols.length; j++) {
		const s = symbols[j] as JsonObject;
		errors.push(...validateModuleSymbol(s, `${mp}.symbols[${j}]`));
	}
	return errors;
}

// Validates one entry of `modules[]`: shape, id (incl. duplicate detection
// against the caller-owned `moduleIds` set), file, and symbols.
function validateModuleEntry(
	m: JsonObject,
	mp: string,
	moduleIds: Set<string>,
): ValidationError[] {
	const errors: ValidationError[] = [];
	errors.push(...checkUnknownKeys(m, ["id", "file", "symbols"], mp));

	if (typeof m.id !== "string") {
		errors.push(err(`${mp}.id`, "Must be a string"));
	} else {
		errors.push(...validateLocalId(m.id, `${mp}.id`));
		if (moduleIds.has(m.id)) errors.push(err(`${mp}.id`, `Duplicate module ID "${m.id}"`));
		moduleIds.add(m.id);
	}

	if (typeof m.file !== "string") {
		errors.push(err(`${mp}.file`, "Must be a string"));
	} else if (!isRepoRelativePath(m.file)) {
		errors.push(err(`${mp}.file`, "Must be a repo-relative POSIX path"));
	}

	errors.push(...validateModuleSymbols(m.symbols, mp));
	return errors;
}

export function validatePublicApiFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "modules"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.modules)) {
		errors.push(err("$.modules", "Must be an array"));
		return fail(errors);
	}

	const moduleIds = new Set<string>();
	for (let i = 0; i < obj.modules.length; i++) {
		const m = obj.modules[i] as JsonObject;
		errors.push(...validateModuleEntry(m, `$.modules[${i}]`, moduleIds));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// env
// -------------------------------------------

export function validateEnvFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "sources", "keys"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (obj.sources !== undefined) {
		if (typeof obj.sources !== "object" || obj.sources === null || Array.isArray(obj.sources)) {
			errors.push(err("$.sources", "Must be an object"));
		} else {
			const src = obj.sources as JsonObject;
			errors.push(...checkUnknownKeys(src, ["declarations", "defaults"], "$.sources"));
			errors.push(...validateStringArray(src.declarations || [], "$.sources.declarations"));
			errors.push(...validateStringArray(src.defaults || [], "$.sources.defaults"));
		}
	}

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	const keyNames = new Set<string>();
	for (let i = 0; i < obj.keys.length; i++) {
		const k = obj.keys[i] as JsonObject;
		const kp = `$.keys[${i}]`;
		errors.push(
			...checkUnknownKeys(
				k,
				["name", "required", "docs", "tests", "examples", "default_sources"],
				kp,
			),
		);

		if (typeof k.name !== "string") {
			errors.push(err(`${kp}.name`, "Must be a string"));
		} else {
			if (!ENV_KEY_PATTERN.test(k.name)) {
				errors.push(err(`${kp}.name`, `Must match ${ENV_KEY_PATTERN.source}`));
			}
			if (keyNames.has(k.name))
				errors.push(err(`${kp}.name`, `Duplicate key name "${k.name}"`));
			keyNames.add(k.name);
		}

		if (typeof k.required !== "boolean")
			errors.push(err(`${kp}.required`, "Must be a boolean"));
		errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
		errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
		errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
		errors.push(...validateStringArray(k.default_sources || [], `${kp}.default_sources`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// config
// -------------------------------------------

export function validateConfigFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "roots", "keys"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (Array.isArray(obj.roots)) {
		const rootIds = new Set<string>();
		for (let i = 0; i < obj.roots.length; i++) {
			const r = obj.roots[i] as JsonObject;
			const rp = `$.roots[${i}]`;
			errors.push(...checkUnknownKeys(r, ["id", "file"], rp));
			if (typeof r.id !== "string") errors.push(err(`${rp}.id`, "Must be a string"));
			else {
				errors.push(...validateLocalId(r.id, `${rp}.id`));
				if (rootIds.has(r.id)) errors.push(err(`${rp}.id`, `Duplicate root ID "${r.id}"`));
				rootIds.add(r.id);
			}
			if (typeof r.file !== "string") errors.push(err(`${rp}.file`, "Must be a string"));
			else if (!isRepoRelativePath(r.file))
				errors.push(err(`${rp}.file`, "Must be a repo-relative POSIX path"));
		}
	}

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	for (let i = 0; i < obj.keys.length; i++) {
		const k = obj.keys[i] as JsonObject;
		const kp = `$.keys[${i}]`;
		errors.push(
			...checkUnknownKeys(
				k,
				["name", "required", "docs", "tests", "examples", "declared_in"],
				kp,
			),
		);

		if (typeof k.name !== "string" || k.name.length === 0) {
			errors.push(err(`${kp}.name`, "Must be a non-empty string"));
		}
		if (typeof k.required !== "boolean")
			errors.push(err(`${kp}.required`, "Must be a boolean"));
		errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
		errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
		errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
		errors.push(...validateStringArray(k.declared_in || [], `${kp}.declared_in`));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// glossary
// -------------------------------------------

// Validates one entry of the `terms` array: unknown-key check, `id`
// shape/duplicate detection, `canonical` shape/collision detection, and
// alias/deprecated shape + collision registration against the running
// `allCanonicals` map. Mutates `termIds` and `allCanonicals` in place and
// appends to `errors` — same shared-state-accumulator shape as the
// `layers` validators below (`validateLayerDeclarations` / `validateLayerRules`).
function validateGlossaryTerm(
	t: JsonObject,
	tp: string,
	termIds: Set<string>,
	allCanonicals: Map<string, string>,
	errors: ValidationError[],
): void {
	errors.push(...checkUnknownKeys(t, ["id", "canonical", "aliases", "deprecated", "docs"], tp));

	if (typeof t.id !== "string") errors.push(err(`${tp}.id`, "Must be a string"));
	else {
		errors.push(...validateLocalId(t.id, `${tp}.id`));
		if (termIds.has(t.id)) errors.push(err(`${tp}.id`, `Duplicate term ID "${t.id}"`));
		termIds.add(t.id);
	}

	if (typeof t.canonical !== "string" || t.canonical.length === 0) {
		errors.push(err(`${tp}.canonical`, "Must be a non-empty string"));
	} else {
		const lower = t.canonical.toLowerCase();
		if (allCanonicals.has(lower)) {
			errors.push(
				err(
					`${tp}.canonical`,
					`"${t.canonical}" collides with term "${allCanonicals.get(lower)}"`,
				),
			);
		}
		allCanonicals.set(lower, t.id as string);
	}

	errors.push(...validateStringArray(t.aliases || [], `${tp}.aliases`));
	errors.push(...validateStringArray(t.deprecated || [], `${tp}.deprecated`));
	errors.push(...validateStringArray(t.docs || [], `${tp}.docs`));

	// Register aliases and deprecated for collision checking
	for (const alias of (t.aliases as string[] | undefined) || []) {
		const la = alias.toLowerCase();
		if (allCanonicals.has(la)) {
			errors.push(
				err(`${tp}.aliases`, `"${alias}" collides with term "${allCanonicals.get(la)}"`),
			);
		}
		allCanonicals.set(la, t.id as string);
	}
	for (const dep of (t.deprecated as string[] | undefined) || []) {
		const ld = dep.toLowerCase();
		if (allCanonicals.has(ld)) {
			errors.push(
				err(`${tp}.deprecated`, `"${dep}" collides with term "${allCanonicals.get(ld)}"`),
			);
		}
		allCanonicals.set(ld, t.id as string);
	}
}

export function validateGlossaryFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "terms"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.terms)) {
		errors.push(err("$.terms", "Must be an array"));
		return fail(errors);
	}

	const termIds = new Set<string>();
	const allCanonicals = new Map<string, string>(); // lowered → owning term id
	for (let i = 0; i < obj.terms.length; i++) {
		validateGlossaryTerm(
			obj.terms[i] as JsonObject,
			`$.terms[${i}]`,
			termIds,
			allCanonicals,
			errors,
		);
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// layers
// -------------------------------------------

// Validates the `layers` array: each entry's shape, local-ID rules, and
// duplicate-ID detection. Returns the declared layer IDs so the rules pass
// (below) can check `from` / `cannot_import` references against them.
function validateLayerDeclarations(layers: unknown, errors: ValidationError[]): Set<string> {
	const layerIds = new Set<string>();
	if (!Array.isArray(layers)) {
		errors.push(err("$.layers", "Must be an array"));
		return layerIds;
	}
	for (let i = 0; i < layers.length; i++) {
		const l = layers[i] as JsonObject;
		const lp = `$.layers[${i}]`;
		errors.push(...checkUnknownKeys(l, ["id", "globs"], lp));

		if (typeof l.id !== "string") errors.push(err(`${lp}.id`, "Must be a string"));
		else {
			errors.push(...validateLocalId(l.id, `${lp}.id`));
			if (layerIds.has(l.id)) errors.push(err(`${lp}.id`, `Duplicate layer ID "${l.id}"`));
			layerIds.add(l.id);
		}
		errors.push(...validateStringArray(l.globs || [], `${lp}.globs`));
	}
	return layerIds;
}

// Validates the `rules` array: each entry's shape, and that `from` /
// `cannot_import` reference layer IDs actually declared above (skipped when
// no layers were declared at all, matching the original "no layers yet"
// leniency).
function validateLayerRules(
	rules: unknown,
	layerIds: Set<string>,
	errors: ValidationError[],
): void {
	if (!Array.isArray(rules)) {
		errors.push(err("$.rules", "Must be an array"));
		return;
	}
	for (let i = 0; i < rules.length; i++) {
		const r = rules[i] as JsonObject;
		const rp = `$.rules[${i}]`;
		errors.push(...checkUnknownKeys(r, ["from", "cannot_import", "reason"], rp));

		if (typeof r.from !== "string") errors.push(err(`${rp}.from`, "Must be a string"));
		else if (layerIds.size > 0 && !layerIds.has(r.from)) {
			errors.push(err(`${rp}.from`, `References undeclared layer "${r.from}"`));
		}

		if (!Array.isArray(r.cannot_import)) {
			errors.push(err(`${rp}.cannot_import`, "Must be an array"));
		} else {
			for (const ci of r.cannot_import as string[]) {
				if (layerIds.size > 0 && !layerIds.has(ci)) {
					errors.push(
						err(`${rp}.cannot_import`, `References undeclared layer "${ci}"`),
					);
				}
			}
		}

		if (typeof r.reason !== "string" || r.reason.length === 0) {
			errors.push(err(`${rp}.reason`, "Must be a non-empty string"));
		} else if (r.reason.length > 160) {
			errors.push(err(`${rp}.reason`, "Should be under 160 characters"));
		}
	}
}

export function validateLayersFile(data: unknown): ValidationResult {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data as JsonObject;
	const errors = checkUnknownKeys(obj, ["version", "layers", "rules"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	const layerIds = validateLayerDeclarations(obj.layers, errors);
	validateLayerRules(obj.rules, layerIds, errors);

	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// Dispatcher: validate any artifact file by key
// -------------------------------------------

const VALIDATORS: Record<ArtifactFileKey, (data: unknown) => ValidationResult> = {
	public_api: validatePublicApiFile,
	env: validateEnvFile,
	config: validateConfigFile,
	tests: validateTestsFile,
	docs: validateDocsFile,
	examples: validateExamplesFile,
	glossary: validateGlossaryFile,
	layers: validateLayersFile,
	packages: validatePackagesFile,
};

export function validateArtifactFile(key: ArtifactFileKey, data: unknown): ValidationResult {
	// `key` is typed `ArtifactFileKey`, but this is a public, exported entry
	// point: a caller outside this module's compile-time checking (a `.js`
	// consumer, or a coerced/`as never` value from upstream key-derivation
	// logic) can hand in a string that isn't actually one of the known keys —
	// so the lookup stays defensively `Partial`-typed rather than trusting
	// `VALIDATORS`' exhaustive `Record<ArtifactFileKey, …>` declaration.
	const validator = (
		VALIDATORS as Partial<Record<ArtifactFileKey, (data: unknown) => ValidationResult>>
	)[key];
	if (!validator) return fail([err("$", `Unknown artifact file key: ${key}`)]);
	return validator(data);
}
