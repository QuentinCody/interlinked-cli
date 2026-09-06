// interlinked-tdd: exempt — type-only module (no runtime surface); the
// declarations are exercised by __tests__/reference-parity.test.ts and by
// every parser/binding test that consumes them.
// ===========================================
// Shadow protocol v1 — claim / policy / measurement bindings
// ===========================================
// Three shapes, one per party (memo §8.0, "facts belong to the party that
// can know them"): the DAEMON asserts what it can honestly know before
// anything runs, BROKER POLICY expects, the MATERIALIZER measures. The
// provenance table in `provenance.ts` says, per leaf, who does which — and
// independent verification means the party that measures is never the party
// that asserted or expected.

import type {
	DependencyCacheRecordHash,
	DependencyRequestV1,
	Digest,
	EnvDigest,
	ExecConfigHash,
	GitSha,
	MirrorVersionRef,
	OverlayAlgo,
	OverlayBytesHash,
	OverlayManifestHash,
	PostImageAlgo,
	PostImageSetHash,
	PostTreeHash,
	PreTreeHash,
	ResolvedDependencyBindingV1,
	Rfc3339,
	ScannerPolicyDigest,
	ToolInputHash,
	TreeAlgo,
} from "./types-core.js";

/** What the DAEMON can honestly assert BEFORE anything runs remotely — no
 *  resolved dependency tree, no env digest, no exec-config hash. */
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

/** What BROKER POLICY expects. `deadline_at` is CLAMPED to broker policy. */
export interface ExpectedExecutionPolicyV1 {
	tree_algo: TreeAlgo;
	post_image_algo: PostImageAlgo;
	overlay_algo: OverlayAlgo;
	overlay_manifest_hash: OverlayManifestHash;
	env_digest: EnvDigest;
	exec_config_hash: ExecConfigHash;
	broker_scanner_policy_digest: ScannerPolicyDigest;
	dependency_cache_record_hash?: DependencyCacheRecordHash;
	deadline_at: Rfc3339;
}

/** What the MATERIALIZER measured. */
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

/** HEAD alone is insufficient — dirty and untracked files move without it —
 *  so freshness carries the CONTENT hashes the daemon recomputes from disk
 *  immediately before applying a verdict. Freshness only, never authority. */
export interface ShadowFreshnessBinding {
	base_local_head: GitSha;
	local_head: GitSha;
	input_hash: ToolInputHash;
	local_pre_tree_hash: PreTreeHash;
	local_overlay_manifest_hash: OverlayManifestHash;
	local_post_image_set_hash: PostImageSetHash;
}

/** Made by the daemon immediately before a verdict is APPLIED; never leaves
 *  the machine, never signed (memo I4). */
export interface LocalFreshnessCheckV1 {
	schema_version: 1;
	claimed: ShadowFreshnessBinding;
	measured_from_disk: ShadowFreshnessBinding;
	matches: boolean;
	checked_at: Rfc3339;
}

/** Published by the broker, MEASURED by the materializer; `env_digest` =
 *  H(canonical(ShadowEnvV1)). */
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

// ── limits — WIRE limits only; performance benchmarks live in plan
// acceptance, never here (memo §12.2).
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
	// Bytes alone do not bound the hook budget — a 2 MiB overlay of tiny
	// files is thousands of PUTs and immutable copies. Sync eligibility ALSO
	// caps OPERATIONS; above these the core lane declines.
	sync_eligible_entries: 200;
	sync_eligible_missing_blobs: 64;
	sync_eligible_pages: 1;
	sync_eligible_http_requests: 80;
}

// ── provenance vocabulary ──────────────────────────────────────────────────
export type Primitive = string | number | boolean | null | undefined;
export type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;
/** Dotted paths to every primitive leaf of T; unions distribute so every
 *  variant's fields appear (e.g. `dependencies.cache_record_hash`). */
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
/** A leaf whose contract depends on `dependencies.source`. */
export interface ConditionalContract {
	by_source: { fresh: FieldContract; cache: FieldContract };
}
export type LeafContract = FieldContract | ConditionalContract;
