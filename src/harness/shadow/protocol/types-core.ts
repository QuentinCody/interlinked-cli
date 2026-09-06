// ===========================================
// Shadow protocol v1 — core wire types (brands, identity, content)
// ===========================================
// SOURCE OF TRUTH for every shadow wire and persisted shape (memo §8.0,
// first bullet). The design-time companion
// `docs/design/remote-shadow-execution.schema.ts` is the REFERENCE that
// mirrors these declarations; `__tests__/reference-parity.test.ts` pins the
// two together, so a change here that the reference does not carry fails
// the build rather than drifting in silence.
//
// Every persisted shape carries a literal version discriminator; no wire
// shape contains `unknown`. Brands are nominal by PURPOSE so a digest of
// one kind cannot be assigned where another is expected. Only the strict
// parsers in `parse-*.ts` mint branded values from untrusted input.

/** A digest branded by the purpose it was computed for. */
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
/** A canonical-JSON-encoded value, for mismatch reporting of any field type. */
export type CanonicalJson = string & { readonly __brand: "canonical-json" };

export type TreeAlgo = "shadow-tree-v1";
export type PostImageAlgo = "shadow-postimages-v1";
export type OverlayAlgo = "shadow-overlay-v1";
export type DependencyTreeAlgo = "shadow-dependency-tree-v1";
/** Accepted git modes. `120000` (symlink) and `160000` (submodule) are
 *  rejected everywhere in v0 — memo §12.3. */
export type GitMode = "100644" | "100755";

export const TREE_ALGO: TreeAlgo = "shadow-tree-v1";
export const POST_IMAGE_ALGO: PostImageAlgo = "shadow-postimages-v1";
export const OVERLAY_ALGO: OverlayAlgo = "shadow-overlay-v1";
export const DEPENDENCY_TREE_ALGO: DependencyTreeAlgo = "shadow-dependency-tree-v1";

// ── mirror identity — one version counter PER KEY ──────────────────────────
export interface MirrorKeyV1 {
	repository_id: OpaqueId; // broker authority (Plan 01A), never caller-chosen
	session_id: OpaqueId;
	kind: "synthetic_full_tree";
}
export interface MirrorVersionRef {
	key: MirrorKeyV1;
	version: number;
}

// ── entries, manifests, overlay rules (memo §5.1) ──────────────────────────
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

/** Include rules have a declared grammar (`overlay-manifest.ts` defines
 *  sorting, duplicate rejection, slash behavior, dotfiles, and case
 *  sensitivity for `gitwildmatch-v1`); deny rules are BROKER-OWNED by id —
 *  their text never comes from the daemon. */
export type OverlayIncludeRuleV1 =
	| { kind: "exact"; path: CanonicalPath }
	| { kind: "gitwildmatch-v1"; pattern: string };
export interface OverlayManifestV1 {
	schema_version: 1;
	include_rules: readonly OverlayIncludeRuleV1[];
	deny_ruleset_id: "shadow-overlay-deny-v1";
}

/** The staged execution manifest (an R2 object, like the mirror manifest). */
export interface ExecutionManifestV1 {
	schema_version: 1;
	mirror: MirrorVersionRef;
	/** The COMPLETE overlay manifest travels, so the broker validates and
	 *  canonicalizes the caller's include rules before the resulting hash
	 *  counts as broker-expected. */
	overlay_manifest: OverlayManifestV1;
	overlay: readonly OverlayEntryV1[];
	post_images: readonly PostImageEntryV1[];
}

/** Content identity from exact post-images (equality table: `changeset.ts`). */
export interface ShadowChangeSetV1 {
	schema_version: 1;
	pre_tree_hash: PreTreeHash;
	post_image_set_hash: PostImageSetHash;
	touched_paths: readonly CanonicalPath[];
}

// ── NORMALIZED tool input ──────────────────────────────────────────────────
// The daemon normalizes runner-specific payloads (the Codex `command` /
// `patch` / `_raw_patch` / `content` precedence in `apply-patch-content.ts`)
// into this closed union; the RAW hook payload is scanned before
// normalization, and `input_hash` is over the normalized form.
export type ToolInputSchema = "shadow-tool-input-v1";
export type ApplyPatchSourceField = "command" | "patch" | "_raw_patch" | "content";
export interface MultiEditEntryV1 {
	old_string: string;
	new_string: string;
	replace_all: boolean;
}
export type NormalizedToolInputV1 =
	| { schema: ToolInputSchema; client: "claude-code"; tool: "Write"; semantics_version: 1; file_path: CanonicalPath; content: string }
	| { schema: ToolInputSchema; client: "claude-code"; tool: "Edit"; semantics_version: 1; file_path: CanonicalPath; old_string: string; new_string: string; replace_all: boolean }
	| { schema: ToolInputSchema; client: "claude-code"; tool: "MultiEdit"; semantics_version: 1; file_path: CanonicalPath; edits: readonly MultiEditEntryV1[] }
	| { schema: ToolInputSchema; client: "codex"; tool: "apply_patch"; semantics_version: 1; patch: string; raw_source_field: ApplyPatchSourceField };

/** The only execution profile v0 admits. The client names the PROFILE; the
 *  broker builds the config from it (memo §8.0, "policy is never
 *  daemon-controlled"). */
export type ExecutionProfileId = "shadow-typecheck-v1";
export const EXECUTION_PROFILE_ID: ExecutionProfileId = "shadow-typecheck-v1";

/** Broker-CONSTRUCTED from an execution profile; never client-supplied. */
export interface ShadowExecConfigV1 {
	schema_version: 1;
	profile_id: ExecutionProfileId;
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

// ── dependencies ───────────────────────────────────────────────────────────
/** The REQUEST side can never carry a tree hash — nobody holds one before
 *  the install runs (memo §8.0, "facts belong to the party that can know
 *  them"). */
export type DependencyRequestV1 =
	| { mode: "none" }
	| { mode: "npm-v1"; input_hash: DependencyInputHash };
export type ResolvedDependencyBindingV1 =
	| { mode: "none" }
	| { mode: "npm-v1"; source: "fresh"; input_hash: DependencyInputHash; tree_algo: DependencyTreeAlgo; tree_hash: DependencyTreeHash }
	| { mode: "npm-v1"; source: "cache"; input_hash: DependencyInputHash; tree_algo: DependencyTreeAlgo; tree_hash: DependencyTreeHash; cache_record_hash: DependencyCacheRecordHash };

// ── the dependency-tree cache record ───────────────────────────────────────
// Its two siblings — `BaseSnapshotBackupRecordV1` and
// `ProvisionedWorkspaceBackupRecordV1` — moved to `interlinked-cloud` in the
// 2026-09-04 public/private split: a backup handle is broker-internal state.
// This record stays because its hash travels on the wire and `compareBindings`
// takes the record, so the CLI re-runs the comparison the broker published.
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
