// ===========================================
// Shadow protocol v1 — strict parsers: entries, include rules, shared machinery
// ===========================================
// The ONE gate through which an untrusted wire value becomes a typed content
// record (memo §8.0, first bullet). Strict recursively: an unknown field at
// ANY level, an unknown version, an unknown union tag, an out-of-range integer,
// an unbounded string, an empty-string brand, or a refused path/mode rejects
// with a specific reason. Nothing here ever throws.
//
// A parser proves SHAPE ONLY. Hashes, freshness, signatures, and every
// cross-record equality are checked elsewhere (`verify`/admission); an accepted
// record is still untrusted evidence.
//
// Field descriptors are TABLES, not if-chains: the allowed key set and the
// per-field validators are the same declaration, so "unknown field" and "bad
// field" can never disagree about what a record contains.

import { deepFreeze, safeStructuredClone } from "../../mutation/protocol-v3/canonical.js";
import {
	checkArray,
	checkLiteral,
	checkNoUnknownKeys,
	checkSafeNonNegInt,
	checkSha256Hex,
	isRecord,
	type Reason,
} from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import { checkOverlayIncludeRules, SHADOW_OVERLAY_DENY_V1 } from "./overlay-manifest.js";
import { checkCanonicalPath, checkGitMode, duplicatePath } from "./path-rules.js";
import type { ManifestEntryV1, OverlayEntryV1, OverlayManifestV1, PostImageEntryV1 } from "./types-core.js";

/** Every parser reports the SAME two-shape outcome — never a throw, never a
 *  partially-populated record. */
export type ShadowParseOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

export type Raw = Record<string, unknown>;
export type FieldCheck = (value: unknown, where: string) => Reason;
export type RecordCheck = (value: Raw, where: string) => Reason;
/** `[key, validator]` — the key is BOTH the allowed-key declaration and the
 *  validator's subject, so the two cannot drift. */
export type FieldSpec = readonly [key: string, check: FieldCheck];

// ── shared field-check combinators ─────────────────────────────────────────

export function literal<T extends string | number | boolean>(expected: T): FieldCheck {
	return (value, where) => checkLiteral(value, expected, where);
}

/** A field whose value is itself a record. */
export function nested(check: RecordCheck): FieldCheck {
	return (value, where) => (isRecord(value) ? check(value, where) : `${where} must be an object`);
}

/** A field that may be absent entirely (never present-but-undefined-shaped
 *  policy: an absent optional is the ONLY accepted absence). */
export function optional(check: FieldCheck): FieldCheck {
	return (value, where) => (value === undefined ? null : check(value, where));
}

export function boundedInt(max: number): FieldCheck {
	return (value, where) => checkSafeNonNegInt(value, where, max);
}

/** An array of records, bounded BEFORE any per-item work. */
export function arrayOf(check: RecordCheck, max: number): FieldCheck {
	return (value, where) => {
		if (!Array.isArray(value)) return `${where} must be an array`;
		const bound = checkArray(value, where, max);
		if (bound !== null) return bound;
		return firstItemReason(value, where, check);
	};
}

function firstItemReason(items: readonly unknown[], where: string, check: RecordCheck): Reason {
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!isRecord(item)) return `${where}[${index}] must be an object`;
		const reason = check(item, `${where}[${index}]`);
		if (reason !== null) return reason;
	}
	return null;
}

/** An array of canonical paths, bounded and duplicate-free. */
export function pathArray(max: number): FieldCheck {
	return (value, where) => {
		if (!Array.isArray(value)) return `${where} must be an array`;
		const bound = checkArray(value, where, max);
		if (bound !== null) return bound;
		for (let index = 0; index < value.length; index += 1) {
			const reason = checkCanonicalPath(value[index], `${where}[${index}]`);
			if (reason !== null) return reason;
		}
		return duplicateReason(value, where, (path: unknown) => String(path));
	};
}

function duplicateReason<T>(items: readonly T[], where: string, pathOf: (item: T) => string): Reason {
	const duplicate = duplicatePath(items, pathOf);
	return duplicate === null ? null : `${where} contains duplicate path "${duplicate}"`;
}

/** Unknown keys first (an unrecognized field is a version this parser does not
 *  implement or an injection attempt), then each declared field in order. */
export function checkFields(value: Raw, where: string, fields: readonly FieldSpec[]): Reason {
	const unknown = checkNoUnknownKeys(
		value,
		fields.map(([key]) => key),
		where,
	);
	if (unknown !== null) return unknown;
	for (const [key, check] of fields) {
		const reason = check(value[key], `${where}.${key}`);
		if (reason !== null) return reason;
	}
	return null;
}

export function fieldsCheck(fields: readonly FieldSpec[]): RecordCheck {
	return (value, where) => checkFields(value, where, fields);
}

/** Snapshot FIRST (getters read exactly once), validate the snapshot, freeze
 *  it, and hand back own data — the caller's reference can never mutate a
 *  record another component has already validated. */
export function parseRecord<T>(raw: unknown, where: string, check: RecordCheck): ShadowParseOutcome<T> {
	const snapshot = safeStructuredClone(raw);
	if (snapshot === null || !isRecord(snapshot)) return { ok: false, reason: `${where} must be a plain JSON object` };
	const reason = check(snapshot, where);
	if (reason !== null) return { ok: false, reason };
	deepFreeze(snapshot);
	// Every declared field of `check`'s table was validated on this frozen
	// own-data snapshot and unknown keys were refused, so the value
	// structurally satisfies T. This is the sole mint site for these records.
	// SAFETY: validated field-by-field against T's declared shape immediately above.
	return { ok: true, value: snapshot as unknown as T };
}

// ── content entries (memo §5.1) ────────────────────────────────────────────

const entryBytes = boundedInt(SHADOW_LIMITS_V1.single_entry_bytes);

const MANIFEST_ENTRY_FIELDS: readonly FieldSpec[] = [
	["path", checkCanonicalPath],
	["mode", checkGitMode],
	["blob_digest", checkSha256Hex],
	["bytes", entryBytes],
];

const WRITE_ENTRY_FIELDS: readonly FieldSpec[] = [["tag", literal("W")], ...MANIFEST_ENTRY_FIELDS];
/** A D record carries a path and NOTHING else — mode, digest, or bytes on a
 *  deletion is a malformed record, not a tolerated extra. */
const DELETE_ENTRY_FIELDS: readonly FieldSpec[] = [
	["tag", literal("D")],
	["path", checkCanonicalPath],
];

const checkManifestEntry: RecordCheck = fieldsCheck(MANIFEST_ENTRY_FIELDS);

const checkTaggedEntry: RecordCheck = (value, where) => {
	if (value.tag === "W") return checkFields(value, where, WRITE_ENTRY_FIELDS);
	if (value.tag === "D") return checkFields(value, where, DELETE_ENTRY_FIELDS);
	return `${where}.tag must be "W" or "D"`;
};

/** Bounded, duplicate-free tagged entries — the structural rule that makes
 *  record order unambiguous (memo §12.2). */
export function taggedEntryArray(max: number): FieldCheck {
	const listed = arrayOf(checkTaggedEntry, max);
	return (value, where) => {
		const shape = listed(value, where);
		if (shape !== null) return shape;
		// SAFETY: `listed` accepted, so every item is a record whose `path`
		// passed checkCanonicalPath and is therefore a string.
		const entries = value as readonly { path: string }[];
		return duplicateReason(entries, where, (entry) => entry.path);
	};
}

export function parseManifestEntry(raw: unknown): ShadowParseOutcome<ManifestEntryV1> {
	return parseRecord(raw, "manifest_entry", checkManifestEntry);
}

export function parseOverlayEntry(raw: unknown): ShadowParseOutcome<OverlayEntryV1> {
	return parseRecord(raw, "overlay_entry", checkTaggedEntry);
}

export function parsePostImageEntry(raw: unknown): ShadowParseOutcome<PostImageEntryV1> {
	return parseRecord(raw, "post_image_entry", checkTaggedEntry);
}

// ── overlay manifest (memo §8.0, scanner-identity bullet) ──────────────────
// Include rules have a declared grammar; the deny ruleset is BROKER-OWNED by
// id, so only the exact id is admitted — its text never comes from the daemon.
// The rule list is validated by the SAME function `canonicalizeOverlayManifest`
// runs (`overlay-manifest.ts`), in CANONICAL mode: a wire manifest must arrive
// already sorted and normalized, because its hash can only match if the sender
// canonicalized it. A parsed manifest therefore IS its canonical form.

const canonicalIncludeRules: FieldCheck = (value, where) =>
	checkOverlayIncludeRules(value, where, "canonical")?.detail ?? null;

const OVERLAY_MANIFEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["include_rules", canonicalIncludeRules],
	["deny_ruleset_id", literal(SHADOW_OVERLAY_DENY_V1.id)],
];

export const checkOverlayManifest: RecordCheck = fieldsCheck(OVERLAY_MANIFEST_FIELDS);

export function parseOverlayManifest(raw: unknown): ShadowParseOutcome<OverlayManifestV1> {
	return parseRecord(raw, "overlay_manifest", checkOverlayManifest);
}

// ── the published key sets ─────────────────────────────────────────────────
// The SAME tables the parsers above validate against, keyed by the `where`
// label each parser passes to `parseRecord`, with one entry per union variant.
// Publishing them is what lets `registry.ts` state a record's declared key set
// instead of naming a parser and stopping there — and what lets
// `registry.test.ts` prove the generated JSON Schema and the parser agree about
// which fields a record has. A second, hand-written key list would be the drift
// this export exists to remove, so these arrays are references, never copies.

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	manifest_entry: [MANIFEST_ENTRY_FIELDS],
	overlay_entry: [WRITE_ENTRY_FIELDS, DELETE_ENTRY_FIELDS],
	post_image_entry: [WRITE_ENTRY_FIELDS, DELETE_ENTRY_FIELDS],
	overlay_manifest: [OVERLAY_MANIFEST_FIELDS],
};
