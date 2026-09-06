// interlinked-tdd: exempt — the records are exercised by the strict parsers
// and their tests. The one runtime export, `OBSERVABLE_PUBLICATION_STATES`, is
// the parser's own enum table (parse-transport.ts) and is exercised by
// `parse-transport.test.ts` P5, which accepts every member of it.
// ===========================================
// Shadow protocol v1 — staged transport, mirror ingestion, execution input
// ===========================================
// public API — the staged upload primitives shared by the mirror and
// execution-input paths. The SERVER issues every upload capability; a client
// never chooses an R2 key, which is what makes cross-tenant object
// substitution unrepresentable (memo §8.0).

import type { ShadowExecutionClaimV1, ShadowFreshnessBinding } from "./types-binding.js";
import type {
	BlobDigest,
	BundleHash,
	Digest,
	ExecutionProfileId,
	GitSha,
	ManifestDigest,
	MirrorKeyV1,
	MirrorVersionRef,
	NormalizedToolInputV1,
	OpaqueId,
	PreTreeHash,
	Rfc3339,
	ScannerPolicyDigest,
	ShadowChangeSetV1,
} from "./types-core.js";

// ── staged upload primitives ───────────────────────────────────────────────
export interface ManifestUploadInitRequestV1 {
	schema_version: 1;
	scope: { kind: "mirror"; mirror_key: MirrorKeyV1 } | { kind: "input"; mirror: MirrorVersionRef };
	idempotency_key: OpaqueId;
	declared_bytes: number;
	declared_digest: ManifestDigest;
}
export interface ManifestUploadInitResponseV1 {
	schema_version: 1;
	upload_id: OpaqueId; // the capability; scoped to the authenticated principal
	put_url: string;
	max_bytes: number;
	expires_at: Rfc3339;
}
/** The missing set is FROZEN at prepare and identified; page tokens are
 *  cursors over that frozen, ordered set — never a recomputation after
 *  uploads, which would let offset pagination skip entries. */
export interface MissingSetRef {
	missing_set_id: OpaqueId;
	missing_set_digest: Digest<"missing-set">;
	missing_count: number;
}
export interface MissingBlobPageV1 {
	missing_set: MissingSetRef;
	items: readonly { blob_digest: BlobDigest; put_url: string; max_bytes: number }[];
	next_page_token: OpaqueId | null; // cursor over missing_set_id
}
export interface MissingBlobPageRequestV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	page_token: OpaqueId;
}
export interface MissingBlobPageResponseV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	page: MissingBlobPageV1;
}

// ── mirror ingestion ───────────────────────────────────────────────────────
export interface MirrorPrepareRequestV1 {
	schema_version: 1;
	upload_id: OpaqueId; // from ManifestUploadInitResponseV1 (scope.kind = "mirror")
	idempotency_key: OpaqueId;
	base_local_head: GitSha;
	declared_tree_hash: PreTreeHash;
	entry_count: number;
	client_scanner_policy_digest: ScannerPolicyDigest;
}
export interface MirrorPrepareResponseV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	first_page: MissingBlobPageV1;
	expires_at: Rfc3339;
}
export interface MirrorFinalizeRequestV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	idempotency_key: OpaqueId;
	expected_version: number;
}
/** Finalize is ASYNCHRONOUS: accepted + attempt id + status URL. */
export type MirrorFinalizeResponseV1 =
	| { schema_version: 1; accepted: true; attempt_id: OpaqueId; status_url: string }
	| { schema_version: 1; accepted: false; reason: "version_conflict"; current_version: number }
	| { schema_version: 1; accepted: false; reason: "expired" | "idempotency_conflict" | "unknown_upload" | "in_progress" };
/** The ONE declaration of the in-flight publication states: a RUNTIME tuple,
 *  so the public TYPE below and the parser's enum table (`parse-transport.ts`,
 *  `IN_FLIGHT_STATUS_FIELDS`) are both DERIVED from it instead of spelling the
 *  same five strings a second and a third time.
 *
 *  The broker's `MirrorPublicationAttemptV1` — which used to supply this list
 *  through `Exclude<…>` — moved to `interlinked-cloud` in the 2026-09-04
 *  public/private split, so no type relates the two across the repo boundary
 *  any more. The cloud imports THIS tuple from the vendored package and a
 *  conformance test there proves the broker's own state set is exactly
 *  `OBSERVABLE_PUBLICATION_STATES` plus the two terminal states
 *  `"version_committed" | "failed"` (a cloud agent adds that test). A state
 *  added, removed or renamed on either side then fails that test rather than
 *  drifting in silence. */
export const OBSERVABLE_PUBLICATION_STATES = [
	"prepared",
	"blobs_verified",
	"publication_reserved",
	"objects_created",
	"ref_updated",
] as const;

/** GET status_url. The two TERMINAL states carry a payload; every observable
 *  in-flight state is bare and DERIVES its literal union from the tuple above
 *  — spelled inline rather than as a second exported type name, which the
 *  registry and reference-parity pins would then have to excuse by hand. */
export type MirrorFinalizeStatusResponseV1 =
	| { schema_version: 1; attempt_id: OpaqueId; state: (typeof OBSERVABLE_PUBLICATION_STATES)[number] }
	| { schema_version: 1; attempt_id: OpaqueId; state: "version_committed"; version: MirrorVersionRef; base_ref: GitSha; tree_hash: PreTreeHash }
	| { schema_version: 1; attempt_id: OpaqueId; state: "failed"; failure: PublicationFailure };

export interface PublicationFailure {
	reason:
		| "secrets"
		| "limits"
		| "invalid_tree"
		| "digest_mismatch"
		| "provider_error"
		| "scanner_unavailable"
		| "no_atomic_push"
		| "lease_failed";
	detail: string;
}
/** The LOCAL freshness pointer (`.interlinked/shadow-mirror.json`) — agent
 *  writable, therefore never authoritative. */
export interface MirrorBindingV1 {
	schema_version: 1;
	mirror_key: MirrorKeyV1;
	last_known: MirrorVersionRef & { base_ref: GitSha; base_local_head: GitSha };
}

// ── execution input ────────────────────────────────────────────────────────
export interface ShadowInputPrepareRequestV1 {
	schema_version: 1;
	/** from ManifestUploadInitResponseV1 (scope.kind = "input"); the
	 *  ExecutionManifestV1 is the staged object, never inline arrays */
	upload_id: OpaqueId;
	idempotency_key: OpaqueId;
	client_scanner_policy_digest: ScannerPolicyDigest;
}
export interface ShadowInputPrepareResponseV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	first_page: MissingBlobPageV1;
	expires_at: Rfc3339;
}
export interface ShadowInputFinalizeRequestV1 {
	schema_version: 1;
	upload_id: OpaqueId;
	idempotency_key: OpaqueId;
}
/** Wire response is SMALL; the full bundle record is broker-internal. */
export type ShadowInputFinalizeResponseV1 =
	| { schema_version: 1; ok: true; bundle_id: OpaqueId; bundle_hash: BundleHash; expires_at: Rfc3339 }
	| {
			schema_version: 1;
			ok: false;
			reason: "digest_mismatch" | "secrets" | "scanner_unavailable" | "limits" | "expired" | "idempotency_conflict" | "in_progress";
	  };

export interface ShadowExecutionRequestV1 {
	schema_version: 1;
	request_id: OpaqueId;
	idempotency_key: OpaqueId;
	bundle_id: OpaqueId;
	/** The CONTENT the request means, beside the id that names it: the
	 *  `bundle_hash` the daemon received from `ShadowInputFinalizeResponseV1.ok`.
	 *  A bundle id alone binds admission to a mutable pointer — the broker
	 *  compares this against its own immutable bundle record, so a request that
	 *  names a bundle whose content is not the one the daemon finalized is
	 *  refused instead of executed. */
	expected_bundle_hash: BundleHash;
	execution_claim: ShadowExecutionClaimV1;
	freshness_claim: ShadowFreshnessBinding;
	changeset: ShadowChangeSetV1;
	tool_input: NormalizedToolInputV1;
	execution_profile_id: ExecutionProfileId; // broker builds ShadowExecConfigV1 from it
	lane: "sync-probe" | "async";
	deadline_at: Rfc3339; // clamped by the broker
}
export interface CancelRequestV1 {
	schema_version: 1;
	request_id: OpaqueId;
	reason: "hook_deadline" | "daemon_deadline" | "user";
}
export interface CancelAckV1 {
	schema_version: 1;
	request_id: OpaqueId;
	state: "terminated" | "already_completed" | "unknown_request";
}
