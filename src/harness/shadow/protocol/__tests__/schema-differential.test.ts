// ===========================================
// Schema ↔ parser differential — how much the JSON Schema does NOT say
// ===========================================
// `protocol/shadow-v1/schema/` is STRUCTURAL SHAPE METADATA (review 2, finding
// 6): it carries what the TypeScript declarations carry — keys, required sets,
// literals, brand patterns, integer-ness — and nothing the parsers add on top
// (byte bounds, array bounds, calendar validity, path rules, cross-field
// reason/phase compatibility). A second implementation therefore cannot
// validate against the schema INSTEAD of porting the parsers.
//
// This suite measures that gap instead of asserting it away:
//   - every malformed-corpus row is run through Ajv against its record's schema;
//     the rows the SCHEMA ALONE accepts are pinned BY NAME below, so the list
//     can only shrink;
//   - a row the schema REJECTS while the parser ACCEPTS is a bug (the schema
//     over-constrains) and fails;
//   - every accepted corpus value (projected tool inputs, their changesets, the
//     identity table's changesets) must be schema-valid — the floor.

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkGitSha, checkOpaqueId, checkRfc3339, checkSha256Hex } from "../field-checks.js";
import { descriptorFor, SHADOW_RECORD_REGISTRY } from "../registry.js";

const PROTOCOL = join(dirname(fileURLToPath(import.meta.url)), "../../../../../protocol/shadow-v1");
const SCHEMA_DIR = join(PROTOCOL, "schema");
const FIXTURES = join(PROTOCOL, "fixtures");

type Json = Record<string, unknown>;

function loadJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8"));
}
function objectAt(value: unknown, where: string): Json {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is not an object`);
	// SAFETY: guarded one line above.
	return value as Json;
}
function arrayAt(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
	return value;
}

/** Corpus rows, read loosely: this suite is about the schema, so it must not
 *  depend on the product's own types to describe the fixtures. */
interface MalformedRow {
	id: string;
	parser: string;
	value: unknown;
}
interface ProjectionRow {
	id: string;
	tool_input: unknown;
	expect: Json;
}
interface IdentityRow {
	id: string;
	a: unknown;
	b: unknown;
}

const malformed = arrayAt(loadJson(join(FIXTURES, "malformed-corpus.json")), "malformed-corpus").map((row) => {
	const r = objectAt(row, "malformed row");
	return { id: String(r.id), parser: String(r.parser), value: r.value } satisfies MalformedRow;
});
const projections = arrayAt(loadJson(join(FIXTURES, "projection-corpus.json")), "projection-corpus").map((row) => {
	const r = objectAt(row, "projection row");
	return { id: String(r.id), tool_input: r.tool_input, expect: objectAt(r.expect, "expect") } satisfies ProjectionRow;
});
const identities = arrayAt(loadJson(join(FIXTURES, "identity-table.json")), "identity-table").map((row) => {
	const r = objectAt(row, "identity row");
	return { id: String(r.id), a: r.a, b: r.b } satisfies IdentityRow;
});

/** malformed-corpus `parser` label → registry record id. Explicit, so a
 *  renamed label fails here instead of silently validating nothing. */
const PARSER_TO_RECORD: Readonly<Record<string, string>> = {
	change_set: "change_set",
	execution_manifest: "execution_manifest",
	overlay_manifest: "overlay_manifest",
	tool_input: "tool_input",
	claim: "execution_claim",
	dependency_request: "dependency_request",
	freshness: "freshness_binding",
	outcome: "outcome",
	dependency_cache_record: "dependency_cache_record",
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();
function validatorFor(recordId: string): ValidateFunction {
	const cached = validators.get(recordId);
	if (cached !== undefined) return cached;
	const compiled = ajv.compile(objectAt(loadJson(join(SCHEMA_DIR, `${recordId}.schema.json`)), recordId));
	validators.set(recordId, compiled);
	return compiled;
}
function schemaAccepts(recordId: string, value: unknown): boolean {
	return validatorFor(recordId)(value) === true;
}
function parserAccepts(recordId: string, value: unknown): boolean {
	const descriptor = descriptorFor(recordId);
	if (descriptor === null) throw new Error(`no registry record ${recordId}`);
	return descriptor.parse(value).ok;
}
function recordIdOf(parserLabel: string): string {
	const id = PARSER_TO_RECORD[parserLabel];
	if (id === undefined) throw new Error(`malformed-corpus parser label ${parserLabel} has no record mapping`);
	return id;
}

// ── the pinned gap ─────────────────────────────────────────────────────────
// Every malformed row the SCHEMA accepts although the PARSER rejects it. Each
// name is a rule the schema cannot express; the list may only SHRINK (a row
// that leaves it moved into the schema's reach, and the pin must follow).
// 8 of 26 rows on landing, 17 of 41 after the second review (both
// 2026-09-04): the overlay-manifest rows arrived with the shared validator,
// and none of their rules (non-empty, gitwildmatch grammar, set semantics,
// canonical order, the 1 024 cap) is a shape the schema can state without
// inventing bounds the types do not carry. The others fail the schema on
// structure the declarations DO carry: unknown keys, literal discriminators,
// brand patterns, integer-ness, and the union's own variant shapes (the two
// `outcome` unrepresentable-combination rows fall here, not below).
const SCHEMA_ACCEPTS_PARSER_REJECTS: readonly string[] = [
	"change-set-duplicate-touched-path", // set semantics of touched_paths
	"change-set-touched-paths-utf16-order", // byte-order sort of touched_paths
	"change-set-traversal-path", // canonical-path rules (path-rules.ts)
	"change-set-unsorted-touched-paths", // sorted touched_paths
	"dependency-cache-record-impossible-instant", // calendar validity (field-checks.ts) — the pattern admits Feb 30
	"outcome-reason-phase-mismatch", // reason/phase compatibility (reason-phases.ts)
	"overlay-manifest-duplicate-exact-rule", // set semantics of include_rules
	"overlay-manifest-duplicate-pattern-after-normalization", // set semantics after pattern normalization
	"overlay-manifest-empty-include-rules", // non-empty rules (schema has no minItems)
	"overlay-manifest-exact-rules-unsorted", // canonical order
	"overlay-manifest-impossible-class", // gitwildmatch grammar (pattern is a bare string)
	"overlay-manifest-over-rule-cap", // the 1 024-rule cap (no maxItems)
	"overlay-manifest-pattern-before-exact", // canonical order (exact before pattern)
	"overlay-manifest-unnormalized-pattern", // pattern normalization
	"tool-input-absolute-file-path", // canonical-path rules
	"tool-input-multiedit-empty-edits", // non-empty edits
	"tool-input-traversal-file-path", // canonical-path rules
];

describe("schema differential — negative (the schema alone must not be trusted)", () => {
	it("N1: every malformed-corpus parser label maps to a registered record", () => {
		for (const row of malformed) {
			const id = recordIdOf(row.parser);
			expect(descriptorFor(id), `${row.id}: ${row.parser} → ${id}`).not.toBeNull();
		}
	});

	it("N2: the rows the schema ALONE accepts are exactly the pinned, named gap", () => {
		const accepted = malformed.filter((row) => schemaAccepts(recordIdOf(row.parser), row.value)).map((row) => row.id);
		expect([...accepted].sort()).toEqual([...SCHEMA_ACCEPTS_PARSER_REJECTS].sort());
	});

	it("N3: no malformed row is accepted by the parser — the corpus is a rejection corpus", () => {
		const leaked = malformed.filter((row) => parserAccepts(recordIdOf(row.parser), row.value)).map((row) => row.id);
		expect(leaked).toEqual([]);
	});

	it("N4: a shape-valid but impossible RFC3339 instant passes the schema pattern and fails the parser", () => {
		const pattern = patternAt("dependency_cache_record", ["properties", "expires_at"]);
		expect(new RegExp(pattern, "u").test("2026-02-30T12:00:00Z")).toBe(true);
		expect(checkRfc3339("2026-02-30T12:00:00Z", "f")).not.toBeNull();
	});
});

describe("schema differential — positive (schema-valid is a floor accepted values clear)", () => {
	it("P1: a value the schema rejects is never one the parser accepts (over-constraint is a bug)", () => {
		const bugs: string[] = [];
		for (const row of malformed) {
			const id = recordIdOf(row.parser);
			if (!schemaAccepts(id, row.value) && parserAccepts(id, row.value)) bugs.push(row.id);
		}
		for (const row of projections) {
			if (!schemaAccepts("tool_input", row.tool_input) && parserAccepts("tool_input", row.tool_input)) bugs.push(row.id);
		}
		expect(bugs).toEqual([]);
	});

	for (const row of projections.filter((candidate) => candidate.expect.kind === "projected")) {
		it(`P2 [${row.id}]: projected tool input and its changeset are schema-valid AND parser-accepted`, () => {
			expect(parserAccepts("tool_input", row.tool_input)).toBe(true);
			expect(schemaAccepts("tool_input", row.tool_input), JSON.stringify(validatorFor("tool_input").errors)).toBe(true);
			expect(parserAccepts("change_set", row.expect.changeset)).toBe(true);
			expect(schemaAccepts("change_set", row.expect.changeset), JSON.stringify(validatorFor("change_set").errors)).toBe(true);
		});
	}

	for (const pair of identities) {
		it(`P3 [${pair.id}]: both identity-table changesets are schema-valid AND parser-accepted`, () => {
			for (const side of [pair.a, pair.b]) {
				expect(parserAccepts("change_set", side)).toBe(true);
				expect(schemaAccepts("change_set", side), JSON.stringify(validatorFor("change_set").errors)).toBe(true);
			}
		});
	}

	it("P4: every schema compiles under Draft 2020-12 and the directory holds exactly one per registry record", () => {
		for (const descriptor of SHADOW_RECORD_REGISTRY) expect(() => validatorFor(descriptor.id), descriptor.id).not.toThrow();
		const files = readdirSync(SCHEMA_DIR).filter((entry) => entry.endsWith(".schema.json"));
		expect(files.length).toBe(SHADOW_RECORD_REGISTRY.length);
	});
});

// ── what the schema DOES carry: brand patterns, integers, the honesty label ──

function patternAt(recordId: string, path: readonly string[]): string {
	let node: unknown = loadJson(join(SCHEMA_DIR, `${recordId}.schema.json`));
	for (const key of path) node = objectAt(node, `${recordId}:${path.join(".")}`)[key];
	const pattern = objectAt(node, `${recordId}:${path.join(".")}`).pattern;
	if (typeof pattern !== "string") throw new Error(`${recordId}:${path.join(".")} has no pattern`);
	return pattern;
}

/** Probes on which the schema regex and the parser check DISAGREE — the
 *  pattern must be the parser's own regex, not a paraphrase. Probes are
 *  shape-level; the RFC3339 calendar layer is the N4 gap above. */
function disagreements(pattern: string, check: (value: unknown, where: string) => string | null, probes: readonly string[]): string[] {
	const re = new RegExp(pattern, "u");
	return probes.filter((probe) => re.test(probe) !== (check(probe, "f") === null));
}

const HEX64 = "a".repeat(64);
const HEX40 = "b".repeat(40);

describe("schema differential — positive (brand patterns are the parser's regexes)", () => {
	it("P5: Digest<P> fields carry the 64-hex sha-256 pattern", () => {
		const pattern = patternAt("change_set", ["properties", "pre_tree_hash"]);
		expect(disagreements(pattern, checkSha256Hex, [HEX64, HEX64.toUpperCase(), "a".repeat(63), "", `${HEX64}\n`])).toEqual([]);
	});
	it("P6: GitSha fields carry the 40-hex pattern", () => {
		const pattern = patternAt("freshness_binding", ["properties", "local_head"]);
		expect(disagreements(pattern, checkGitSha, [HEX40, HEX64, "main", ""])).toEqual([]);
	});
	it("P7: Rfc3339 fields carry the RFC3339 shape pattern", () => {
		const pattern = patternAt("dependency_cache_record", ["properties", "created_at"]);
		const probes = ["2026-09-04T00:00:00Z", "2026-09-04T00:00:00.123456789+05:30", "2026-09-04 00:00:00Z", "2026-09-04T00:00:00", ""];
		expect(disagreements(pattern, checkRfc3339, probes)).toEqual([]);
	});
	it("P8: OpaqueId fields carry the URL-safe id pattern", () => {
		const pattern = patternAt("dependency_cache_record", ["properties", "backup_handle"]);
		const probes = ["job-1", "a".repeat(128), "a".repeat(129), "-lead", "has space", ""];
		expect(disagreements(pattern, checkOpaqueId, probes)).toEqual([]);
	});
	it("P9: numeric fields are non-negative integers; literal numbers are const", () => {
		const entry = objectAt(loadJson(join(SCHEMA_DIR, "manifest_entry.schema.json")), "manifest_entry");
		expect(objectAt(entry.properties, "properties").bytes).toEqual({ type: "integer", minimum: 0 });
		const changeSet = objectAt(loadJson(join(SCHEMA_DIR, "change_set.schema.json")), "change_set");
		expect(objectAt(changeSet.properties, "properties").schema_version).toEqual({ const: 1 });
		expect(schemaAccepts("manifest_entry", { path: "a.ts", mode: "100644", blob_digest: HEX64, bytes: 1.5 })).toBe(false);
		expect(schemaAccepts("manifest_entry", { path: "a.ts", mode: "100644", blob_digest: HEX64, bytes: -1 })).toBe(false);
	});
	it("P10: every schema and index.json carry the structural-shape contract label", () => {
		for (const entry of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith(".json"))) {
			const schema = objectAt(loadJson(join(SCHEMA_DIR, entry)), entry);
			expect(schema["x-shadow-contract"], entry).toBe("structural-shape");
			expect(typeof schema["x-shadow-contract-meaning"], entry).toBe("string");
		}
	});
});
