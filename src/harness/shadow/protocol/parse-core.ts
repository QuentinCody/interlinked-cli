// ===========================================
// Shadow protocol v1 — strict parsers: manifests, change sets, tool input, bindings
// ===========================================
// The ONE gate through which an untrusted wire value becomes a typed protocol
// record (memo §8.0, first bullet: unknown field / unknown version /
// out-of-range → reject; ids bounded and URL-safe; strings bounded; integers
// safe and non-negative). Entry-level records and the shared table machinery
// live in `parse-core-entries.ts`.
//
// A parser proves SHAPE ONLY. It never checks that a hash equals the bytes it
// claims, that a claim matches local disk, or that a signature verifies —
// those are admission's, the materializer's, and `verify`'s jobs. An accepted
// record is a well-formed record, not a trusted one.
//
// The asymmetry that matters (memo §8.0, "facts belong to the party that can
// know them"): a dependency REQUEST may never carry a tree hash, because
// nobody holds one before the install runs. `tree_hash` on a request is not an
// ignored extra — it is a rejection.

import {
	checkBool,
	checkBoundedText,
	checkEnum,
	checkGitSha,
	checkOpaqueId,
	checkRfc3339,
	checkSafeNonNegInt,
	checkSha256Hex,
	type Reason,
} from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import {
	arrayOf,
	checkFields,
	checkOverlayManifest,
	type FieldCheck,
	type FieldSpec,
	fieldsCheck,
	literal,
	nested,
	optional,
	type ShadowParseOutcome,
	parseRecord,
	pathArray,
	type Raw,
	type RecordCheck,
	taggedEntryArray,
} from "./parse-core-entries.js";
import { checkCanonicalPath, comparePathBytes } from "./path-rules.js";
import type {
	DependencyRequestV1,
	ExecutionManifestV1,
	NormalizedToolInputV1,
	ResolvedDependencyBindingV1,
	ShadowChangeSetV1,
} from "./types-core.js";
import { DEPENDENCY_TREE_ALGO, OVERLAY_ALGO, POST_IMAGE_ALGO, TREE_ALGO } from "./types-core.js";
import type {
	ExpectedExecutionPolicyV1,
	ShadowExecutionBinding,
	ShadowExecutionClaimV1,
	ShadowFreshnessBinding,
} from "./types-binding.js";

const ENTRY_CAP = SHADOW_LIMITS_V1.entries;
const toolText: FieldCheck = (value, where) =>
	checkBoundedText(value, where, SHADOW_LIMITS_V1.command_stdin_toolinput_bytes);

// ── mirror identity ────────────────────────────────────────────────────────
// The key is the identity of the mirror and the version counter is PER KEY,
// so both travel together and neither is optional.

/** Mirror identity — exported because `parse-transport.ts` validates the same
 *  identity inside the transport records. TWO tables can drift; one cannot. */
export const MIRROR_KEY_FIELDS: readonly FieldSpec[] = [
	["repository_id", checkOpaqueId],
	["session_id", checkOpaqueId],
	["kind", literal("synthetic_full_tree")],
];
const MIRROR_REF_FIELDS: readonly FieldSpec[] = [
	["key", nested(fieldsCheck(MIRROR_KEY_FIELDS))],
	["version", (value, where) => checkSafeNonNegInt(value, where)],
];
/** The `{key, version}` reference as a field check — same reason. */
export const mirrorRef = nested(fieldsCheck(MIRROR_REF_FIELDS));

// ── dependencies (memo §8.0 — request vs resolved asymmetry) ───────────────

const NONE_FIELDS: readonly FieldSpec[] = [["mode", literal("none")]];
const REQUEST_NPM_FIELDS: readonly FieldSpec[] = [
	["mode", literal("npm-v1")],
	["input_hash", checkSha256Hex],
];
const RESOLVED_FRESH_FIELDS: readonly FieldSpec[] = [
	...REQUEST_NPM_FIELDS,
	["source", literal("fresh")],
	["tree_algo", literal(DEPENDENCY_TREE_ALGO)],
	["tree_hash", checkSha256Hex],
];
const RESOLVED_CACHE_FIELDS: readonly FieldSpec[] = [
	...REQUEST_NPM_FIELDS,
	["source", literal("cache")],
	["tree_algo", literal(DEPENDENCY_TREE_ALGO)],
	["tree_hash", checkSha256Hex],
	["cache_record_hash", checkSha256Hex],
];

/** A REQUEST carries only what the daemon can know: the mode and the input
 *  hash. A `tree_hash` here is an unknown field, hence a rejection. */
export const checkDependencyRequest: RecordCheck = (value, where) => {
	if (value.mode === "none") return checkFields(value, where, NONE_FIELDS);
	if (value.mode === "npm-v1") return checkFields(value, where, REQUEST_NPM_FIELDS);
	return `${where}.mode must be one of: none, npm-v1`;
};

/** The RESOLVED binding is what the materializer measured, so the tree hash is
 *  required — and the cache-record hash exists only on the cache source. */
export const checkResolvedDependency: RecordCheck = (value, where) => {
	if (value.mode === "none") return checkFields(value, where, NONE_FIELDS);
	if (value.mode !== "npm-v1") return `${where}.mode must be one of: none, npm-v1`;
	if (value.source === "fresh") return checkFields(value, where, RESOLVED_FRESH_FIELDS);
	if (value.source === "cache") return checkFields(value, where, RESOLVED_CACHE_FIELDS);
	return `${where}.source must be one of: cache, fresh`;
};

export function parseDependencyRequest(raw: unknown): ShadowParseOutcome<DependencyRequestV1> {
	return parseRecord(raw, "dependency_request", checkDependencyRequest);
}

export function parseResolvedDependencyBinding(raw: unknown): ShadowParseOutcome<ResolvedDependencyBindingV1> {
	return parseRecord(raw, "resolved_dependency_binding", checkResolvedDependency);
}

// ── execution manifest and change set ──────────────────────────────────────

const EXECUTION_MANIFEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["mirror", mirrorRef],
	["overlay_manifest", nested(checkOverlayManifest)],
	["overlay", taggedEntryArray(ENTRY_CAP)],
	["post_images", taggedEntryArray(ENTRY_CAP)],
];

export function parseExecutionManifest(raw: unknown): ShadowParseOutcome<ExecutionManifestV1> {
	return parseRecord(raw, "execution_manifest", fieldsCheck(EXECUTION_MANIFEST_FIELDS));
}

/** `touched_paths` order is not free: change-set identity is POSITIONAL
 *  (`sameContentIdentity` compares element by element), so two encodings of ONE
 *  change must not differ only in the order of this array. Canonical order is
 *  strictly ascending by UTF-8 bytes — which also forbids duplicates, since
 *  strictly ascending forbids equality (memo §8.0, byte-identical identity). */
function canonicalPathArray(max: number): FieldCheck {
	const listed = pathArray(max);
	return (value, where) => {
		const shape = listed(value, where);
		if (shape !== null) return shape;
		// SAFETY: `listed` accepted, so `value` is an array whose every element
		// passed checkCanonicalPath and is therefore a string.
		return ascendingReason(value as readonly string[], where);
	};
}

function ascendingReason(paths: readonly string[], where: string): Reason {
	let previous: string | null = null;
	for (const current of paths) {
		if (previous !== null && comparePathBytes(previous, current) >= 0) {
			return `${where} must be in canonical order: strictly ascending by UTF-8 bytes ("${previous}" is not before "${current}")`;
		}
		previous = current;
	}
	return null;
}

const CHANGE_SET_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["pre_tree_hash", checkSha256Hex],
	["post_image_set_hash", checkSha256Hex],
	["touched_paths", canonicalPathArray(ENTRY_CAP)],
];

export function parseShadowChangeSet(raw: unknown): ShadowParseOutcome<ShadowChangeSetV1> {
	return parseRecord(raw, "change_set", fieldsCheck(CHANGE_SET_FIELDS));
}

// ── normalized tool input (the closed four-shape union) ────────────────────
// Keyed by client/tool: each shape declares its OWN allowed keys, so a field
// belonging to a different tool (`content` on an Edit, `file_path` on an
// apply_patch) is an unknown field and rejects.

const TOOL_COMMON: readonly FieldSpec[] = [
	["schema", literal("shadow-tool-input-v1")],
	["semantics_version", literal(1)],
];
const CLAUDE_COMMON: readonly FieldSpec[] = [
	...TOOL_COMMON,
	["client", literal("claude-code")],
	["file_path", checkCanonicalPath],
];
const MULTI_EDIT_ENTRY_FIELDS: readonly FieldSpec[] = [
	["old_string", toolText],
	["new_string", toolText],
	["replace_all", checkBool],
];
const APPLY_PATCH_SOURCE_FIELDS = ["command", "patch", "_raw_patch", "content"];

/** A MultiEdit with an empty edit list is a tool call that changes nothing, so
 *  it can produce no post-image and must not reach admission — the `no_edits`
 *  rule. At least one edit is required. */
const multiEditArray: FieldCheck = (value, where) => {
	const listed = arrayOf(fieldsCheck(MULTI_EDIT_ENTRY_FIELDS), ENTRY_CAP);
	const shape = listed(value, where);
	if (shape !== null) return shape;
	// SAFETY: `listed` accepted, so `value` is an array.
	const edits = value as readonly unknown[];
	return edits.length === 0 ? `${where} must contain at least one edit (no_edits): a MultiEdit changing nothing` : null;
};

const TOOL_INPUT_SHAPES: Record<string, readonly FieldSpec[]> = {
	"claude-code/Write": [...CLAUDE_COMMON, ["tool", literal("Write")], ["content", toolText]],
	"claude-code/Edit": [
		...CLAUDE_COMMON,
		["tool", literal("Edit")],
		["old_string", toolText],
		["new_string", toolText],
		["replace_all", checkBool],
	],
	"claude-code/MultiEdit": [
		...CLAUDE_COMMON,
		["tool", literal("MultiEdit")],
		["edits", multiEditArray],
	],
	"codex/apply_patch": [
		...TOOL_COMMON,
		["client", literal("codex")],
		["tool", literal("apply_patch")],
		["patch", toolText],
		["raw_source_field", (value, where) => checkEnum(value, APPLY_PATCH_SOURCE_FIELDS, where)],
	],
};

const checkNormalizedToolInput: RecordCheck = (value, where) => {
	const shape = shapeKey(value);
	const fields = shape === null ? undefined : TOOL_INPUT_SHAPES[shape];
	if (fields === undefined) {
		return `${where} must be one of the supported client/tool shapes: ${Object.keys(TOOL_INPUT_SHAPES).sort().join(", ")}`;
	}
	return checkFields(value, where, fields);
};

function shapeKey(value: Raw): string | null {
	const { client, tool } = value;
	return typeof client === "string" && typeof tool === "string" ? `${client}/${tool}` : null;
}

export function parseNormalizedToolInput(raw: unknown): ShadowParseOutcome<NormalizedToolInputV1> {
	return parseRecord(raw, "tool_input", checkNormalizedToolInput);
}

// ── claim / policy / measurement (memo §8.0, three parties) ────────────────
// The three records deliberately differ: the claim has no env digest and only
// a dependency REQUEST; policy holds expectations; the measured binding adds
// the resolved dependencies, the env digest and the exec-config hash.

const ALGO_FIELDS: readonly FieldSpec[] = [
	["tree_algo", literal(TREE_ALGO)],
	["post_image_algo", literal(POST_IMAGE_ALGO)],
	["overlay_algo", literal(OVERLAY_ALGO)],
	["overlay_manifest_hash", checkSha256Hex],
];
const CONTENT_FIELDS: readonly FieldSpec[] = [
	["mirror", mirrorRef],
	["base_ref", checkGitSha],
	...ALGO_FIELDS,
	["overlay_bytes_hash", checkSha256Hex],
	["pre_tree_hash", checkSha256Hex],
	["post_image_set_hash", checkSha256Hex],
	["post_tree_hash", checkSha256Hex],
];

const CLAIM_FIELDS: readonly FieldSpec[] = [...CONTENT_FIELDS, ["dependencies", nested(checkDependencyRequest)]];

const POLICY_FIELDS: readonly FieldSpec[] = [
	...ALGO_FIELDS,
	["env_digest", checkSha256Hex],
	["exec_config_hash", checkSha256Hex],
	["broker_scanner_policy_digest", checkSha256Hex],
	["dependency_cache_record_hash", optional(checkSha256Hex)],
	["deadline_at", checkRfc3339],
];

const BINDING_FIELDS: readonly FieldSpec[] = [
	...CONTENT_FIELDS,
	["dependencies", nested(checkResolvedDependency)],
	["env_digest", checkSha256Hex],
	["exec_config_hash", checkSha256Hex],
];

const FRESHNESS_FIELDS: readonly FieldSpec[] = [
	["base_local_head", checkGitSha],
	["local_head", checkGitSha],
	["input_hash", checkSha256Hex],
	["local_pre_tree_hash", checkSha256Hex],
	["local_overlay_manifest_hash", checkSha256Hex],
	["local_post_image_set_hash", checkSha256Hex],
];

export function parseShadowExecutionClaim(raw: unknown): ShadowParseOutcome<ShadowExecutionClaimV1> {
	return parseRecord(raw, "execution_claim", fieldsCheck(CLAIM_FIELDS));
}

export function parseExpectedExecutionPolicy(raw: unknown): ShadowParseOutcome<ExpectedExecutionPolicyV1> {
	return parseRecord(raw, "expected_policy", fieldsCheck(POLICY_FIELDS));
}

export function parseShadowExecutionBinding(raw: unknown): ShadowParseOutcome<ShadowExecutionBinding> {
	return parseRecord(raw, "execution_binding", fieldsCheck(BINDING_FIELDS));
}

export function parseShadowFreshnessBinding(raw: unknown): ShadowParseOutcome<ShadowFreshnessBinding> {
	return parseRecord(raw, "freshness_binding", fieldsCheck(FRESHNESS_FIELDS));
}

// ── the published key sets ─────────────────────────────────────────────────
// The SAME tables the parsers above validate against, keyed by the `where`
// label each parser passes to `parseRecord`, with one entry per union variant
// (`tool_input`'s four client/tool shapes come from the dispatch map itself, so
// a fifth shape publishes its keys the moment it is admitted).

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	dependency_request: [NONE_FIELDS, REQUEST_NPM_FIELDS],
	resolved_dependency_binding: [NONE_FIELDS, RESOLVED_FRESH_FIELDS, RESOLVED_CACHE_FIELDS],
	execution_manifest: [EXECUTION_MANIFEST_FIELDS],
	change_set: [CHANGE_SET_FIELDS],
	tool_input: Object.values(TOOL_INPUT_SHAPES),
	execution_claim: [CLAIM_FIELDS],
	expected_policy: [POLICY_FIELDS],
	execution_binding: [BINDING_FIELDS],
	freshness_binding: [FRESHNESS_FIELDS],
};

/** Re-exported so a consumer parsing whole records never has to reach past
 *  this module for the entry-level parsers. */
export {
	parseManifestEntry,
	parseOverlayEntry,
	parseOverlayManifest,
	parsePostImageEntry,
} from "./parse-core-entries.js";
export type { ShadowParseOutcome } from "./parse-core-entries.js";
