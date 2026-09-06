// ===========================================
// Shadow protocol v1 — strict parsers: staged transport, mirror ingestion,
// execution input
// ===========================================
// The SERVER issues every upload capability, so these records are mostly
// server→client; parsing them strictly is what keeps a client from being
// steered by a field the protocol never declared (memo §8.0).
//
// The BROKER-INTERNAL records this module used to decode — the idempotency
// row, the publication attempt state machine, the mirror version record and the
// job state — moved to `interlinked-cloud` in the 2026-09-04 public/private
// split. What stays is the daemon's own half of the conversation, plus the
// finalize STATUS response, whose two terminal states carry a payload while
// every in-flight state is bare.
//
// A parser proves SHAPE ONLY: no digest is recomputed, no capability checked.

import { checkGitSha, checkOpaqueId, checkRfc3339, checkSafeNonNegInt, checkSha256Hex } from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import {
	arrayOf,
	boundedInt,
	checkFields,
	type FieldCheck,
	type FieldSpec,
	fieldsCheck,
	literal,
	nested,
	type ShadowParseOutcome,
	parseRecord,
	type RecordCheck,
} from "./parse-core-entries.js";
import {
	MIRROR_KEY_FIELDS,
	mirrorRef,
	parseNormalizedToolInput,
	parseShadowChangeSet,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "./parse-core.js";
import { boundedText, embedded, enumField, nullable } from "./parse-outcome.js";
import { EXECUTION_PROFILE_ID } from "./types-core.js";
import { OBSERVABLE_PUBLICATION_STATES } from "./types-transport.js";
import type {
	CancelAckV1,
	CancelRequestV1,
	ManifestUploadInitRequestV1,
	ManifestUploadInitResponseV1,
	MirrorFinalizeRequestV1,
	MirrorFinalizeResponseV1,
	MirrorFinalizeStatusResponseV1,
	MirrorPrepareRequestV1,
	MirrorPrepareResponseV1,
	MissingBlobPageRequestV1,
	MissingBlobPageResponseV1,
	MissingBlobPageV1,
	ShadowExecutionRequestV1,
	ShadowInputFinalizeRequestV1,
	ShadowInputFinalizeResponseV1,
	ShadowInputPrepareRequestV1,
	ShadowInputPrepareResponseV1,
} from "./types-transport.js";

const LIMITS = SHADOW_LIMITS_V1;
/** Version counters and fencing tokens are monotonic counters, not sizes. */
const counter: FieldCheck = (value, where) => checkSafeNonNegInt(value, where);
const manifestBytes = boundedInt(LIMITS.manifest_object_bytes);

// Mirror identity travels with its per-key version counter. The tables come
// from `parse-core.ts` — one definition, so the identity a transport record
// carries and the identity a content record carries cannot drift apart.
const mirrorKeyField = nested(fieldsCheck(MIRROR_KEY_FIELDS));
const mirrorRefField = mirrorRef;

/** Dispatch on a string-valued discriminator, or say which values exist. */
/** Exported because `interlinked-cloud/src/shadow/parse-broker.ts` parses the
 *  broker-side state machines (publication attempt, idempotency, job state)
 *  with the same dispatcher; one definition on each side of the vendor pin
 *  would be two dispatchers that can drift. */
export function byState(shapes: Record<string, readonly FieldSpec[]>, key = "state"): RecordCheck {
	return (value, where) => {
		const tag = value[key];
		const fields = typeof tag === "string" ? shapes[tag] : undefined;
		if (fields === undefined) return `${where}.${key} must be one of: ${Object.keys(shapes).sort().join(", ")}`;
		return checkFields(value, where, fields);
	};
}

// ── staged upload primitives ───────────────────────────────────────────────

const UPLOAD_SCOPES: Record<string, readonly FieldSpec[]> = {
	mirror: [["kind", literal("mirror")], ["mirror_key", mirrorKeyField]],
	input: [["kind", literal("input")], ["mirror", mirrorRefField]],
};
export const MANIFEST_UPLOAD_INIT_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["scope", nested(byState(UPLOAD_SCOPES, "kind"))],
	["idempotency_key", checkOpaqueId],
	["declared_bytes", manifestBytes],
	["declared_digest", checkSha256Hex],
];
export const MANIFEST_UPLOAD_INIT_RESPONSE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["upload_id", checkOpaqueId],
	["put_url", boundedText],
	["max_bytes", manifestBytes],
	["expires_at", checkRfc3339],
];

export function parseManifestUploadInitRequest(raw: unknown): ShadowParseOutcome<ManifestUploadInitRequestV1> {
	return parseRecord(raw, "manifest_upload_init_request", fieldsCheck(MANIFEST_UPLOAD_INIT_REQUEST_FIELDS));
}

export function parseManifestUploadInitResponse(raw: unknown): ShadowParseOutcome<ManifestUploadInitResponseV1> {
	return parseRecord(raw, "manifest_upload_init_response", fieldsCheck(MANIFEST_UPLOAD_INIT_RESPONSE_FIELDS));
}

/** The missing set is FROZEN at prepare, so its id and digest travel with
 *  every page — a cursor over a recomputed set could skip entries. */
const MISSING_SET_FIELDS: readonly FieldSpec[] = [
	["missing_set_id", checkOpaqueId],
	["missing_set_digest", checkSha256Hex],
	["missing_count", boundedInt(LIMITS.entries)],
];
const PAGE_ITEM_FIELDS: readonly FieldSpec[] = [
	["blob_digest", checkSha256Hex],
	["put_url", boundedText],
	["max_bytes", boundedInt(LIMITS.upload_blob_bytes)],
];
export const MISSING_PAGE_FIELDS: readonly FieldSpec[] = [
	["missing_set", nested(fieldsCheck(MISSING_SET_FIELDS))],
	["items", arrayOf(fieldsCheck(PAGE_ITEM_FIELDS), LIMITS.missing_blobs_page_size)],
	["next_page_token", nullable(checkOpaqueId)],
];
const missingPageField = nested(fieldsCheck(MISSING_PAGE_FIELDS));

export function parseMissingBlobPage(raw: unknown): ShadowParseOutcome<MissingBlobPageV1> {
	return parseRecord(raw, "missing_blob_page", fieldsCheck(MISSING_PAGE_FIELDS));
}

export const MISSING_BLOB_PAGE_REQUEST_FIELDS: readonly FieldSpec[] = [["schema_version", literal(1)], ["upload_id", checkOpaqueId], ["page_token", checkOpaqueId]];
export const MISSING_BLOB_PAGE_RESPONSE_FIELDS: readonly FieldSpec[] = [["schema_version", literal(1)], ["upload_id", checkOpaqueId], ["page", missingPageField]];

export function parseMissingBlobPageRequest(raw: unknown): ShadowParseOutcome<MissingBlobPageRequestV1> {
	return parseRecord(raw, "missing_blob_page_request", fieldsCheck(MISSING_BLOB_PAGE_REQUEST_FIELDS));
}

export function parseMissingBlobPageResponse(raw: unknown): ShadowParseOutcome<MissingBlobPageResponseV1> {
	return parseRecord(raw, "missing_blob_page_response", fieldsCheck(MISSING_BLOB_PAGE_RESPONSE_FIELDS));
}

// ── mirror ingestion ───────────────────────────────────────────────────────

export const MIRROR_PREPARE_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["upload_id", checkOpaqueId],
	["idempotency_key", checkOpaqueId],
	["base_local_head", checkGitSha],
	["declared_tree_hash", checkSha256Hex],
	["entry_count", boundedInt(LIMITS.entries)],
	["client_scanner_policy_digest", checkSha256Hex],
];
/** Prepare and input-prepare answer the same way: the first page of the
 *  frozen missing set, and when the capability expires. */
export const PREPARE_RESPONSE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["upload_id", checkOpaqueId],
	["first_page", missingPageField],
	["expires_at", checkRfc3339],
];

export function parseMirrorPrepareRequest(raw: unknown): ShadowParseOutcome<MirrorPrepareRequestV1> {
	return parseRecord(raw, "mirror_prepare_request", fieldsCheck(MIRROR_PREPARE_REQUEST_FIELDS));
}

export function parseMirrorPrepareResponse(raw: unknown): ShadowParseOutcome<MirrorPrepareResponseV1> {
	return parseRecord(raw, "mirror_prepare_response", fieldsCheck(PREPARE_RESPONSE_FIELDS));
}

export const MIRROR_FINALIZE_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["upload_id", checkOpaqueId],
	["idempotency_key", checkOpaqueId],
	["expected_version", counter],
];

export function parseMirrorFinalizeRequest(raw: unknown): ShadowParseOutcome<MirrorFinalizeRequestV1> {
	return parseRecord(raw, "mirror_finalize_request", fieldsCheck(MIRROR_FINALIZE_REQUEST_FIELDS));
}

export const ACCEPTED_FINALIZE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["accepted", literal(true)],
	["attempt_id", checkOpaqueId],
	["status_url", boundedText],
];
export const CONFLICT_FINALIZE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["accepted", literal(false)],
	["reason", literal("version_conflict")],
	["current_version", counter],
];
export const REFUSED_FINALIZE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["accepted", literal(false)],
	["reason", enumField(["version_conflict", "expired", "idempotency_conflict", "unknown_upload", "in_progress"])],
];

/** Only `version_conflict` carries the current version — every other refusal
 *  would be stating a number it did not look up. */
const checkFinalizeResponse: RecordCheck = (value, where) => {
	if (value.accepted === true) return checkFields(value, where, ACCEPTED_FINALIZE_FIELDS);
	if (value.accepted !== false) return `${where}.accepted must be a boolean`;
	if (value.reason === "version_conflict") return checkFields(value, where, CONFLICT_FINALIZE_FIELDS);
	return checkFields(value, where, REFUSED_FINALIZE_FIELDS);
};

export function parseMirrorFinalizeResponse(raw: unknown): ShadowParseOutcome<MirrorFinalizeResponseV1> {
	return parseRecord(raw, "mirror_finalize_response", checkFinalizeResponse);
}

/** The ONE declaration of the publication-failure reasons. Exported because the
 *  broker's `MirrorPublicationAttemptV1` (interlinked-cloud) records the same
 *  failure the client reads in `MirrorFinalizeStatusResponseV1`: a reason added
 *  here without the cloud importing this table would be one the broker can
 *  record and the client parser rejects — or the reverse. */
export const PUBLICATION_FAILURE_FIELDS: readonly FieldSpec[] = [
	[
		"reason",
		enumField(["secrets", "limits", "invalid_tree", "digest_mismatch", "provider_error", "scanner_unavailable", "no_atomic_push", "lease_failed"]),
	],
	["detail", boundedText],
];
export const failureField = nested(fieldsCheck(PUBLICATION_FAILURE_FIELDS));
const STATUS_BASE_FIELDS: readonly FieldSpec[] = [["schema_version", literal(1)], ["attempt_id", checkOpaqueId]];
export const IN_FLIGHT_STATUS_FIELDS: readonly FieldSpec[] = [
	...STATUS_BASE_FIELDS,
	// DERIVED from the tuple in `types-transport.ts`, never re-spelled: the
	// public type and this table are then one declaration, and the cloud's
	// conformance test compares the broker's states against the same tuple.
	["state", enumField(OBSERVABLE_PUBLICATION_STATES)],
];
export const FINALIZE_STATUS_SHAPES: Record<string, readonly FieldSpec[]> = {
	version_committed: [
		...STATUS_BASE_FIELDS,
		["state", literal("version_committed")],
		["version", mirrorRefField],
		["base_ref", checkGitSha],
		["tree_hash", checkSha256Hex],
	],
	failed: [...STATUS_BASE_FIELDS, ["state", literal("failed")], ["failure", failureField]],
};

/** The two TERMINAL states carry a payload; every in-flight state is bare. */
const checkFinalizeStatus: RecordCheck = (value, where) => {
	const terminal = typeof value.state === "string" ? FINALIZE_STATUS_SHAPES[value.state] : undefined;
	return checkFields(value, where, terminal ?? IN_FLIGHT_STATUS_FIELDS);
};

export function parseMirrorFinalizeStatusResponse(raw: unknown): ShadowParseOutcome<MirrorFinalizeStatusResponseV1> {
	return parseRecord(raw, "mirror_finalize_status", checkFinalizeStatus);
}

// ── execution input ────────────────────────────────────────────────────────

export const INPUT_PREPARE_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["upload_id", checkOpaqueId],
	["idempotency_key", checkOpaqueId],
	["client_scanner_policy_digest", checkSha256Hex],
];

export function parseShadowInputPrepareRequest(raw: unknown): ShadowParseOutcome<ShadowInputPrepareRequestV1> {
	return parseRecord(raw, "input_prepare_request", fieldsCheck(INPUT_PREPARE_REQUEST_FIELDS));
}

export function parseShadowInputPrepareResponse(raw: unknown): ShadowParseOutcome<ShadowInputPrepareResponseV1> {
	return parseRecord(raw, "input_prepare_response", fieldsCheck(PREPARE_RESPONSE_FIELDS));
}

export const INPUT_FINALIZE_REQUEST_FIELDS: readonly FieldSpec[] = [["schema_version", literal(1)], ["upload_id", checkOpaqueId], ["idempotency_key", checkOpaqueId]];

export function parseShadowInputFinalizeRequest(raw: unknown): ShadowParseOutcome<ShadowInputFinalizeRequestV1> {
	return parseRecord(raw, "input_finalize_request", fieldsCheck(INPUT_FINALIZE_REQUEST_FIELDS));
}

export const INPUT_FINALIZE_OK_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["ok", literal(true)],
	["bundle_id", checkOpaqueId],
	["bundle_hash", checkSha256Hex],
	["expires_at", checkRfc3339],
];
export const INPUT_FINALIZE_REFUSED_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["ok", literal(false)],
	["reason", enumField(["digest_mismatch", "secrets", "scanner_unavailable", "limits", "expired", "idempotency_conflict", "in_progress"])],
];

const checkInputFinalizeResponse: RecordCheck = (value, where) => {
	if (value.ok === true) return checkFields(value, where, INPUT_FINALIZE_OK_FIELDS);
	if (value.ok === false) return checkFields(value, where, INPUT_FINALIZE_REFUSED_FIELDS);
	return `${where}.ok must be a boolean`;
};

export function parseShadowInputFinalizeResponse(raw: unknown): ShadowParseOutcome<ShadowInputFinalizeResponseV1> {
	return parseRecord(raw, "input_finalize_response", checkInputFinalizeResponse);
}

// ── execution and cancellation ─────────────────────────────────────────────
// The client names the PROFILE; the broker builds the exec config from it, so
// no config field is representable here (memo §8.0 — policy is never
// daemon-controlled).

export const EXECUTION_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["request_id", checkOpaqueId],
	["idempotency_key", checkOpaqueId],
	["bundle_id", checkOpaqueId],
	// The bundle's CONTENT beside the id that names it: admission compares this
	// against the broker's immutable bundle record, so a request cannot bind to
	// a bundle whose content is not the one the daemon finalized.
	["expected_bundle_hash", checkSha256Hex],
	["execution_claim", embedded(parseShadowExecutionClaim)],
	["freshness_claim", embedded(parseShadowFreshnessBinding)],
	["changeset", embedded(parseShadowChangeSet)],
	["tool_input", embedded(parseNormalizedToolInput)],
	["execution_profile_id", literal(EXECUTION_PROFILE_ID)],
	["lane", enumField(["sync-probe", "async"])],
	["deadline_at", checkRfc3339],
];

export function parseShadowExecutionRequest(raw: unknown): ShadowParseOutcome<ShadowExecutionRequestV1> {
	return parseRecord(raw, "execution_request", fieldsCheck(EXECUTION_REQUEST_FIELDS));
}

export const CANCEL_REQUEST_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["request_id", checkOpaqueId],
	["reason", enumField(["hook_deadline", "daemon_deadline", "user"])],
];
export const CANCEL_ACK_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["request_id", checkOpaqueId],
	["state", enumField(["terminated", "already_completed", "unknown_request"])],
];

export function parseCancelRequest(raw: unknown): ShadowParseOutcome<CancelRequestV1> {
	return parseRecord(raw, "cancel_request", fieldsCheck(CANCEL_REQUEST_FIELDS));
}

export function parseCancelAck(raw: unknown): ShadowParseOutcome<CancelAckV1> {
	return parseRecord(raw, "cancel_ack", fieldsCheck(CANCEL_ACK_FIELDS));
}
