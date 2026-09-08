// Generates `protocol/shadow-v1/schema/` from the shadow protocol package.
//   npx tsx scripts/gen-shadow-schema.mts
//
// Direction is PRODUCT → ARTIFACT and never the reverse (memo
// `docs/design/remote-shadow-execution.md` §8.0, first bullet; decision D1).
// The record list comes from `src/harness/shadow/protocol/registry.ts` and the
// shape of each record comes from the TypeScript declaration that registry row
// names, read through the compiler's own checker. Nothing here describes the
// protocol a second time, so the artifact cannot drift from the declarations:
// `registry.test.ts` P3/P4 fail the suite if a record has no schema file, and
// re-running this script after a type change rewrites the JSON.
//
// The emitted JSON Schema is Draft 2020-12 with `additionalProperties: false`,
// matching the strict parsers: an unknown field is a rejection, not an extra.
//
// WHAT THE SCHEMA IS (review 2, finding 6): STRUCTURAL SHAPE METADATA. It
// carries exactly what the declarations carry — keys, required sets, literal
// discriminators, brand patterns, integer-ness — and nothing the parsers add
// on top: per-field byte and array bounds, calendar validity of a timestamp,
// canonical-path rules, set/sort semantics, reason/phase compatibility. Every
// schema says so in `x-shadow-contract`, and
// `__tests__/schema-differential.test.ts` pins BY NAME the malformed-corpus
// rows the schema alone would accept. Schema validity is necessary, never
// sufficient: a second implementation ports the validators and runs the corpus.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
	SHADOW_RECORD_REGISTRY,
	type ShadowRecordDescriptorV1,
} from "../protocol/registry.js";

const PROTOCOL_DIR = join(import.meta.dirname, "../protocol");
const OUT = join(import.meta.dirname, "../../../../protocol/shadow-v1/schema");
/** Deep enough for the deepest record (request → claim → content → entries),
 *  shallow enough that a mistake cannot spin. */
const MAX_DEPTH = 12;

type Schema = Record<string, unknown>;

const CONTRACT_LABEL = {
	"x-shadow-contract": "structural-shape",
	"x-shadow-contract-meaning":
		"Shape metadata derived from the TypeScript declarations only (keys, required sets, literals, brand patterns, integers). NOT the validator: byte/array bounds, calendar validity, path rules, set/sort semantics and cross-field rules live in the parsers. A second implementation must port field-checks.ts and the parse-*.ts modules and execute protocol/shadow-v1/fixtures/malformed-corpus.json; schema validity is necessary, not sufficient.",
} as const;

/** The parsers' own regexes (field-checks.ts, module-private there), copied
 *  VERBATIM. `schema-differential.test.ts` P5–P8 probe the emitted pattern
 *  against the exported check functions, so a paraphrase fails the suite. Only
 *  brands with a regex get one: `canonical-path` and `canonical-json` are
 *  decided by code (path-rules.ts / the canonical serializer), not a pattern. */
const BRAND_PATTERNS: Readonly<Record<string, string>> = {
	__digest: "^[0-9a-f]{64}$",
	"__brand:gitsha": "^[0-9a-f]{40}$",
	"__brand:rfc3339": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
	"__brand:opaque-id": "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$",
};

// ── the program ────────────────────────────────────────────────────────────

const TYPE_MODULES = [
	"types-attestation.ts",
	"types-binding.ts",
	"types-core.ts",
	"types-lifecycle.ts",
	"types-outcome.ts",
	"types-transport.ts",
];

const program = ts.createProgram(
	TYPE_MODULES.map((file) => join(PROTOCOL_DIR, file)),
	{
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		exactOptionalPropertyTypes: true,
		skipLibCheck: true,
		noEmit: true,
	},
);
const checker = program.getTypeChecker();

function declarationOf(moduleFile: string, typeName: string): ts.Declaration {
	const source = program.getSourceFile(join(PROTOCOL_DIR, moduleFile));
	if (source === undefined) throw new Error(`${moduleFile}: not in the program`);
	for (const statement of source.statements) {
		const named = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
		if (named && statement.name.text === typeName) return statement;
	}
	throw new Error(`${moduleFile}: no exported interface or type named ${typeName}`);
}

function declaredType(declaration: ts.Declaration): ts.Type {
	const symbol = checker.getSymbolAtLocation(
		ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
			? declaration.name
			: declaration,
	);
	if (symbol === undefined) throw new Error("declaration has no symbol");
	return checker.getDeclaredTypeOfSymbol(symbol);
}

// ── type → schema ──────────────────────────────────────────────────────────

/** A property declared `never` (`attestation?: never` on `UnavailableBase`) is
 *  an ANTI-FIELD: the type exists to make the key unrepresentable, and the
 *  parser agrees by leaving it out of its table so it rejects as an unknown
 *  field. Rendering it as `{}` or `{"type":"object"}` would say the opposite —
 *  that a value is allowed — so it emits the schema nothing satisfies, plus a
 *  marker the registry test reads to tell an anti-field from a real one. */
const NEVER_SCHEMA: Schema = { not: {}, "x-never": true };

const PRIMITIVES: readonly (readonly [ts.TypeFlags, Schema])[] = [
	[ts.TypeFlags.Never, NEVER_SCHEMA],
	[ts.TypeFlags.Any, {}],
	[ts.TypeFlags.Unknown, {}],
	[ts.TypeFlags.Null, { type: "null" }],
	[ts.TypeFlags.Undefined, { "x-absent": true }],
	[ts.TypeFlags.Void, { "x-absent": true }],
	[ts.TypeFlags.Boolean, { type: "boolean" }],
	[ts.TypeFlags.String, { type: "string" }],
	// Every numeric field in this protocol is a count, a size, a version or a
	// code, and every parser table checks it with `checkSafeNonNegInt`
	// (field-checks.ts): non-negative integer is the FLOOR the declarations
	// share. The per-field maximum is parser-only and deliberately not emitted.
	[ts.TypeFlags.Number, { type: "integer", minimum: 0 }],
];

function literalSchema(type: ts.Type): Schema | null {
	if (type.isStringLiteral()) return { const: type.value };
	if (type.isNumberLiteral()) return { const: type.value };
	if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
		return { const: checker.typeToString(type) === "true" };
	}
	return null;
}

function primitiveSchema(type: ts.Type): Schema | null {
	const literal = literalSchema(type);
	if (literal !== null) return literal;
	for (const [flag, schema] of PRIMITIVES) {
		if ((type.flags & flag) !== 0) return schema;
	}
	return null;
}

function elementTypeOf(type: ts.Type): ts.Type | null {
	const name = type.symbol?.name;
	if (name !== "Array" && name !== "ReadonlyArray") return null;
	return checker.getIndexTypeOfType(type, ts.IndexKind.Number) ?? null;
}

function arraySchema(type: ts.Type, depth: number): Schema | null {
	const element = elementTypeOf(type);
	if (element === null) return null;
	return { type: "array", items: schemaOfType(element, depth + 1) };
}

/** Tuples retain their declared required prefix and optional trailing rest. */
function tupleSchema(type: ts.Type, depth: number): Schema | null {
	if (!checker.isTupleType(type)) return null;
	// SAFETY: the compiler's isTupleType predicate identifies TupleTypeReference;
	// its public declaration returns boolean rather than a narrowing predicate.
	const tuple = type as ts.TupleTypeReference;
	const target = tuple.target;
	if ((target.combinedFlags & ts.ElementFlags.Variadic) !== 0) throw new Error("Unresolved variadic tuple in schema");
	const elements = checker.getTypeArguments(tuple);
	const prefixItems = elements.slice(0, target.fixedLength).map((element) => schemaOfType(element, depth + 1));
	const schema: Schema = { type: "array", minItems: target.minLength };
	if (prefixItems.length > 0) schema.prefixItems = prefixItems;
	const rest = elements[target.fixedLength];
	if ((target.combinedFlags & ts.ElementFlags.Rest) !== 0) {
		if (rest === undefined || elements.length !== target.fixedLength + 1) throw new Error("Unsupported tuple rest position");
		schema.items = schemaOfType(rest, depth + 1);
	} else {
		schema.items = false;
		schema.maxItems = target.fixedLength;
	}
	return schema;
}

function unionSchema(type: ts.UnionType, depth: number): Schema {
	const members = type.types.map((member) => schemaOfType(member, depth + 1));
	const consts = members.filter((member) => typeof member.const === "string");
	if (consts.length === members.length && members.length > 0) {
		return { type: "string", enum: consts.map((member) => member.const) };
	}
	const seen = new Map<string, Schema>();
	for (const member of members) seen.set(JSON.stringify(member), member);
	return { anyOf: [...seen.values()] };
}

/** The phantom member's literal value (`"gitsha"` in `__brand: "gitsha"`),
 *  or null when it is not a string literal. */
function brandValue(prop: ts.Symbol): string | null {
	const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
	if (declaration === undefined) return null;
	const type = checker.getTypeOfSymbolAtLocation(prop, declaration);
	return type.isStringLiteral() ? type.value : null;
}

/** A branded primitive (`string & { readonly __brand: "gitsha" }`) is a string
 *  on the wire; the phantom members are recorded as `x-brand`, never emitted
 *  as fields. Returns the phantom name → literal value map, or null when a
 *  non-primitive member carries a real (non-phantom) property. */
function brandsOf(members: readonly ts.Type[]): Record<string, string | null> | null {
	const brands: Record<string, string | null> = {};
	for (const member of members) {
		if (primitiveSchema(member) !== null) continue;
		const props = checker.getPropertiesOfType(member);
		if (props.length === 0 || !props.every((prop) => prop.name.startsWith("__"))) return null;
		for (const prop of props) brands[prop.name] = brandValue(prop);
	}
	return brands;
}

/** The parser regex for a brand, when field-checks.ts has one: every
 *  `__digest` is a sha-256, and `__brand` is looked up by its literal. */
function brandPattern(brands: Readonly<Record<string, string | null>>): string | null {
	for (const [name, value] of Object.entries(brands)) {
		const pattern = BRAND_PATTERNS[name] ?? (value === null ? undefined : BRAND_PATTERNS[`${name}:${value}`]);
		if (pattern !== undefined) return pattern;
	}
	return null;
}

function intersectionSchema(type: ts.IntersectionType, depth: number): Schema {
	const primitives = type.types.map((member) => primitiveSchema(member)).filter((member) => member !== null);
	const brands = brandsOf(type.types);
	if (primitives.length === 1 && brands !== null && primitives[0] !== undefined) {
		const schema: Schema = { ...primitives[0], "x-brand": brands };
		const pattern = brandPattern(brands);
		if (pattern !== null) schema.pattern = pattern;
		return schema;
	}
	return objectSchema(type, depth);
}

function propertySchema(prop: ts.Symbol, depth: number): Schema {
	const declaration = prop.valueDeclaration ?? prop.declarations?.[0];
	if (declaration === undefined) return {};
	return schemaOfType(checker.getTypeOfSymbolAtLocation(prop, declaration), depth + 1);
}

function objectSchema(type: ts.Type, depth: number): Schema {
	const props = checker.getPropertiesOfType(type);
	if (props.length === 0) return { type: "object" };
	const properties: Schema = {};
	const required: string[] = [];
	for (const prop of props) {
		properties[prop.name] = propertySchema(prop, depth);
		if ((prop.flags & ts.SymbolFlags.Optional) === 0) required.push(prop.name);
	}
	return { type: "object", properties, required: required.sort(), additionalProperties: false };
}

function schemaOfType(type: ts.Type, depth: number): Schema {
	if (depth > MAX_DEPTH) return { "x-truncated": true };
	const primitive = primitiveSchema(type);
	if (primitive !== null) return primitive;
	if (type.isUnion()) return unionSchema(type, depth);
	if (type.isIntersection()) return intersectionSchema(type, depth);
	const tuple = tupleSchema(type, depth);
	if (tuple !== null) return tuple;
	const array = arraySchema(type, depth);
	if (array !== null) return array;
	return objectSchema(type, depth);
}

// ── emission ───────────────────────────────────────────────────────────────

/** Key-sorted JSON so a regenerated file differs only where the contract did. */
function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
	return Object.fromEntries(entries.map(([key, inner]) => [key, stable(inner)]));
}

function schemaForRecord(descriptor: ShadowRecordDescriptorV1): Schema {
	const declaration = declarationOf(descriptor.typeModule, descriptor.typeName);
	const body = schemaOfType(declaredType(declaration), 0);
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: `shadow-v1/${descriptor.id}.schema.json`,
		title: descriptor.typeName,
		description: `Shadow protocol v1 ${descriptor.kind} record "${descriptor.id}", generated from ${descriptor.typeModule}.`,
		...CONTRACT_LABEL,
		"x-shadow-record": {
			id: descriptor.id,
			kind: descriptor.kind,
			type: descriptor.typeName,
			module: descriptor.typeModule,
		},
		...body,
	};
}

function serialize(value: unknown): string {
	return `${JSON.stringify(stable(value), null, "\t")}\n`;
}

/** The whole computation, as pure bytes keyed by filename — nothing here
 *  touches the filesystem. `--check` and the freshness test both call this and
 *  compare against what is on disk, so drift between "what we'd write" and
 *  "what is committed" can never hide behind a generator that only ever
 *  writes. Exported so the CLI and the in-process test share one algorithm. */
export function renderShadowSchema(): Map<string, string> {
	const sorted = [...SHADOW_RECORD_REGISTRY].sort((a, b) => (a.id < b.id ? -1 : 1));
	const rows = sorted.map((descriptor) => ({
		id: descriptor.id,
		kind: descriptor.kind,
		type: descriptor.typeName,
		module: descriptor.typeModule,
		file: `${descriptor.id}.schema.json`,
	}));
	const files = new Map<string, string>();
	for (const descriptor of sorted) {
		files.set(`${descriptor.id}.schema.json`, serialize(schemaForRecord(descriptor)));
	}
	files.set(
		"index.json",
		serialize({
			schema_version: 1,
			protocol: "shadow-v1",
			generated_by: "scripts/gen-shadow-schema.mts",
			source_of_truth: "src/harness/shadow/protocol/registry.ts",
			...CONTRACT_LABEL,
			records: rows,
		}),
	);
	return files;
}

function isSchemaEntry(entry: string): boolean {
	return entry.endsWith(".schema.json") || entry === "index.json";
}

function currentFiles(): Map<string, string> {
	if (!existsSync(OUT)) return new Map();
	const current = new Map<string, string>();
	for (const entry of readdirSync(OUT)) {
		if (isSchemaEntry(entry)) current.set(entry, readFileSync(join(OUT, entry), "utf8"));
	}
	return current;
}

/** Byte-compares the rendered output against every committed file in
 *  `protocol/shadow-v1/schema/` — an EXTRA file on disk (one `render()` would
 *  not write) counts as drift too, so a removed record's stale schema cannot
 *  survive unnoticed. Returns true when fresh. */
export function checkShadowSchemaFresh(rendered: ReadonlyMap<string, string>, onDisk: ReadonlyMap<string, string>): boolean {
	if (rendered.size !== onDisk.size) return false;
	for (const [file, content] of rendered) {
		if (onDisk.get(file) !== content) return false;
	}
	return true;
}

function removeStale(keep: ReadonlySet<string>): void {
	for (const entry of readdirSync(OUT)) {
		if (isSchemaEntry(entry) && !keep.has(entry)) rmSync(join(OUT, entry));
	}
}

function write(rendered: ReadonlyMap<string, string>): void {
	mkdirSync(OUT, { recursive: true });
	removeStale(new Set(rendered.keys()));
	for (const [file, content] of rendered) writeFileSync(join(OUT, file), content);
}

function check(rendered: ReadonlyMap<string, string>): void {
	if (checkShadowSchemaFresh(rendered, currentFiles())) {
		process.stdout.write(`protocol/shadow-v1/schema/ is fresh (${rendered.size} files)\n`);
		return;
	}
	process.stderr.write(
		"protocol/shadow-v1/schema/ is STALE — the shadow protocol changed without regenerating the schemas.\n" +
			"Run: npx tsx scripts/gen-shadow-schema.mts, then re-vendor and re-pin the digest.\n",
	);
	process.exitCode = 1;
}

export function runShadowSchemaGenerator(): void {
	const rendered = renderShadowSchema();
	if (process.argv.includes("--check")) {
		check(rendered);
		return;
	}
	write(rendered);
	console.log(`wrote ${rendered.size} files to ${OUT}`);
}
