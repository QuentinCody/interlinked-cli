// ===========================================
// Shadow protocol v1 — strict parsers: persisted store records
// ===========================================
// The dependency-tree cache row and the LOCAL mirror binding. These live in D1
// or `.interlinked/shadow-mirror.json` — and "internal" describes where the
// bytes came from, not how much they can be trusted. A row read back from
// storage is a wire value the moment it leaves it, so it is decoded here
// exactly as strictly as a client-supplied one; the mirror binding is
// explicitly AGENT-WRITABLE local state (memo §12.2) and is therefore never
// authoritative about anything.
//
// The four BROKER-INTERNAL rows this module used to carry — the two backup
// records, the mirror upload row and the input bundle — moved to
// `interlinked-cloud` in the 2026-09-04 public/private split. The cache record
// stays because its hash travels on the wire and `compareBindings` takes it.
//
// A parser proves SHAPE ONLY: no digest is recomputed, no backup handle
// resolved, no immutable key dereferenced, no expiry compared to a clock. An
// accepted record is a well-formed record, not a trusted one.

import { checkGitSha, checkOpaqueId, checkRfc3339, checkSafeNonNegInt, checkSha256Hex } from "./field-checks.js";
import {
	type FieldSpec,
	fieldsCheck,
	literal,
	nested,
	type ShadowParseOutcome,
	parseRecord,
} from "./parse-core-entries.js";
import { MIRROR_KEY_FIELDS } from "./parse-core.js";
import { boundedText } from "./parse-outcome.js";
import type { DependencyTreeCacheRecordV1 } from "./types-core.js";
import { DEPENDENCY_TREE_ALGO } from "./types-core.js";
import type { MirrorBindingV1 } from "./types-transport.js";

/** The cache row's lifetime pair. Both are timestamps, never a TTL in seconds —
 *  a relative lifetime is unreadable without knowing when it was written. */
const LIFETIME_FIELDS: readonly FieldSpec[] = [
	["expires_at", checkRfc3339],
	["created_at", checkRfc3339],
];

// ── dependency-tree cache record ───────────────────────────────────────────
// It records EVERYTHING the install depended on — image, npm version, registry
// policy, scanner policy — because a cache hit is only sound when every one of
// those matches. The parser cannot check that; it only refuses a row that
// cannot state it.

const DEPENDENCY_CACHE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["input_hash", checkSha256Hex],
	["image_manifest_digest", boundedText],
	["npm_version", boundedText],
	["registry_policy_digest", checkSha256Hex],
	["broker_scanner_policy_digest", checkSha256Hex],
	["tree_algo", literal(DEPENDENCY_TREE_ALGO)],
	["tree_hash", checkSha256Hex],
	["backup_handle", checkOpaqueId],
	...LIFETIME_FIELDS,
];

export function parseDependencyTreeCacheRecord(raw: unknown): ShadowParseOutcome<DependencyTreeCacheRecordV1> {
	return parseRecord(raw, "dependency_cache_record", fieldsCheck(DEPENDENCY_CACHE_FIELDS));
}

// ── the LOCAL mirror binding (`.interlinked/shadow-mirror.json`) ───────────
// Agent-writable, therefore never authoritative — which is exactly why it is
// parsed. `last_known` is a version reference PLUS the two commit shas it was
// last observed at; a binding that cannot state all four is malformed.

const LAST_KNOWN_FIELDS: readonly FieldSpec[] = [
	["key", nested(fieldsCheck(MIRROR_KEY_FIELDS))],
	["version", (value, where) => checkSafeNonNegInt(value, where)],
	["base_ref", checkGitSha],
	["base_local_head", checkGitSha],
];

const MIRROR_BINDING_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["mirror_key", nested(fieldsCheck(MIRROR_KEY_FIELDS))],
	["last_known", nested(fieldsCheck(LAST_KNOWN_FIELDS))],
];

export function parseMirrorBinding(raw: unknown): ShadowParseOutcome<MirrorBindingV1> {
	return parseRecord(raw, "mirror_binding", fieldsCheck(MIRROR_BINDING_FIELDS));
}

// ── the published key sets ─────────────────────────────────────────────────
// The SAME tables the parsers above validate against, keyed by the `where`
// label each parser passes to `parseRecord`. Every record in this module is a
// single shape, so each entry holds exactly one table.

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	dependency_cache_record: [DEPENDENCY_CACHE_FIELDS],
	mirror_binding: [MIRROR_BINDING_FIELDS],
};
