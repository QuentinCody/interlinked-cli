// interlinked-tdd: exempt — barrel module (re-exports only, no logic); every
// symbol it forwards is tested in its own module's companion test, and the
// package's exit gates run in __tests__/.
// ===========================================
// Shadow protocol v1 — the package entry point
// ===========================================
// SOURCE OF TRUTH for the CLIENT half of the shadow wire and persisted
// shapes — every shape the CLI itself sends or reads (memo
// `docs/design/remote-shadow-execution.md` §8.0). The BROKER-internal half
// (idempotency, mirror publication/upload, admission) is the OTHER
// authoritative half and lives in the private `interlinked-cloud` repo at
// `src/shadow/`, which imports this package from a vendored, digest-pinned
// copy — see `protocol/shadow-v1/README.md` for the full moved-symbol table.
// Consumers of the client contract import from HERE; the design-time
// reference schema under `docs/design/` is regenerated from these
// declarations and pinned against them by `__tests__/reference-parity.test.ts`.
//
// What Plan 00 contains, and deliberately does not: pure functions over
// values the caller supplies. No network, no credential, no sandbox, no
// route, no hook wiring — those are Plans 01–06, none of which has started.
// The single boundary to the outside world is the injected `runGit` adapter
// in `overlay-enumerate.ts`.

// types — the wire and persisted shapes
export type * from "./types-attestation.js";
export type * from "./types-binding.js";
export type * from "./types-core.js";
export type * from "./types-lifecycle.js";
export type * from "./types-outcome.js";
export type * from "./types-transport.js";
export {
	DEPENDENCY_TREE_ALGO,
	EXECUTION_PROFILE_ID,
	OVERLAY_ALGO,
	POST_IMAGE_ALGO,
	TREE_ALGO,
} from "./types-core.js";

// canonical hashing (I5), the four record byte grammars (§5.1), and the two
// envelope grammars (missing set, manifest bytes)
export { canonicalDigest, canonicalValue, hexOfBytes, sha256Hex, sha256Raw } from "./canonical.js";
export { computeDependencyTreeHash, computePostTreeHash, computePreTreeHash } from "./tree-hash.js";
export type { ShadowHashFailure, ShadowHashResult, TreeEntryInput } from "./tree-hash.js";
export { computeOverlayBytesHash, computePostImageSetHash } from "./tagged-set.js";
export type { TaggedEntryInput } from "./tagged-set.js";
export { manifestDigestOf } from "./manifest-digest.js";
export { computeMissingSetDigestV1, MISSING_SET_DOMAIN_V1 } from "./missing-set.js";
export type { MissingSetDigest, MissingSetDigestResult } from "./missing-set.js";

// content identity, projection, application
export { computeChangeSet, sameContentIdentity } from "./changeset.js";
export { normalizeToolInput, toolInputHash } from "./tool-input.js";
export { projectPostImages } from "./post-image-projector.js";
export type { PreImageMapV1, ProjectedPostImageV1, ProjectionResultV1 } from "./post-image-projector.js";
export { applyPostImages, blobDigestOf, byteLengthOf } from "./post-image-apply.js";
export type { ShadowTreeFileV1, ShadowTreeV1 } from "./post-image-apply.js";

// overlay: the manifest grammar and the tree-diff enumeration
export {
	canonicalizeOverlayManifest,
	DEFAULT_OVERLAY_INCLUDE_RULES,
	isDeniedOverlayPath,
	matchesGitWildmatchV1,
	selectOverlayPaths,
	SHADOW_OVERLAY_DENY_V1,
} from "./overlay-manifest.js";
// The compile-once form: matching is O(pattern × path) with no backtracking,
// and a manifest is compiled once per selection rather than per candidate.
export { compileGitWildmatchV1, matchCompiledGitWildmatchV1 } from "./overlay-glob.js";
export type { CompiledGitWildmatchV1 } from "./overlay-glob.js";
export { collectLocalTreeInputs, enumerateOverlay, MAX_IGNORED_CANDIDATES, overlayScanRoots, parseNulSeparated, validateOverlayEntries } from "./overlay-enumerate.js";
export type { BaseTreeEntryV1, EnumerateOverlayInput, GitBytesRunner, LocalPathSetsV1, LocalTreeEntryV1 } from "./overlay-enumerate.js";

// policy tables, limits, and the comparison the verdict depends on
export { SHADOW_LIMITS_V1, syncEligibility } from "./limits.js";
export { BINDING_PROVENANCE, bindingLeaves, contractsFor, flattenContract, freshnessLeaves, provenanceLeaves } from "./provenance.js";
export { isReasonLegalInPhase, REASON_PHASES, REMOTE_PHASES, SHADOW_PHASES, SHADOW_UNAVAILABLE_REASONS } from "./reason-phases.js";
export { asNonEmptyMismatches, checkLocalFreshness, compareBindings, dependencyCacheRecordHash, FRESHNESS_FIELDS } from "./binding-compare.js";
export type { BindingComparisonInputV1, BrokerAuthorityViewV1, MeasuredExecutionViewV1 } from "./binding-compare.js";
export { DOMAIN_PURPOSE, keyMaySign, purposeForDomain } from "./signing-domains.js";
// ADMISSION — the cross-record layer above the binding comparison — moved to
// `interlinked-cloud` in the 2026-09-04 public/private split: it takes the
// broker-internal input bundle and the broker's authority view, so it runs on
// the broker, not in the CLI. `compareBindings` (above) is the half a client
// still runs, and it stays here.
// The record registry: every public record id → its parser and descriptor. It
// is what `scripts/gen-shadow-schema.mts` generates the cross-repository JSON
// Schema from, product → artifact.
export { descriptorFor, SHADOW_RECORD_REGISTRY } from "./registry.js";

// strict parsers — the ONE gate from untrusted wire value to typed record
export type { ShadowParseOutcome } from "./parse-core-entries.js";
export {
	parseManifestEntry,
	parseOverlayEntry,
	parseOverlayManifest,
	parsePostImageEntry,
} from "./parse-core-entries.js";
export {
	parseDependencyRequest,
	parseExecutionManifest,
	parseExpectedExecutionPolicy,
	parseNormalizedToolInput,
	parseResolvedDependencyBinding,
	parseShadowChangeSet,
	parseShadowExecutionBinding,
	parseShadowExecutionClaim,
	parseShadowFreshnessBinding,
} from "./parse-core.js";
export { parseAuthoringAttestation, parseCompleteTscResult, parseShadowOutcome } from "./parse-outcome.js";
export * from "./parse-transport.js";
// Records that reach the daemon from STORAGE (D1 / R2 / a Durable Object) or
// from agent-writable local state get the same strict decoding as the wire:
// "internal" says where the bytes came from, not how far they can be trusted.
export {
	parseDeletionReceipt,
	parseLocalFreshnessCheck,
	parseMirrorStatus,
	parseRetentionConsent,
	parseScannerPolicy,
	parseShadowEnv,
	parseShadowExecConfig,
} from "./parse-records.js";
export { parseDependencyTreeCacheRecord, parseMirrorBinding } from "./parse-records-store.js";
