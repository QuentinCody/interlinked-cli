// Public reference snapshot from the frozen r16 shadow design, 2026-09-06.
// Used by protocol/__tests__/reference-parity.test.ts; independent of product
// imports so accidental contract drift remains visible in a public checkout.
// Broker-internal declarations are omitted. The public mirror-status states
// spell out the same union formerly derived from the private broker record.
// Update only with an intentional, reviewed public contract change.

export type Digest<P extends string> = string & { readonly __digest: P };

export type PreTreeHash = Digest<"pre-tree">;

export type PostTreeHash = Digest<"post-tree">;

export type PostImageSetHash = Digest<"post-image-set">;

export type OverlayBytesHash = Digest<"overlay-bytes">;

export type OverlayManifestHash = Digest<"overlay-manifest">;

export type DependencyInputHash = Digest<"dependency-input">;

export type DependencyTreeHash = Digest<"dependency-tree">;

export type DependencyCacheRecordHash = Digest<"dependency-cache-record">;

export type EnvDigest = Digest<"env">;

export type ExecConfigHash = Digest<"exec-config">;

export type ToolInputHash = Digest<"tool-input">;

export type ResultHash = Digest<"verifier-result">;

export type JobHash = Digest<"admission-job">;

export type BlobDigest = Digest<"blob">;

export type ManifestDigest = Digest<"snapshot-manifest">;

export type BundleHash = Digest<"input-bundle">;

export type RequestDigest = Digest<"request">;

export type ScannerPolicyDigest = Digest<"scanner-policy">;

export type GitSha = string & { readonly __brand: "gitsha" };

export type Rfc3339 = string & { readonly __brand: "rfc3339" };

export type OpaqueId = string & { readonly __brand: "opaque-id" };

export type CanonicalPath = string & { readonly __brand: "canonical-path" };

export type CanonicalJson = string & { readonly __brand: "canonical-json" };

export type TreeAlgo = "shadow-tree-v1";

export type PostImageAlgo = "shadow-postimages-v1";

export type OverlayAlgo = "shadow-overlay-v1";

export type DependencyTreeAlgo = "shadow-dependency-tree-v1";

export type GitMode = "100644" | "100755";

export interface MirrorKeyV1 {
	repository_id: OpaqueId; // broker authority (Plan 01A), never caller-chosen
	session_id: OpaqueId;
	kind: "synthetic_full_tree";
}

export interface MirrorVersionRef {
	key: MirrorKeyV1;
	version: number;
}

export interface ManifestEntryV1 {
	path: CanonicalPath;
	mode: GitMode;
	blob_digest: BlobDigest;
	bytes: number;
}

export type OverlayEntryV1 =
	| { tag: "W"; path: CanonicalPath; mode: GitMode; blob_digest: BlobDigest; bytes: number }
	| { tag: "D"; path: CanonicalPath };

export type PostImageEntryV1 =
	| { tag: "W"; path: CanonicalPath; mode: GitMode; blob_digest: BlobDigest; bytes: number }
	| { tag: "D"; path: CanonicalPath };

export type OverlayIncludeRuleV1 =
	| { kind: "exact"; path: CanonicalPath }
	| { kind: "gitwildmatch-v1"; pattern: string };

export interface OverlayManifestV1 {
	schema_version: 1;
	include_rules: readonly OverlayIncludeRuleV1[];
	deny_ruleset_id: "shadow-overlay-deny-v1";
}

export interface ExecutionManifestV1 {
	schema_version: 1;
	mirror: MirrorVersionRef;
	/** the COMPLETE overlay manifest travels, so the broker can validate and
	 *  canonicalize the caller's include rules before calling the resulting
	 *  hash "broker-expected" */
	overlay_manifest: OverlayManifestV1;
	overlay: readonly OverlayEntryV1[];
	post_images: readonly PostImageEntryV1[];
}

export interface ShadowChangeSetV1 {
	schema_version: 1;
	pre_tree_hash: PreTreeHash;
	post_image_set_hash: PostImageSetHash;
	touched_paths: readonly CanonicalPath[];
}

export type NormalizedToolInputV1 =
	| { schema: "shadow-tool-input-v1"; client: "claude-code"; tool: "Write"; semantics_version: 1; file_path: CanonicalPath; content: string }
	| { schema: "shadow-tool-input-v1"; client: "claude-code"; tool: "Edit"; semantics_version: 1; file_path: CanonicalPath; old_string: string; new_string: string; replace_all: boolean }
	| { schema: "shadow-tool-input-v1"; client: "claude-code"; tool: "MultiEdit"; semantics_version: 1; file_path: CanonicalPath; edits: readonly { old_string: string; new_string: string; replace_all: boolean }[] }
	| { schema: "shadow-tool-input-v1"; client: "codex"; tool: "apply_patch"; semantics_version: 1; patch: string; raw_source_field: "command" | "patch" | "_raw_patch" | "content" };

export interface ShadowExecConfigV1 {
	schema_version: 1;
	profile_id: "shadow-typecheck-v1";
	typecheck_strict: boolean;
	introduced_only: true;
	max_diagnostics: number;
}

export interface ScannerPolicyV1 {
	schema_version: 1;
	scanner: "interlinked-shadow-scanner";
	binary_sha256: Digest<"scanner-binary">;
	invocation_hash: Digest<"scanner-invocation">;
	ruleset_bytes_sha256: Digest<"scanner-ruleset">;
	repo_config_effect: "ignored";
	on_error: "unavailable";
}

export type DependencyRequestV1 =
	| { mode: "none" }
	| { mode: "npm-v1"; input_hash: DependencyInputHash };

export type ResolvedDependencyBindingV1 =
	| { mode: "none" }
	| { mode: "npm-v1"; source: "fresh"; input_hash: DependencyInputHash; tree_algo: DependencyTreeAlgo; tree_hash: DependencyTreeHash }
	| { mode: "npm-v1"; source: "cache"; input_hash: DependencyInputHash; tree_algo: DependencyTreeAlgo; tree_hash: DependencyTreeHash; cache_record_hash: DependencyCacheRecordHash };

export interface DependencyTreeCacheRecordV1 {
	schema_version: 1;
	input_hash: DependencyInputHash;
	image_manifest_digest: string;
	npm_version: string;
	registry_policy_digest: Digest<"registry-policy">;
	broker_scanner_policy_digest: ScannerPolicyDigest;
	tree_algo: DependencyTreeAlgo;
	tree_hash: DependencyTreeHash;
	backup_handle: OpaqueId;
	expires_at: Rfc3339;
	created_at: Rfc3339;
}

export interface ShadowExecutionClaimV1 {
	mirror: MirrorVersionRef;
	base_ref: GitSha;
	tree_algo: TreeAlgo;
	post_image_algo: PostImageAlgo;
	overlay_algo: OverlayAlgo;
	overlay_manifest_hash: OverlayManifestHash;
	overlay_bytes_hash: OverlayBytesHash;
	pre_tree_hash: PreTreeHash;
	post_image_set_hash: PostImageSetHash;
	post_tree_hash: PostTreeHash;
	dependencies: DependencyRequestV1;
}

export interface ExpectedExecutionPolicyV1 {
	tree_algo: TreeAlgo;
	post_image_algo: PostImageAlgo;
	overlay_algo: OverlayAlgo;
	overlay_manifest_hash: OverlayManifestHash;
	env_digest: EnvDigest;
	exec_config_hash: ExecConfigHash; // from the broker-built ShadowExecConfigV1
	broker_scanner_policy_digest: ScannerPolicyDigest;
	dependency_cache_record_hash?: DependencyCacheRecordHash;
	deadline_at: Rfc3339; // CLAMPED to broker policy
}

export interface ShadowExecutionBinding {
	mirror: MirrorVersionRef;
	base_ref: GitSha;
	tree_algo: TreeAlgo;
	post_image_algo: PostImageAlgo;
	overlay_algo: OverlayAlgo;
	overlay_manifest_hash: OverlayManifestHash;
	overlay_bytes_hash: OverlayBytesHash;
	pre_tree_hash: PreTreeHash;
	post_image_set_hash: PostImageSetHash;
	post_tree_hash: PostTreeHash;
	dependencies: ResolvedDependencyBindingV1;
	env_digest: EnvDigest;
	exec_config_hash: ExecConfigHash;
}

export interface ShadowFreshnessBinding {
	base_local_head: GitSha;
	local_head: GitSha;
	input_hash: ToolInputHash;
	local_pre_tree_hash: PreTreeHash; // recomputed over the mirrored surface at apply time
	local_overlay_manifest_hash: OverlayManifestHash;
	local_post_image_set_hash: PostImageSetHash;
}

export interface LocalFreshnessCheckV1 {
	schema_version: 1;
	claimed: ShadowFreshnessBinding;
	measured_from_disk: ShadowFreshnessBinding;
	matches: boolean;
	checked_at: Rfc3339;
}

export interface ShadowEnvV1 {
	schema: "shadow-env-v1";
	image_manifest_digest: string;
	verifier_sha256: Digest<"verifier-binary">;
	argv: readonly string[];
	cwd: string;
	env_allowlist: readonly string[];
	provisioner_version: string;
	registry_policy: { host: string; replace_registry_host: "always" };
	egress_policy_hash: Digest<"egress-policy">;
	broker_scanner_policy_digest: ScannerPolicyDigest;
	exec_config_hash: ExecConfigHash;
	resource_limits: ShadowLimitsV1;
}

export type Primitive = string | number | boolean | null | undefined;

export type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

export type Paths<T, P extends string = ""> = T extends Primitive
	? P
	: T extends readonly unknown[]
		? P
		: { [K in keyof T & string]: Paths<T[K], Join<P, K>> }[keyof T & string];

export type ExecutionBindingLeaf = Paths<ShadowExecutionBinding>;

export type FreshnessLeaf = Paths<ShadowFreshnessBinding>;

export type ProvenanceLeaf = ExecutionBindingLeaf | FreshnessLeaf;

export type Party = "daemon" | "broker_policy" | "broker_authority" | "materializer" | "broker_cache";

export interface FieldContract {
	asserted_by?: Party;
	expected_by?: Party;
	measured_by: Party;
	authority: "policy" | "content" | "freshness" | "execution_fact" | "identity";
}

export interface ConditionalContract {
	by_source: { fresh: FieldContract; cache: FieldContract };
}

export type LeafContract = FieldContract | ConditionalContract;

const POLICY: FieldContract = { expected_by: "broker_policy", measured_by: "materializer", authority: "policy" };

const CONTENT: FieldContract = { asserted_by: "daemon", measured_by: "materializer", authority: "content" };

const IDENTITY: FieldContract = { expected_by: "broker_authority", measured_by: "materializer", authority: "identity" };

const FRESH: FieldContract = { asserted_by: "daemon", measured_by: "daemon", authority: "freshness" };

export const BINDING_PROVENANCE = {
	"mirror.key.repository_id": IDENTITY,
	"mirror.key.session_id": IDENTITY,
	"mirror.key.kind": IDENTITY,
	// the authoritative version→ref mapping is BROKER-held; the daemon's copy is
	// a claim compared against it, so authority is the broker, not the daemon
	"mirror.version": { asserted_by: "daemon", expected_by: "broker_authority", measured_by: "materializer", authority: "identity" },
	base_ref: { asserted_by: "daemon", expected_by: "broker_authority", measured_by: "materializer", authority: "identity" },
	tree_algo: POLICY,
	post_image_algo: POLICY,
	overlay_algo: POLICY,
	overlay_manifest_hash: POLICY,
	overlay_bytes_hash: CONTENT,
	pre_tree_hash: CONTENT,
	post_image_set_hash: CONTENT,
	post_tree_hash: CONTENT,
	"dependencies.mode": CONTENT,
	"dependencies.input_hash": CONTENT,
	"dependencies.source": {
		by_source: {
			fresh: { measured_by: "materializer", authority: "execution_fact" },
			cache: { expected_by: "broker_cache", measured_by: "materializer", authority: "content" },
		},
	},
	"dependencies.tree_algo": POLICY,
	"dependencies.tree_hash": {
		by_source: {
			fresh: { measured_by: "materializer", authority: "execution_fact" },
			cache: { expected_by: "broker_cache", measured_by: "materializer", authority: "content" },
		},
	},
	"dependencies.cache_record_hash": { expected_by: "broker_cache", measured_by: "materializer", authority: "content" },
	env_digest: POLICY,
	exec_config_hash: POLICY,
	base_local_head: FRESH,
	local_head: FRESH,
	input_hash: FRESH,
	local_pre_tree_hash: FRESH,
	local_overlay_manifest_hash: FRESH,
	local_post_image_set_hash: FRESH,
} as const satisfies Record<ProvenanceLeaf, LeafContract>;

export interface ShadowLimitsV1 {
	schema_version: 1;
	total_request_bytes: 67_108_864;
	overlay_bytes: 52_428_800;
	post_image_set_bytes: 52_428_800;
	single_entry_bytes: 10_485_760;
	entries: 100_000;
	path_bytes: 4_096;
	path_component_bytes: 255; // POSIX NAME_MAX
	command_stdin_toolinput_bytes: 1_048_576;
	diagnostics_count: 10_000;
	diagnostics_bytes: 5_242_880;
	stdio_head_bytes: 65_536;
	outcome_record_bytes: 8_388_608;
	git_response_compressed_bytes: 268_435_456;
	git_logical_object_bytes: 1_073_741_824;
	git_temp_bytes: 134_217_728;
	working_tree_bytes: 536_870_912;
	dependency_tree_bytes: 805_306_368;
	backup_archive_bytes: 268_435_456;
	manifest_object_bytes: 33_554_432;
	missing_blobs_page_size: 500;
	upload_blob_bytes: 10_485_760;
	upload_aggregate_bytes: 536_870_912;
	upload_ttl_seconds: 3_600;
	sync_eligible_overlay_bytes: 2_097_152;
	sync_eligible_post_image_bytes: 1_048_576;
	// bytes alone do not bound the hook budget — a 2 MiB overlay of tiny files
	// is thousands of PUTs and copies. Sync eligibility ALSO caps operations;
	// above these the core lane declines. Workstream 04 may add a framed
	// aggregate only after Plan 02 measures and specifies that transport.
	sync_eligible_entries: 200;
	sync_eligible_missing_blobs: 64;
	sync_eligible_pages: 1;
	sync_eligible_http_requests: 80;
}

export type ProcessTermination =
	| { kind: "exited"; code: number }
	| { kind: "signaled"; signal: string };

export interface DiagnosticV1 {
	file: CanonicalPath | null;
	line: number | null;
	col: number | null;
	category: "error" | "warning" | "suggestion" | "message";
	code: number;
	message: string;
}

export interface CompilerIdentity {
	path: string;
	sha256: Digest<"verifier-binary">;
	version: string;
	image_digest: string;
}

export interface TscInvocation {
	argv: readonly string[];
	cwd: string;
	locale: "en";
	pretty: false;
}

export interface CompleteTscRunV1 {
	status: "complete";
	termination: { kind: "exited"; code: number };
	diagnostics_total: number;
	diagnostics: readonly DiagnosticV1[];
}

export interface IncompleteTscRunV1 {
	status: "crashed" | "timeout" | "output_truncated";
	termination?: ProcessTermination;
	diagnostics_partial: readonly DiagnosticV1[];
}

export type TscRunV1 = CompleteTscRunV1 | IncompleteTscRunV1;

export interface CompleteShadowTscResultV1 {
	result_schema: "shadow-tsc-result-v1";
	mode: "introduced-only";
	compiler: CompilerIdentity;
	invocation: TscInvocation;
	dependencies: Exclude<ResolvedDependencyBindingV1, { mode: "none" }>;
	pre: CompleteTscRunV1;
	post: CompleteTscRunV1;
	introduced: readonly DiagnosticV1[];
}

export interface IncompleteShadowTscResultV1 {
	result_schema: "shadow-tsc-result-v1";
	mode: "introduced-only";
	compiler: CompilerIdentity;
	invocation: TscInvocation;
	dependencies: ResolvedDependencyBindingV1;
	pre: TscRunV1;
	post?: TscRunV1;
	incomplete: true;
}

export type ShadowPhase = "admit" | "fetch" | "materialize" | "project" | "provision" | "verify";

export type ShadowUnavailableReason =
	| "mirror_lag"
	| "mirror_unavailable"
	| "mirror_integrity"
	| "invalid_tree"
	| "binding_mismatch"
	| "projection"
	| "symlink_escape"
	| "dependency_source"
	| "provisioning"
	| "execution_failed"
	| "secrets"
	| "scanner_unavailable"
	| "limits"
	| "unsupported_capability"
	| "verifier_incomplete"
	| "timeout"
	| "cancelled"
	| "broker_unreachable"
	| "classifier_disagreement"
	| "idempotency_conflict"
	| "bundle_expired";

export const REASON_PHASES = {
	mirror_lag: ["fetch"],
	mirror_unavailable: ["fetch"],
	mirror_integrity: ["fetch"],
	invalid_tree: ["materialize", "provision"],
	binding_mismatch: ["materialize", "project", "provision", "verify"],
	projection: ["project"],
	symlink_escape: ["materialize", "project", "provision"],
	dependency_source: ["provision"],
	provisioning: ["provision"],
	execution_failed: ["verify"],
	secrets: ["admit"],
	scanner_unavailable: ["admit"],
	limits: ["admit", "fetch", "materialize", "project", "provision", "verify"],
	unsupported_capability: ["admit"],
	verifier_incomplete: ["verify"],
	timeout: ["fetch", "materialize", "project", "provision", "verify"],
	cancelled: ["fetch", "materialize", "project", "provision", "verify"],
	broker_unreachable: ["admit"],
	classifier_disagreement: ["admit"],
	idempotency_conflict: ["admit"],
	bundle_expired: ["admit"],
} as const satisfies Record<ShadowUnavailableReason, readonly ShadowPhase[]>;

export interface WorkspaceDiff {
	added: readonly CanonicalPath[];
	modified: readonly CanonicalPath[];
	deleted: readonly CanonicalPath[];
	bytes_changed: number;
}

export type MismatchComparison = "claim_vs_measurement" | "policy_vs_measurement" | "authority_vs_measurement" | "cache_vs_measurement";

export type BindingFieldMismatchV1 =
	| { field: ExecutionBindingLeaf; comparison: MismatchComparison; expected: CanonicalJson; measured: CanonicalJson }
	| { field: ExecutionBindingLeaf; comparison: MismatchComparison; expected: CanonicalJson; measured?: never; unavailable_reason: "not_reached" | "not_provisioned" | "not_applicable" };

export type NonEmpty<T> = readonly [T, ...T[]];

export interface OutcomeBase {
	schema_version: 1;
	status: "completed";
	request_id: OpaqueId;
	bundle_id: OpaqueId;
	execution_claim: ShadowExecutionClaimV1;
	expected_execution: ExpectedExecutionPolicyV1;
	measured_execution: ShadowExecutionBinding;
	freshness_claim: ShadowFreshnessBinding; // echoed, never attested
	duration_ms: number;
}

export type MaterializedOutcomeV1 = OutcomeBase & { kind: "materialized" };

export type VerifiedOutcomeV1 = OutcomeBase & { kind: "verified"; verifier: CompleteShadowTscResultV1 };

export type AttestedOutcomeV1 = OutcomeBase & {
	kind: "attested";
	verifier: CompleteShadowTscResultV1;
	attestation: AuthoringAttestationV1;
};

export type RehearsedOutcomeV1 = OutcomeBase & {
	kind: "rehearsed";
	termination: ProcessTermination;
	workspace_diff: WorkspaceDiff;
	stdout_head: string;
	stderr_head: string;
	divergence_risk: "low" | "medium" | "high";
};

export type CompletedShadowOutcome = MaterializedOutcomeV1 | VerifiedOutcomeV1 | AttestedOutcomeV1 | RehearsedOutcomeV1;

export interface UnavailableBase {
	schema_version: 1;
	status: "unavailable";
	request_id: OpaqueId;
	phase: ShadowPhase;
	detail: string;
	duration_ms: number;
	attestation?: never;
}

export type BindingMismatchOutcome = UnavailableBase & {
	reason: "binding_mismatch";
	execution_claim: ShadowExecutionClaimV1;
	mismatches: NonEmpty<BindingFieldMismatchV1>;
};

export type OtherUnavailableOutcome = UnavailableBase & {
	reason: Exclude<ShadowUnavailableReason, "binding_mismatch">;
	execution_claim?: ShadowExecutionClaimV1;
	verifier_result?: IncompleteShadowTscResultV1;
};

export type ShadowOutcome = CompletedShadowOutcome | BindingMismatchOutcome | OtherUnavailableOutcome;

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

export type MirrorFinalizeResponseV1 =
	| { schema_version: 1; accepted: true; attempt_id: OpaqueId; status_url: string }
	| { schema_version: 1; accepted: false; reason: "version_conflict"; current_version: number }
	| { schema_version: 1; accepted: false; reason: "expired" | "idempotency_conflict" | "unknown_upload" | "in_progress" };

export type MirrorFinalizeStatusResponseV1 =
	| { schema_version: 1; attempt_id: OpaqueId; state: "prepared" | "blobs_verified" | "publication_reserved" | "objects_created" | "ref_updated" }
	| { schema_version: 1; attempt_id: OpaqueId; state: "version_committed"; version: MirrorVersionRef; base_ref: GitSha; tree_hash: PreTreeHash }
	| { schema_version: 1; attempt_id: OpaqueId; state: "failed"; failure: PublicationFailure };

export interface PublicationFailure {
	reason: "secrets" | "limits" | "invalid_tree" | "digest_mismatch" | "provider_error" | "scanner_unavailable" | "no_atomic_push" | "lease_failed";
	detail: string;
}

export interface MirrorBindingV1 {
	schema_version: 1;
	mirror_key: MirrorKeyV1;
	last_known: MirrorVersionRef & { base_ref: GitSha; base_local_head: GitSha };
}

export interface MirrorStatusV1 {
	schema_version: 1;
	mirror_key: MirrorKeyV1;
	state: MirrorState;
	current: MirrorVersionRef | null;
	retention: RetentionConsentV1;
}

export interface ShadowInputPrepareRequestV1 {
	schema_version: 1;
	upload_id: OpaqueId; // from ManifestUploadInitResponseV1 (scope.kind = "input"); the
	// ExecutionManifestV1 is the staged object, never inline arrays
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

export type ShadowInputFinalizeResponseV1 =
	| { schema_version: 1; ok: true; bundle_id: OpaqueId; bundle_hash: BundleHash; expires_at: Rfc3339 }
	| { schema_version: 1; ok: false; reason: "digest_mismatch" | "secrets" | "scanner_unavailable" | "limits" | "expired" | "idempotency_conflict" | "in_progress" };

export interface ShadowExecutionRequestV1 {
	schema_version: 1;
	request_id: OpaqueId;
	idempotency_key: OpaqueId;
	bundle_id: OpaqueId;
	execution_claim: ShadowExecutionClaimV1;
	freshness_claim: ShadowFreshnessBinding;
	changeset: ShadowChangeSetV1;
	tool_input: NormalizedToolInputV1;
	execution_profile_id: "shadow-typecheck-v1"; // broker builds ShadowExecConfigV1 from it
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

export interface SignedEnvelope<Domain extends string, Payload> {
	signed: {
		domain: Domain;
		protocol_version: 1;
		key_id: string;
		occurred_at: Rfc3339;
		result_hash: ResultHash;
		payload: Payload;
	};
	signature: string;
}

export interface AuthoringAttestationPayloadV1 {
	scope: "authoring";
	tenant: OpaqueId;
	project: OpaqueId;
	repository_id: OpaqueId;
	session_id: OpaqueId;
	measured_execution: ShadowExecutionBinding;
	freshness_claim_echo: ShadowFreshnessBinding;
	changeset: ShadowChangeSetV1;
	request_nonce: OpaqueId;
	command_hash: Digest<"command">;
	command_display: string;
	verifier_kind: "tsc";
	ruleset_hash: Digest<"ruleset">;
	key_purpose: "shadow-authoring";
}

export type AuthoringAttestationV1 = SignedEnvelope<"interlinked-shadow-authoring", AuthoringAttestationPayloadV1>;

export type VerifiedAuthoringAttestation = AuthoringAttestationV1 & { readonly __verified: "authoring" };

export type ShadowKeyPurpose = "shadow-authoring" | "shadow-admission";

export type ShadowSigningDomain = "interlinked-shadow-authoring" | "interlinked-shadow-admission";

export const DOMAIN_PURPOSE = {
	"interlinked-shadow-authoring": "shadow-authoring",
	"interlinked-shadow-admission": "shadow-admission",
} as const satisfies Record<ShadowSigningDomain, ShadowKeyPurpose>;

export interface ShadowKeyRecordV1 {
	schema_version: 1;
	key_id: string;
	public_key_pem: string; // SPKI PEM, Ed25519
	purposes: NonEmpty<ShadowKeyPurpose>;
	not_before: Rfc3339;
	revoked_at: Rfc3339 | null;
}

export type MirrorState =
	| "active"
	| "disabled"
	| "quarantined"
	| "deletion_requested"
	| "provider_deleted"
	| "restore_window_open"
	| "restore_window_elapsed_provider_absent";

export type RestorationEligibility = "eligible" | "ineligible_fork_network" | "unknown";

export type DeletionReceipt =
	| { schema_version: 1; state: "deletion_requested"; provider_request_id: string; requested_at: Rfc3339 }
	| {
			schema_version: 1;
			state: "provider_deleted" | "restore_window_open";
			provider_request_id: string;
			requested_at: Rfc3339;
			provider_deleted_at: Rfc3339;
			restorable_until: Rfc3339 | null;
			restoration_eligibility: RestorationEligibility;
			reconciliation: "pending" | "confirmed" | "failed";
	  }
	| {
			schema_version: 1;
			state: "restore_window_elapsed_provider_absent";
			provider_request_id: string;
			requested_at: Rfc3339;
			provider_deleted_at: Rfc3339;
			restorable_until: Rfc3339 | null;
			restoration_eligibility: RestorationEligibility;
			reconciled_absent_at: Rfc3339;
	  };

export interface RetentionConsentV1 {
	schema_version: 1;
	repository_id: OpaqueId;
	auto_disable_after_days: number;
	auto_delete_after_further_days: number | null;
	consented_by: OpaqueId;
	consented_at: Rfc3339;
}
