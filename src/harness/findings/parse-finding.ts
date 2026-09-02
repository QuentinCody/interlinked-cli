// ===========================================================================
// Finding parser — the corpus JSONL boundary
// ===========================================================================
// Replaces `isFinding(value): value is Finding`, which asserted the whole
// interface while checking only four of its sixteen required fields. A
// `value is T` annotation is never verified against the body by the compiler,
// so `aliases`, `check`, `file`, `line`, `severity`, `provenance_tier`,
// `dedup_key`, `times_observed`, `source_runners`, `status`, `first_seen` and
// `last_seen` were all unvalidated — every consumer read them as their declared
// types when any of them could be `undefined`. Found by `type_predicate_drift`.
//
// The parser returns a CONSTRUCTED object literal, which the compiler DOES
// check against `Finding`: adding a required field to the interface now fails
// to compile here instead of silently going unvalidated at the boundary.

import { isJsonObject } from "../../lib/json-types.js";
import type { JsonObject } from "../../lib/json-types.js";
import type {
	Finding,
	FindingActionability,
	FindingCategory,
	FindingDistilled,
	FindingProvenance,
	FindingSeverity,
	FindingStatus,
} from "./corpus.js";
import type { ProvenanceCompleteness, ProvenanceTier } from "./provenance.js";
import {
	parseFindingExtensions,
	type FindingExtensions,
} from "./simplification-extension.js";

const SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>([
	"critical",
	"high",
	"medium",
	"low",
	"unknown",
]);
const CATEGORIES: ReadonlySet<string> = new Set<FindingCategory>([
	"security",
	"performance",
	"quality",
]);
const STATUSES: ReadonlySet<string> = new Set<FindingStatus>([
	"candidate",
	"approved",
	"distilled",
	"superseded",
]);
const TIERS: ReadonlySet<string> = new Set<ProvenanceTier>(["site", "file", "class"]);
const COMPLETENESS: ReadonlySet<string> = new Set<ProvenanceCompleteness>([
	"anchored_sha",
	"anchored_line",
	"anchored_file",
	"unanchored",
]);

function stringArray(v: unknown): string[] | null {
	if (!Array.isArray(v)) return null;
	return v.every((e): e is string => typeof e === "string") ? [...v] : null;
}

function optionalString(v: unknown): string | null | undefined {
	if (v === undefined) return undefined;
	return typeof v === "string" ? v : null;
}

function lineRange(v: unknown): [number, number] | null | undefined {
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || v.length !== 2) return null;
	const [a, b] = v;
	return typeof a === "number" && typeof b === "number" ? [a, b] : null;
}

const ACTIONABILITIES: ReadonlySet<string> = new Set<FindingActionability>([
	"bug",
	"nit",
	"question",
	"praise",
	"suggestion",
	"out_of_scope",
]);

/** The nine free-text optional members of `FindingProvenance`. Kept as one
 *  list so a new optional string field is added in a single place — dropping
 *  one silently loses reviewer data (caught by the `quote` regression). */
const PROVENANCE_STRING_KEYS = [
	"repo",
	"commit_sha",
	"file",
	"url",
	"quote",
	"comment_author",
	"created_at",
	"originating_signature",
] as const;

/**
 * `raw_sha256` needs a legacy coercion the other string members do not.
 *
 * An older writer called `createHash(...).digest()` without `"hex"`, so
 * `JSON.stringify` serialized the Buffer as `{type:"Buffer", data:[…]}`. 54 rows
 * in the real corpus still carry that shape. The digest is genuine — only its
 * encoding is wrong — so rejecting those findings would be data loss over a
 * cosmetic field. Hex-encode the bytes instead. The live writer
 * (`src/commands/findings.ts`) already passes `"hex"`, so this only ever fires
 * on historical rows.
 */
function rawSha256(v: unknown): string | null | undefined {
	if (v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (!isJsonObject(v) || v.type !== "Buffer" || !Array.isArray(v.data)) return null;
	const bytes = v.data;
	if (!bytes.every((b): b is number => typeof b === "number" && b >= 0 && b <= 255)) return null;
	return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

type ProvenanceStringKey = (typeof PROVENANCE_STRING_KEYS)[number];

function provenanceStrings(
	v: JsonObject,
): Partial<Record<ProvenanceStringKey, string>> | null {
	const out: Partial<Record<ProvenanceStringKey, string>> = {};
	for (const key of PROVENANCE_STRING_KEYS) {
		const raw = v[key];
		if (raw === undefined) continue;
		if (typeof raw !== "string") return null;
		out[key] = raw;
	}
	return out;
}

interface ProvenanceExtras {
	lines?: [number, number];
	actionability?: FindingActionability;
	is_outdated?: boolean;
	is_resolved?: boolean;
	enriched_fields?: string[];
}

function optionalBool(v: unknown): boolean | null | undefined {
	if (v === undefined) return undefined;
	return typeof v === "boolean" ? v : null;
}

function provenanceExtras(v: JsonObject): ProvenanceExtras | null {
	const lines = lineRange(v.lines);
	if (lines === null) return null;
	const is_outdated = optionalBool(v.is_outdated);
	const is_resolved = optionalBool(v.is_resolved);
	if (is_outdated === null || is_resolved === null) return null;
	const enriched_fields =
		v.enriched_fields === undefined ? undefined : stringArray(v.enriched_fields);
	if (enriched_fields === null) return null;
	const act = v.actionability;
	if (act !== undefined && (typeof act !== "string" || !ACTIONABILITIES.has(act))) return null;
	return {
		...(lines !== undefined ? { lines } : {}),
		...(act !== undefined ? { actionability: act as FindingActionability } : {}),
		...(is_outdated !== undefined ? { is_outdated } : {}),
		...(is_resolved !== undefined ? { is_resolved } : {}),
		...(enriched_fields !== undefined ? { enriched_fields } : {}),
	};
}

/** One provenance entry. Its elements were never validated before — the old
 *  guard checked only that `provenance` was an array. */
export function parseProvenanceEntry(value: unknown): FindingProvenance | null {
	if (!isJsonObject(value)) return null;
	const { provenance_id, provenance_completeness, source_runner } = value;
	if (typeof provenance_id !== "string" || typeof source_runner !== "string") return null;
	if (typeof provenance_completeness !== "string") return null;
	if (!COMPLETENESS.has(provenance_completeness)) return null;
	const strings = provenanceStrings(value);
	const extras = provenanceExtras(value);
	const raw_sha256 = rawSha256(value.raw_sha256);
	if (strings === null || extras === null || raw_sha256 === null) return null;
	return {
		provenance_id,
		provenance_completeness: provenance_completeness as ProvenanceCompleteness,
		source_runner,
		...strings,
		...extras,
		...(raw_sha256 !== undefined ? { raw_sha256 } : {}),
	};
}

function provenanceList(v: unknown): FindingProvenance[] | null {
	if (!Array.isArray(v)) return null;
	const out: FindingProvenance[] = [];
	for (const entry of v) {
		const parsed = parseProvenanceEntry(entry);
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}

function parseDistilled(v: unknown): FindingDistilled | null | undefined {
	if (v === undefined) return undefined;
	if (!isJsonObject(v)) return null;
	const { detector_id, kind, cold_path_wired } = v;
	if (typeof detector_id !== "string") return null;
	if (kind !== "guard_rule" && kind !== "inline_check") return null;
	if (cold_path_wired !== undefined && typeof cold_path_wired !== "boolean") return null;
	return {
		detector_id,
		kind,
		...(cold_path_wired !== undefined ? { cold_path_wired } : {}),
	};
}

/** The required scalar core of a Finding, or null. Split out to keep
 *  `parseFinding` under the cognitive cap. */
interface RequiredCore {
	id: string;
	bug_class: string;
	file: string;
	line: number;
	message: string;
	severity: FindingSeverity;
	provenance_tier: ProvenanceTier;
	dedup_key: string;
	times_observed: number;
	status: FindingStatus;
	first_seen: string;
	last_seen: string;
}

function requiredCore(v: JsonObject): RequiredCore | null {
	const { id, bug_class, file, message, dedup_key, first_seen, last_seen } = v;
	const { line, times_observed, severity, provenance_tier, status } = v;
	if (typeof id !== "string" || typeof bug_class !== "string") return null;
	if (typeof file !== "string" || typeof message !== "string") return null;
	if (typeof dedup_key !== "string") return null;
	if (typeof first_seen !== "string" || typeof last_seen !== "string") return null;
	if (typeof line !== "number" || typeof times_observed !== "number") return null;
	if (typeof severity !== "string" || !SEVERITIES.has(severity)) return null;
	if (typeof provenance_tier !== "string" || !TIERS.has(provenance_tier)) return null;
	if (typeof status !== "string" || !STATUSES.has(status)) return null;
	return {
		id,
		bug_class,
		file,
		line,
		message,
		dedup_key,
		first_seen,
		last_seen,
		times_observed,
		severity: severity as FindingSeverity,
		provenance_tier: provenance_tier as ProvenanceTier,
		status: status as FindingStatus,
	};
}

interface ArrayFields {
	aliases: string[];
	source_runners: string[];
	provenance: FindingProvenance[];
}

/** The three list-shaped members, or null when any one fails to parse. Split
 *  out to keep `parseFinding` under the cyclomatic cap. */
function parseArrayFields(value: JsonObject): ArrayFields | null {
	const aliases = stringArray(value.aliases);
	const source_runners = stringArray(value.source_runners);
	const provenance = provenanceList(value.provenance);
	if (aliases === null || source_runners === null || provenance === null) return null;
	return { aliases, source_runners, provenance };
}

/** `check` is `string | null` — null is a legitimate value (a finding with no
 *  owning detector), distinct from the field being absent or the wrong type.
 *  Wrapped in an object so that legitimate-null is distinguishable from the
 *  outer "invalid" null the other parse* helpers use. */
function parseCheckField(value: JsonObject): { check: string | null } | null {
	const { check } = value;
	if (check !== null && typeof check !== "string") return null;
	return { check };
}

interface OptionalScalars {
	category?: FindingCategory;
	fix_instruction?: string;
	approved_by?: string;
	anchor_span_sha256?: string;
	anchor_context?: string[];
	anchor_tree?: string;
	distilled?: FindingDistilled;
	extensions?: FindingExtensions;
}

/** `category`, alone: validated against the known-category set. Split out of
 *  `parseOptionalScalars` to keep it under the cyclomatic cap. */
function parseCategoryField(value: JsonObject): Pick<OptionalScalars, "category"> | null {
	const category = value.category;
	if (category !== undefined && (typeof category !== "string" || !CATEGORIES.has(category))) {
		return null;
	}
	return category !== undefined ? { category: category as FindingCategory } : {};
}

/** The two free-text optional members. Split out of `parseOptionalScalars` to
 *  keep it under the cyclomatic cap. */
function parseTextFields(
	value: JsonObject,
): Pick<OptionalScalars, "fix_instruction" | "approved_by"> | null {
	const fix_instruction = optionalString(value.fix_instruction);
	const approved_by = optionalString(value.approved_by);
	if (fix_instruction === null || approved_by === null) return null;
	return {
		...(fix_instruction !== undefined ? { fix_instruction } : {}),
		...(approved_by !== undefined ? { approved_by } : {}),
	};
}

/** The three anchor-related members. Split out of `parseOptionalScalars` to
 *  keep it under the cyclomatic cap. */
function parseAnchorFields(
	value: JsonObject,
): Pick<OptionalScalars, "anchor_span_sha256" | "anchor_context" | "anchor_tree"> | null {
	const anchor_span_sha256 = optionalString(value.anchor_span_sha256);
	const anchor_tree = optionalString(value.anchor_tree);
	if (anchor_span_sha256 === null || anchor_tree === null) return null;

	const anchor_context =
		value.anchor_context === undefined ? undefined : stringArray(value.anchor_context);
	if (anchor_context === null) return null;

	return {
		...(anchor_span_sha256 !== undefined ? { anchor_span_sha256 } : {}),
		...(anchor_context !== undefined ? { anchor_context } : {}),
		...(anchor_tree !== undefined ? { anchor_tree } : {}),
	};
}

/** `distilled` + `extensions`, each parsed by its own sub-parser. Split out of
 *  `parseOptionalScalars` to keep it under the cyclomatic cap. */
function parseDistilledAndExtensions(
	value: JsonObject,
): Pick<OptionalScalars, "distilled" | "extensions"> | null {
	const distilled = parseDistilled(value.distilled);
	if (distilled === null) return null;
	const extensions = parseFindingExtensions(value.extensions);
	if (extensions === null) return null;
	return {
		...(distilled !== undefined ? { distilled } : {}),
		...(extensions !== undefined ? { extensions } : {}),
	};
}

/** The remaining optional members, or null when any one fails to parse. Split
 *  out to keep `parseFinding` under the cyclomatic cap. */
function parseOptionalScalars(value: JsonObject): OptionalScalars | null {
	const category = parseCategoryField(value);
	if (category === null) return null;
	const text = parseTextFields(value);
	if (text === null) return null;
	const anchors = parseAnchorFields(value);
	if (anchors === null) return null;
	const distilledAndExtensions = parseDistilledAndExtensions(value);
	if (distilledAndExtensions === null) return null;

	return { ...category, ...text, ...anchors, ...distilledAndExtensions };
}

/**
 * Parse one corpus JSONL row into a `Finding`, or null when any required field
 * is absent or the wrong type. Malformed rows are dropped by the caller, which
 * matches the pre-existing torn-line behavior (the corpus fails open).
 */
export function parseFinding(value: unknown): Finding | null {
	if (!isJsonObject(value)) return null;
	const core = requiredCore(value);
	if (core === null) return null;

	const arrays = parseArrayFields(value);
	if (arrays === null) return null;

	const checkField = parseCheckField(value);
	if (checkField === null) return null;

	const optional = parseOptionalScalars(value);
	if (optional === null) return null;

	return {
		...core,
		...arrays,
		...checkField,
		...optional,
	};
}
