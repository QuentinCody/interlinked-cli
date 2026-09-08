// ===========================================
// Per-artifact file validators
// ===========================================
// Validates each of the 9 artifact file schemas (public_api, env, config,
// tests, docs, examples, glossary, layers, packages).
// Depends only on schema-validator-helpers.ts — no circular deps.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	validateDocsFile,
	validateExamplesFile,
	validatePackagesFile,
	validateTestsFile,
} from "./schema-validator-artifacts-covers.js";
import { validateLayerRuleEntry } from "./schema-validator-artifacts-layers.js";
import type { ValidationError, ValidationResult } from "./schema-validator-helpers.js";
import {
	checkUnknownKeys,
	err,
	fail,
	includes,
	isRepoRelativePath,
	isStringArray,
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
function validateModuleSymbol(s: unknown, sp: string): ValidationError[] {
	if (!isJsonObject(s)) return [err(sp, "Must be a JSON object")];
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
		const s: unknown = symbols[j];
		errors.push(...validateModuleSymbol(s, `${mp}.symbols[${j}]`));
	}
	return errors;
}

// Validates one entry of `modules[]`: shape, id (incl. duplicate detection
// against the caller-owned `moduleIds` set), file, and symbols.
function validateModuleEntry(
	m: unknown,
	mp: string,
	moduleIds: Set<string>,
): ValidationError[] {
	if (!isJsonObject(m)) return [err(mp, "Must be a JSON object")];
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
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
	const errors = checkUnknownKeys(obj, ["version", "modules"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (!Array.isArray(obj.modules)) {
		errors.push(err("$.modules", "Must be an array"));
		return fail(errors);
	}

	const moduleIds = new Set<string>();
	for (let i = 0; i < obj.modules.length; i++) {
		const m: unknown = obj.modules[i];
		errors.push(...validateModuleEntry(m, `$.modules[${i}]`, moduleIds));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// env
// -------------------------------------------

// Validates the optional `$.sources` block: object shape plus its two
// string-array members. Called only when the key is present, matching the
// original `obj.sources !== undefined` guard.
function validateEnvSources(sources: unknown, errors: ValidationError[]): void {
	if (!isJsonObject(sources)) {
		errors.push(err("$.sources", "Must be an object"));
		return;
	}
	const src = sources;
	errors.push(...checkUnknownKeys(src, ["declarations", "defaults"], "$.sources"));
	errors.push(...validateStringArray(src.declarations || [], "$.sources.declarations"));
	errors.push(...validateStringArray(src.defaults || [], "$.sources.defaults"));
}

// Validates one entry of `$.keys[]`: shape, name pattern + duplicate detection
// against the caller-owned `keyNames` set, `required`, and the string arrays.
function validateEnvKey(k: unknown, kp: string, keyNames: Set<string>): ValidationError[] {
	if (!isJsonObject(k)) return [err(kp, "Must be a JSON object")];
	const errors: ValidationError[] = [];
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
		if (keyNames.has(k.name)) errors.push(err(`${kp}.name`, `Duplicate key name "${k.name}"`));
		keyNames.add(k.name);
	}

	if (typeof k.required !== "boolean") errors.push(err(`${kp}.required`, "Must be a boolean"));
	errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
	errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
	errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
	errors.push(...validateStringArray(k.default_sources || [], `${kp}.default_sources`));
	return errors;
}

export function validateEnvFile(data: unknown): ValidationResult {
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
	const errors = checkUnknownKeys(obj, ["version", "sources", "keys"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (obj.sources !== undefined) validateEnvSources(obj.sources, errors);

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	const keyNames = new Set<string>();
	for (let i = 0; i < obj.keys.length; i++) {
		const k: unknown = obj.keys[i];
		errors.push(...validateEnvKey(k, `$.keys[${i}]`, keyNames));
	}
	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// config
// -------------------------------------------

// Validates one entry of `$.roots[]`: shape, `id` local-ID rules + duplicate
// detection against the caller-owned `rootIds` set, and `file` path shape.
function validateConfigRoot(r: unknown, rp: string, rootIds: Set<string>): ValidationError[] {
	if (!isJsonObject(r)) return [err(rp, "Must be a JSON object")];
	const errors: ValidationError[] = [];
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
	return errors;
}

// Validates the optional `$.roots` array. Skipped entirely when it isn't an
// array, matching the original `if (Array.isArray(obj.roots))` leniency.
function validateConfigRoots(roots: unknown[], errors: ValidationError[]): void {
	const rootIds = new Set<string>();
	for (let i = 0; i < roots.length; i++) {
		const r = roots[i];
		errors.push(...validateConfigRoot(r, `$.roots[${i}]`, rootIds));
	}
}

// Validates one entry of `$.keys[]`: shape, `name`, `required`, and the four
// string-array fields.
function validateConfigKey(k: unknown, kp: string): ValidationError[] {
	if (!isJsonObject(k)) return [err(kp, "Must be a JSON object")];
	const errors: ValidationError[] = [];
	errors.push(
		...checkUnknownKeys(k, ["name", "required", "docs", "tests", "examples", "declared_in"], kp),
	);

	if (typeof k.name !== "string" || k.name.length === 0) {
		errors.push(err(`${kp}.name`, "Must be a non-empty string"));
	}
	if (typeof k.required !== "boolean") errors.push(err(`${kp}.required`, "Must be a boolean"));
	errors.push(...validateStringArray(k.docs || [], `${kp}.docs`));
	errors.push(...validateStringArray(k.tests || [], `${kp}.tests`));
	errors.push(...validateStringArray(k.examples || [], `${kp}.examples`));
	errors.push(...validateStringArray(k.declared_in || [], `${kp}.declared_in`));
	return errors;
}

export function validateConfigFile(data: unknown): ValidationResult {
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
	const errors = checkUnknownKeys(obj, ["version", "roots", "keys"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	if (Array.isArray(obj.roots)) validateConfigRoots(obj.roots, errors);

	if (!Array.isArray(obj.keys)) {
		errors.push(err("$.keys", "Must be an array"));
		return fail(errors);
	}

	for (let i = 0; i < obj.keys.length; i++) {
		const k: unknown = obj.keys[i];
		errors.push(...validateConfigKey(k, `$.keys[${i}]`));
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
function validateTermId(t: JsonObject, tp: string, termIds: Set<string>): ValidationError[] {
	if (typeof t.id !== "string") return [err(`${tp}.id`, "Must be a string")];
	const errors = validateLocalId(t.id, `${tp}.id`);
	if (termIds.has(t.id)) errors.push(err(`${tp}.id`, `Duplicate term ID "${t.id}"`));
	termIds.add(t.id);
	return errors;
}

// Validates a term's `canonical` field and registers its lowered form in
// `allCanonicals`, reporting a collision with any name already registered.
function validateTermCanonical(
	t: JsonObject,
	tp: string,
	allCanonicals: Map<string, string>,
): ValidationError[] {
	if (typeof t.canonical !== "string" || t.canonical.length === 0) {
		return [err(`${tp}.canonical`, "Must be a non-empty string")];
	}
	const errors: ValidationError[] = [];
	const lower = t.canonical.toLowerCase();
	if (allCanonicals.has(lower)) {
		errors.push(
			err(`${tp}.canonical`, `"${t.canonical}" collides with term "${allCanonicals.get(lower)}"`),
		);
	}
	if (typeof t.id === "string") allCanonicals.set(lower, t.id);
	return errors;
}

// Registers a term's alternate names (aliases or deprecated forms) in
// `allCanonicals`, reporting each one that collides with a name already there.
function registerTermVariants(
	variants: string[],
	path: string,
	termId: string,
	allCanonicals: Map<string, string>,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const variant of variants) {
		const lower = variant.toLowerCase();
		if (allCanonicals.has(lower)) {
			errors.push(err(path, `"${variant}" collides with term "${allCanonicals.get(lower)}"`));
		}
		allCanonicals.set(lower, termId);
	}
	return errors;
}

function validateGlossaryTerm(
	t: unknown,
	tp: string,
	termIds: Set<string>,
	allCanonicals: Map<string, string>,
	errors: ValidationError[],
): void {
	if (!isJsonObject(t)) {
		errors.push(err(tp, "Must be a JSON object"));
		return;
	}
	errors.push(...checkUnknownKeys(t, ["id", "canonical", "aliases", "deprecated", "docs"], tp));
	errors.push(...validateTermId(t, tp, termIds));
	errors.push(...validateTermCanonical(t, tp, allCanonicals));

	errors.push(...validateStringArray(t.aliases || [], `${tp}.aliases`));
	errors.push(...validateStringArray(t.deprecated || [], `${tp}.deprecated`));
	errors.push(...validateStringArray(t.docs || [], `${tp}.docs`));

	// Register aliases and deprecated for collision checking
	if (typeof t.id !== "string") return;
	const termId = t.id;
	const aliases = isStringArray(t.aliases) ? t.aliases : [];
	const deprecated = isStringArray(t.deprecated) ? t.deprecated : [];
	errors.push(...registerTermVariants(aliases, `${tp}.aliases`, termId, allCanonicals));
	errors.push(...registerTermVariants(deprecated, `${tp}.deprecated`, termId, allCanonicals));
}

export function validateGlossaryFile(data: unknown): ValidationResult {
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
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
			obj.terms[i],
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
		const l: unknown = layers[i];
		const lp = `$.layers[${i}]`;
		if (!isJsonObject(l)) {
			errors.push(err(lp, "Must be a JSON object"));
			continue;
		}
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
		const r: unknown = rules[i];
		const rp = `$.rules[${i}]`;
		if (!isJsonObject(r)) {
			errors.push(err(rp, "Must be a JSON object"));
			continue;
		}
		validateLayerRuleEntry(r, rp, layerIds, errors);
	}
}

export function validateLayersFile(data: unknown): ValidationResult {
	if (!isJsonObject(data)) {
		return fail([err("$", "Must be a JSON object")]);
	}
	const obj = data;
	const errors = checkUnknownKeys(obj, ["version", "layers", "rules"], "$");

	if (obj.version !== 1) errors.push(err("$.version", "Must be 1"));

	const layerIds = validateLayerDeclarations(obj.layers, errors);
	validateLayerRules(obj.rules, layerIds, errors);

	return errors.length > 0 ? fail(errors) : ok();
}

// -------------------------------------------
// Dispatcher: validate any artifact file by key
// -------------------------------------------

const VALIDATORS: Readonly<Record<string, ((data: unknown) => ValidationResult) | undefined>> = {
	public_api: validatePublicApiFile,
	env: validateEnvFile,
	config: validateConfigFile,
	tests: validateTestsFile,
	docs: validateDocsFile,
	examples: validateExamplesFile,
	glossary: validateGlossaryFile,
	layers: validateLayersFile,
	packages: validatePackagesFile,
} satisfies Record<ArtifactFileKey, (data: unknown) => ValidationResult>;

export function validateArtifactFile(key: string, data: unknown): ValidationResult {
	const validator = Object.hasOwn(VALIDATORS, key) ? VALIDATORS[key] : undefined;
	return validator ? validator(data) : fail([err("$", `Unknown artifact file key: ${key}`)]);
}
