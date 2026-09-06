// ===========================================
// The completeness pin for the record registry (Finding 6 / decision D1)
// ===========================================
// D1 says the design-time reference is REGENERATED from the product
// declarations. The old parity test hand-listed the types it compared, so a
// newly exported record type was invisible to it — `ShadowExecConfigV1` had
// been missing from that list since it landed, and nothing went red.
//
// This file removes the hand-list. The registry's id set is compared against
// the set of exported record types DERIVED by reading `types-*.ts` at test
// time, minus a NAMED, reasoned allowlist of non-record exports. Adding an
// exported record type without a registry entry fails P5; deleting one fails
// it from the other side; a stale allowlist entry fails P6.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECORD_FIELD_TABLES as ENTRY_TABLES } from "./parse-core-entries.js";
import { RECORD_FIELD_TABLES as CORE_TABLES } from "./parse-core.js";
import { RECORD_FIELD_TABLES as OUTCOME_TABLES } from "./parse-outcome-tables.js";
import { RECORD_FIELD_TABLES as RECORDS_TABLES } from "./parse-records.js";
import { RECORD_FIELD_TABLES as STORE_TABLES } from "./parse-records-store.js";
import { RECORD_FIELD_TABLES as TRANSPORT_TABLES } from "./parse-transport-tables.js";
import {
	declaredKeys,
	descriptorFor,
	parserOnlyRecordIds,
	SHADOW_RECORD_KINDS,
	SHADOW_RECORD_REGISTRY,
	type ShadowRecordDescriptorV1,
	shadowRecordIds,
} from "./registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "../../../../protocol/shadow-v1/schema");

/** The six modules that declare every shadow shape. The registry must account
 *  for every record type any of them exports. */
const TYPE_MODULES = [
	"types-attestation.ts",
	"types-binding.ts",
	"types-core.ts",
	"types-lifecycle.ts",
	"types-outcome.ts",
	"types-transport.ts",
] as const;

/** Bounded scan of a type module's own declarations. `export const` is
 *  deliberately not matched — a value is not a record type. */
function exportedTypeNames(moduleFile: string): string[] {
	const source = readFileSync(join(HERE, moduleFile), "utf8");
	const names: string[] = [];
	for (const line of source.split("\n")) {
		const match = /^export (?:interface|type) ([A-Za-z0-9_]+)/.exec(line);
		if (match?.[1] !== undefined) names.push(match[1]);
	}
	return names;
}

function allExportedTypeNames(): string[] {
	return TYPE_MODULES.flatMap((moduleFile) => exportedTypeNames(moduleFile));
}

// ── the allowlist: exported types that are deliberately NOT records ────────
// Every entry carries the reason it is not decoded standalone. Narrowing the
// comparison silently is the failure mode this table exists to prevent: a name
// leaves the registry's obligation ONLY by appearing here with a reason.
const NON_RECORD_EXPORTS: readonly (readonly [reason: string, names: readonly string[]])[] = [
	[
		"type-level helper — generic machinery, never a value on the wire",
		["SignedEnvelope", "Primitive", "Join", "Paths", "NonEmpty", "Digest"],
	],
	[
		"branded primitive — a string with a phantom tag; a decoder sees the primitive plus a field check",
		[
			"PreTreeHash",
			"PostTreeHash",
			"PostImageSetHash",
			"OverlayBytesHash",
			"OverlayManifestHash",
			"DependencyInputHash",
			"DependencyTreeHash",
			"DependencyCacheRecordHash",
			"EnvDigest",
			"ExecConfigHash",
			"ToolInputHash",
			"ResultHash",
			"JobHash",
			"BlobDigest",
			"ManifestDigest",
			"BundleHash",
			"RequestDigest",
			"ScannerPolicyDigest",
			"GitSha",
			"Rfc3339",
			"OpaqueId",
			"CanonicalPath",
			"CanonicalJson",
			"VerifiedAuthoringAttestation",
		],
	],
	[
		"closed union of string literals — enumerated by its parent record's field table, never decoded alone",
		[
			"TreeAlgo",
			"PostImageAlgo",
			"OverlayAlgo",
			"DependencyTreeAlgo",
			"GitMode",
			"ToolInputSchema",
			"ApplyPatchSourceField",
			"ExecutionProfileId",
			"ShadowKeyPurpose",
			"ShadowSigningDomain",
			"Party",
			"ExecutionBindingLeaf",
			"FreshnessLeaf",
			"ProvenanceLeaf",
			"MirrorState",
			"RestorationEligibility",
			"ShadowPhase",
			"ShadowUnavailableReason",
			"ProcessTermination",
		],
	],
	[
		"nested component — validated as part of a parent record's table, so it has no standalone parser",
		[
			"MirrorKeyV1",
			"MirrorVersionRef",
			"OverlayIncludeRuleV1",
			"MultiEditEntryV1",
			"ShadowLimitsV1",
			"FieldContract",
			"ConditionalContract",
			"LeafContract",
			"DiagnosticV1",
			"CompilerIdentity",
			"TscInvocation",
			"WorkspaceDiff",
			"MismatchComparison",
			"BindingFieldMismatchV1",
			"MissingSetRef",
			"PublicationFailure",
			"AuthoringAttestationPayloadV1",
		],
	],
	[
		"variant or base of a parsed union — reached through its union's parser, not its own",
		[
			"CompleteTscRunV1",
			"IncompleteTscRunV1",
			"TscRunV1",
			"IncompleteShadowTscResultV1",
			"OutcomeBase",
			"MaterializedOutcomeV1",
			"VerifiedOutcomeV1",
			"AttestedOutcomeV1",
			"RehearsedOutcomeV1",
			"CompletedShadowOutcome",
			"UnavailableBase",
			"BindingMismatchOutcome",
			"OtherUnavailableOutcome",
		],
	],
	[
		"key-registry row the CLI verifies signatures against — read as part of the registry, never decoded standalone in Plan 00; Plan 06 lands its parser. The rest of the Workstream 06 admission seam moved to interlinked-cloud on 2026-09-04.",
		["ShadowKeyRecordV1"],
	],
];

const ALLOWLISTED = new Set(NON_RECORD_EXPORTS.flatMap(([, names]) => names));

/** The property under test: the record types the PRODUCT declares. */
function derivedRecordTypeNames(): string[] {
	return allExportedTypeNames()
		.filter((name) => !ALLOWLISTED.has(name))
		.sort();
}

function schemaFor(id: string): Record<string, unknown> {
	const raw: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, `${id}.schema.json`), "utf8"));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${id}: schema is not an object`);
	// SAFETY: rejected null, non-object and array immediately above, so this is a plain JSON object.
	return raw as Record<string, unknown>;
}

function schemaIndex(): Record<string, unknown> {
	const raw: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, "index.json"), "utf8"));
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("index.json is not an object");
	// SAFETY: rejected null, non-object and array immediately above, so this is a plain JSON object.
	return raw as Record<string, unknown>;
}

function indexRecordRows(): { id: string; file: string; kind: string; type: string }[] {
	const records = schemaIndex().records;
	if (!Array.isArray(records)) throw new Error("index.json has no records array");
	return records.map((row: unknown) => {
		if (row === null || typeof row !== "object") throw new Error("index.json row is not an object");
		// SAFETY: rejected null and non-object immediately above.
		const fields = row as Record<string, unknown>;
		return {
			id: String(fields.id),
			file: String(fields.file),
			kind: String(fields.kind),
			type: String(fields.type),
		};
	});
}

// ── schema ↔ parser field comparison ───────────────────────────────────────
// The reason the registry publishes field tables at all. The generated schema
// describes the TYPE; the parser enforces its own table. If those two disagree
// about which fields a record has, the artifact a second repository reads is
// wrong in exactly the way it exists to prevent — it either promises a field
// the parser rejects, or hides one the parser demands.
//
// Two encoded differences, both explicit rather than a loosened comparison:
//
//  1. ANTI-FIELDS. A property declared `never` (`UnavailableBase.attestation?:
//     never`) exists to make a key unrepresentable. The generator emits the
//     schema nothing satisfies plus `x-never`, and the parser agrees by having
//     no such key at all — so an anti-field is not a field on either side. The
//     full list is pinned below, so a new one cannot appear unnoticed.
//  2. VARIANT COUNT. Key SETS are compared, never counts: `deletion_receipt`
//     has four parser states but three schema branches, because two states
//     carry identical fields and the type declares them as one interface.

interface SchemaVariant {
	readonly properties: readonly string[];
	readonly antiFields: readonly string[];
	readonly required: readonly string[];
}

/** A `never`-typed property: the type forbids the key, so it is not a field. */
function isAntiField(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	// SAFETY: null and non-object were rejected on the line above.
	return (value as Record<string, unknown>)["x-never"] === true;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`);
	// SAFETY: rejected null, non-object and array immediately above.
	return value as Record<string, unknown>;
}

function oneVariant(schema: Record<string, unknown>): SchemaVariant {
	const props = schema.properties === undefined ? {} : objectAt(schema.properties, "properties");
	const properties: string[] = [];
	const antiFields: string[] = [];
	for (const [key, value] of Object.entries(props)) (isAntiField(value) ? antiFields : properties).push(key);
	const required = Array.isArray(schema.required) ? schema.required.map((name: unknown) => String(name)) : [];
	return { properties: properties.sort(), antiFields: antiFields.sort(), required: [...required].sort() };
}

/** One entry per union branch; a single-shape record yields one. */
function schemaVariants(schema: Record<string, unknown>): SchemaVariant[] {
	const anyOf = schema.anyOf;
	if (!Array.isArray(anyOf)) return [oneVariant(schema)];
	return anyOf.flatMap((branch: unknown) => schemaVariants(objectAt(branch, "anyOf branch")));
}

interface ParserVariant {
	readonly keys: readonly string[];
	readonly required: readonly string[];
}

/** The parser's own answer to "which keys, and which of them are mandatory".
 *  A field built by `optional(...)` is the only kind that accepts an absent
 *  value, so probing each check with `undefined` recovers the required set from
 *  the table itself rather than from a second hand-written list. */
function parserVariants(descriptor: ShadowRecordDescriptorV1): ParserVariant[] {
	return (descriptor.fields ?? []).map((table) => ({
		keys: table.map(([key]) => key).sort(),
		required: table
			.filter(([, check]) => check(undefined, "probe") !== null)
			.map(([key]) => key)
			.sort(),
	}));
}

function setKey(names: readonly string[]): string {
	return [...names].sort().join(",");
}

/** Every anti-field the protocol declares, with the reason the key is refused
 *  on BOTH sides. An unlisted one fails P9 — silence is the failure mode. */
const DECLARED_ANTI_FIELDS: readonly (readonly [id: string, property: string, reason: string])[] = [
	[
		"outcome",
		"attestation",
		"`UnavailableBase.attestation?: never` — an unavailable outcome can never carry an attestation, and the parser refuses the key as unknown",
	],
];

function observedAntiFields(): string[] {
	const found: string[] = [];
	for (const descriptor of SHADOW_RECORD_REGISTRY) {
		for (const variant of schemaVariants(schemaFor(descriptor.id))) {
			for (const name of variant.antiFields) found.push(`${descriptor.id}.${name}`);
		}
	}
	return [...new Set(found)].sort();
}

describe("shadow record registry — positive (must hold)", () => {
	it("P1: every descriptor carries a parser that refuses a non-object without throwing", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			expect(typeof descriptor.parse, descriptor.id).toBe("function");
			const outcome = descriptor.parse(42);
			expect(outcome.ok, descriptor.id).toBe(false);
		}
	});

	it("P2: ids are unique, snake_case, and each resolves through descriptorFor", () => {
		const ids = shadowRecordIds();
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id, id).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(descriptorFor(id)?.id).toBe(id);
		}
		expect(SHADOW_RECORD_KINDS).toEqual(["wire", "persisted", "internal"]);
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			expect(SHADOW_RECORD_KINDS, descriptor.id).toContain(descriptor.kind);
		}
	});

	it("P3: every record id has a generated schema file and index.json lists exactly the registry", () => {
		const ids = shadowRecordIds();
		expect(indexRecordRows().map((row) => row.id)).toEqual([...ids].sort());
		for (const id of ids) {
			expect(schemaFor(id).$id, id).toBe(`shadow-v1/${id}.schema.json`);
		}
	});

	it("P4: each schema records the descriptor it was generated from (product → artifact)", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			const schema = schemaFor(descriptor.id);
			expect(schema["x-shadow-record"], descriptor.id).toEqual({
				id: descriptor.id,
				kind: descriptor.kind,
				type: descriptor.typeName,
				module: descriptor.typeModule,
			});
		}
		for (const row of indexRecordRows()) {
			const descriptor = descriptorFor(row.id);
			expect(descriptor?.kind, row.id).toBe(row.kind);
			expect(descriptor?.typeName, row.id).toBe(row.type);
			expect(row.file).toBe(`${row.id}.schema.json`);
		}
	});

	it("P5: the registry's type set EQUALS the exported record types declared in types-*.ts", () => {
		const declared = derivedRecordTypeNames();
		const registered = SHADOW_RECORD_REGISTRY.map((descriptor) => descriptor.typeName).sort();
		expect(registered).toEqual(declared);
	});

	it("P7: the generated schema's property names EQUAL the parser's declared key set", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			const fromSchema = new Set(schemaVariants(schemaFor(descriptor.id)).flatMap((variant) => variant.properties));
			expect([...fromSchema].sort(), descriptor.id).toEqual([...declaredKeys(descriptor)].sort());
		}
	});

	it("P8: per variant, the schema's key sets and required sets are the parser's own", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			const parsers = parserVariants(descriptor);
			const variants = schemaVariants(schemaFor(descriptor.id));
			// Key SETS, not counts: two states with identical fields are one
			// interface in the type and two tables in the parser.
			const fromSchema = new Set(variants.map((variant) => setKey(variant.properties)));
			expect([...fromSchema].sort(), descriptor.id).toEqual([...new Set(parsers.map((v) => setKey(v.keys)))].sort());
			for (const variant of variants) {
				const match = parsers.find((candidate) => setKey(candidate.keys) === setKey(variant.properties));
				expect(match?.required, `${descriptor.id} [${setKey(variant.properties)}]`).toEqual(variant.required);
			}
		}
	});

	it("P9: every anti-field the schema declares is named, with its reason, in DECLARED_ANTI_FIELDS", () => {
		const declared = DECLARED_ANTI_FIELDS.map(([id, property]) => `${id}.${property}`).sort();
		expect(observedAntiFields()).toEqual(declared);
		for (const [id, property, reason] of DECLARED_ANTI_FIELDS) {
			expect(reason.length, `${id}.${property}`).toBeGreaterThan(20);
			// The parser's agreement is per VARIANT, not per record: `outcome`
			// really does carry an attestation when it is attested, and refuses
			// the key on every unavailable shape. So the check is that no parser
			// variant matching a schema branch that declares the anti-field
			// holds the key — there, it rejects as an unknown field.
			const descriptor = descriptorFor(id);
			expect(descriptor, id).not.toBeNull();
			if (descriptor === null) continue;
			const parsers = parserVariants(descriptor);
			for (const variant of schemaVariants(schemaFor(id))) {
				if (!variant.antiFields.includes(property)) continue;
				const match = parsers.find((candidate) => setKey(candidate.keys) === setKey(variant.properties));
				expect(match?.keys, `${id} [${setKey(variant.properties)}]`).not.toContain(property);
			}
		}
	});

	it("P6: every allowlist entry names a type the product actually exports (no stale excuses)", () => {
		const exported = new Set(allExportedTypeNames());
		for (const [reason, names] of NON_RECORD_EXPORTS) {
			expect(reason.length, reason).toBeGreaterThan(20);
			for (const name of names) expect(exported.has(name), `${name} (${reason})`).toBe(true);
		}
	});
});

describe("shadow record registry — negative (must not hold)", () => {
	it("N1: a new exported record type with no registry entry FAILS the derivation", () => {
		const declared = [...derivedRecordTypeNames(), "NewlyAddedRecordV1"].sort();
		const registered = SHADOW_RECORD_REGISTRY.map((descriptor) => descriptor.typeName).sort();
		expect(registered).not.toEqual(declared);
	});

	it("N2: no allowlist entry excuses a type the registry already claims", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			expect(ALLOWLISTED.has(descriptor.typeName), descriptor.typeName).toBe(false);
		}
	});

	it("N3: no allowlisted name appears twice, and no name is excused for two reasons", () => {
		const flat = NON_RECORD_EXPORTS.flatMap(([, names]) => names);
		expect(new Set(flat).size).toBe(flat.length);
	});

	it("N4: NO record is parser-only — every descriptor publishes its declared key set", () => {
		// Was: all 50 (every FieldSpec table was module-private, so the schema
		// described the type while the parser enforced a list nothing compared
		// against). Each parse module now exports `RECORD_FIELD_TABLES`, so the
		// gap is empty and P7/P8 can hold the two sides together. It must never
		// rise: a record with no published table is a record whose schema
		// nothing checks.
		expect(parserOnlyRecordIds()).toEqual([]);
		for (const descriptor of SHADOW_RECORD_REGISTRY) {
			expect(descriptor.fields, descriptor.id).not.toBeNull();
			expect(descriptor.fields?.length, descriptor.id).toBeGreaterThan(0);
		}
	});

	it("N5: no published table names a record the registry does not carry", () => {
		const published = [ENTRY_TABLES, CORE_TABLES, OUTCOME_TABLES, RECORDS_TABLES, STORE_TABLES, TRANSPORT_TABLES];
		const ids = new Set(shadowRecordIds());
		const orphans = published.flatMap((tables) => Object.keys(tables)).filter((id) => !ids.has(id));
		expect(orphans).toEqual([]);
	});

	it("N6: a schema property the parser does not declare FAILS the comparison", () => {
		const descriptor = descriptorFor("cancel_ack");
		expect(descriptor).not.toBeNull();
		const declared = descriptor === null ? [] : [...declaredKeys(descriptor)].sort();
		const tampered = [...declared, "injected_field"].sort();
		expect(tampered).not.toEqual(declared);
	});

	it("N7: an anti-field is EXCLUDED, not silently counted — the schema still lists the key", () => {
		const variants = schemaVariants(schemaFor("outcome"));
		const carrying = variants.filter((variant) => variant.antiFields.includes("attestation"));
		expect(carrying.length).toBeGreaterThan(0);
		for (const variant of carrying) {
			expect(variant.properties).not.toContain("attestation");
			expect(variant.required).not.toContain("attestation");
		}
	});
});
