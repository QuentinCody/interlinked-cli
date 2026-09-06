// ===========================================
// Shadow protocol v1 — strict parsers: configuration, environment, freshness,
// mirror lifecycle
// ===========================================
// The ONE gate through which an untrusted value becomes one of these typed
// records (memo §8.0, first bullet: unknown field / unknown version /
// out-of-range → reject). "Internal" describes where the bytes came from, not
// how much they can be trusted: a record restored from D1, R2 or a Durable
// Object is a wire value the moment it leaves storage, so it is decoded here
// exactly as strictly as a client-supplied one.
//
// A parser proves SHAPE ONLY. It never checks that a digest equals the bytes
// it claims, that a consent is still in force, that an env block describes the
// image that actually ran, or that a deletion happened at the provider — those
// are admission's, the materializer's and `verify`'s jobs. An accepted record
// is a well-formed record, not a trusted one.
//
// Field descriptors are TABLES, not if-chains: the allowed key set and the
// per-field validators are the same declaration, so "unknown field" and "bad
// field" can never disagree about what a record contains.

import { checkBool, checkOpaqueId, checkRfc3339, checkSha256Hex } from "./field-checks.js";
import { SHADOW_LIMITS_V1 } from "./limits.js";
import {
	boundedInt,
	checkFields,
	type FieldSpec,
	fieldsCheck,
	literal,
	nested,
	type ShadowParseOutcome,
	parseRecord,
	type RecordCheck,
} from "./parse-core-entries.js";
import { MIRROR_KEY_FIELDS, mirrorRef, parseShadowFreshnessBinding } from "./parse-core.js";
import { boundedText, embedded, enumField, listOf, MAX_ARGV, nullable } from "./parse-outcome.js";
import type { LocalFreshnessCheckV1, ShadowEnvV1 } from "./types-binding.js";
import { EXECUTION_PROFILE_ID, type ScannerPolicyV1, type ShadowExecConfigV1 } from "./types-core.js";
import type {
	DeletionReceipt,
	MirrorState,
	MirrorStatusV1,
	RestorationEligibility,
	RetentionConsentV1,
} from "./types-lifecycle.js";

const LIMITS = SHADOW_LIMITS_V1;
/** A verifier argv and an env allowlist are both short, fixed lists built by
 *  the broker; the cap is a wire sanity limit, not a policy. */
/** A decade. Beyond this the retention machinery, not the parser, is broken. */
const MAX_RETENTION_DAYS = 3_650;

/** An enum's members are derived from a `Record<Union, true>`, so the compiler
 *  requires every member and the list can never fall behind the type. */
function membersOf(table: Readonly<Record<string, true>>): readonly string[] {
	return Object.keys(table);
}

// ── broker-constructed execution config (memo §8.0) ────────────────────────
// The client names the PROFILE; the broker builds this. `introduced_only` is
// a literal `true`, so a config that turned the mode off is unrepresentable.

const EXEC_CONFIG_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["profile_id", literal(EXECUTION_PROFILE_ID)],
	["typecheck_strict", checkBool],
	["introduced_only", literal(true)],
	["max_diagnostics", boundedInt(LIMITS.diagnostics_count)],
];

export function parseShadowExecConfig(raw: unknown): ShadowParseOutcome<ShadowExecConfigV1> {
	return parseRecord(raw, "exec_config", fieldsCheck(EXEC_CONFIG_FIELDS));
}

// ── scanner policy ─────────────────────────────────────────────────────────
// Repo configuration is `ignored` and an error is `unavailable`, both as
// literals: a policy that quietly honored a repo-local scanner config, or that
// failed open on a scanner error, cannot be expressed.

const SCANNER_POLICY_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["scanner", literal("interlinked-shadow-scanner")],
	["binary_sha256", checkSha256Hex],
	["invocation_hash", checkSha256Hex],
	["ruleset_bytes_sha256", checkSha256Hex],
	["repo_config_effect", literal("ignored")],
	["on_error", literal("unavailable")],
];

export function parseScannerPolicy(raw: unknown): ShadowParseOutcome<ScannerPolicyV1> {
	return parseRecord(raw, "scanner_policy", fieldsCheck(SCANNER_POLICY_FIELDS));
}

// ── published environment (env_digest = H(canonical(ShadowEnvV1))) ─────────
// `resource_limits` is checked against the ONE limits object field by field:
// every member of `ShadowLimitsV1` is a literal type, so a limits block that
// disagrees with `SHADOW_LIMITS_V1` is a different protocol version, not a
// tunable. Deriving the table from the object keeps the two from drifting.

const LIMITS_FIELDS: readonly FieldSpec[] = Object.entries(LIMITS).map(([key, value]) => [key, literal(value)]);

const REGISTRY_POLICY_FIELDS: readonly FieldSpec[] = [
	["host", boundedText],
	["replace_registry_host", literal("always")],
];

const SHADOW_ENV_FIELDS: readonly FieldSpec[] = [
	["schema", literal("shadow-env-v1")],
	["image_manifest_digest", boundedText],
	["verifier_sha256", checkSha256Hex],
	["argv", listOf(boundedText, MAX_ARGV)],
	["cwd", boundedText],
	["env_allowlist", listOf(boundedText, MAX_ARGV)],
	["provisioner_version", boundedText],
	["registry_policy", nested(fieldsCheck(REGISTRY_POLICY_FIELDS))],
	["egress_policy_hash", checkSha256Hex],
	["broker_scanner_policy_digest", checkSha256Hex],
	["exec_config_hash", checkSha256Hex],
	["resource_limits", nested(fieldsCheck(LIMITS_FIELDS))],
];

export function parseShadowEnv(raw: unknown): ShadowParseOutcome<ShadowEnvV1> {
	return parseRecord(raw, "shadow_env", fieldsCheck(SHADOW_ENV_FIELDS));
}

// ── the daemon's own local freshness check (memo I4) ───────────────────────
// It never leaves the machine and is never signed — but it IS persisted, so it
// is read back through a parser like everything else.

const LOCAL_FRESHNESS_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["claimed", embedded(parseShadowFreshnessBinding)],
	["measured_from_disk", embedded(parseShadowFreshnessBinding)],
	["matches", checkBool],
	["checked_at", checkRfc3339],
];

export function parseLocalFreshnessCheck(raw: unknown): ShadowParseOutcome<LocalFreshnessCheckV1> {
	return parseRecord(raw, "local_freshness_check", fieldsCheck(LOCAL_FRESHNESS_FIELDS));
}

// ── retention consent and mirror status (Plan 05B's records) ───────────────

const RETENTION_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["repository_id", checkOpaqueId],
	["auto_disable_after_days", boundedInt(MAX_RETENTION_DAYS)],
	// `null` is a VALUE here — "disable, then never delete" — and is not the
	// same statement as an absent field.
	["auto_delete_after_further_days", nullable(boundedInt(MAX_RETENTION_DAYS))],
	["consented_by", checkOpaqueId],
	["consented_at", checkRfc3339],
];

export function parseRetentionConsent(raw: unknown): ShadowParseOutcome<RetentionConsentV1> {
	return parseRecord(raw, "retention_consent", fieldsCheck(RETENTION_FIELDS));
}

const MIRROR_STATES = membersOf({
	active: true,
	disabled: true,
	quarantined: true,
	deletion_requested: true,
	provider_deleted: true,
	restore_window_open: true,
	restore_window_elapsed_provider_absent: true,
} satisfies Record<MirrorState, true>);

const MIRROR_STATUS_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["mirror_key", nested(fieldsCheck(MIRROR_KEY_FIELDS))],
	["state", enumField(MIRROR_STATES)],
	// A mirror with no published version yet states so with `null`; there is
	// no zero-version sentinel.
	["current", nullable(mirrorRef)],
	["retention", nested(fieldsCheck(RETENTION_FIELDS))],
];

export function parseMirrorStatus(raw: unknown): ShadowParseOutcome<MirrorStatusV1> {
	return parseRecord(raw, "mirror_status", fieldsCheck(MIRROR_STATUS_FIELDS));
}

// ── deletion receipts ──────────────────────────────────────────────────────
// A structural state machine: each state carries EXACTLY what it can know.
// `deletion_requested` has observed nothing at the provider, so a
// `provider_deleted_at` there is malformed; the elapsed state has finished
// reconciling, so a pending `reconciliation` there is malformed too.

const RESTORATION_ELIGIBILITY = membersOf({
	eligible: true,
	ineligible_fork_network: true,
	unknown: true,
} satisfies Record<RestorationEligibility, true>);

const RECEIPT_BASE_FIELDS: readonly FieldSpec[] = [
	["schema_version", literal(1)],
	["provider_request_id", boundedText],
	["requested_at", checkRfc3339],
];
const RECEIPT_DELETED_FIELDS: readonly FieldSpec[] = [
	...RECEIPT_BASE_FIELDS,
	["provider_deleted_at", checkRfc3339],
	// `null` means "no restore window", not "unknown deadline".
	["restorable_until", nullable(checkRfc3339)],
	["restoration_eligibility", enumField(RESTORATION_ELIGIBILITY)],
];

const RECEIPT_SHAPES: Record<string, readonly FieldSpec[]> = {
	deletion_requested: [...RECEIPT_BASE_FIELDS, ["state", literal("deletion_requested")]],
	provider_deleted: [
		...RECEIPT_DELETED_FIELDS,
		["state", literal("provider_deleted")],
		["reconciliation", enumField(["pending", "confirmed", "failed"])],
	],
	restore_window_open: [
		...RECEIPT_DELETED_FIELDS,
		["state", literal("restore_window_open")],
		["reconciliation", enumField(["pending", "confirmed", "failed"])],
	],
	restore_window_elapsed_provider_absent: [
		...RECEIPT_DELETED_FIELDS,
		["state", literal("restore_window_elapsed_provider_absent")],
		["reconciled_absent_at", checkRfc3339],
	],
};

const checkDeletionReceipt: RecordCheck = (value, where) => {
	const fields = typeof value.state === "string" ? RECEIPT_SHAPES[value.state] : undefined;
	if (fields === undefined) {
		return `${where}.state must be one of: ${Object.keys(RECEIPT_SHAPES).sort().join(", ")}`;
	}
	return checkFields(value, where, fields);
};

export function parseDeletionReceipt(raw: unknown): ShadowParseOutcome<DeletionReceipt> {
	return parseRecord(raw, "deletion_receipt", checkDeletionReceipt);
}

// ── the published key sets ─────────────────────────────────────────────────
// The SAME tables the parsers above validate against, keyed by the `where`
// label each parser passes to `parseRecord`, with one entry per union variant.
// `deletion_receipt` publishes four state shapes where the type declares three
// interfaces — two states carry identical fields — so the registry compares key
// SETS, never variant counts.

export const RECORD_FIELD_TABLES: Record<string, readonly (readonly FieldSpec[])[]> = {
	exec_config: [EXEC_CONFIG_FIELDS],
	scanner_policy: [SCANNER_POLICY_FIELDS],
	shadow_env: [SHADOW_ENV_FIELDS],
	local_freshness_check: [LOCAL_FRESHNESS_FIELDS],
	retention_consent: [RETENTION_FIELDS],
	mirror_status: [MIRROR_STATUS_FIELDS],
	deletion_receipt: Object.values(RECEIPT_SHAPES),
};
