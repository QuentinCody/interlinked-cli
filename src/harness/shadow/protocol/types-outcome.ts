// interlinked-tdd: exempt — type-only module (no runtime surface); the
// structural invariants are asserted at type level in
// __tests__/outcome-invariants.test.ts and exercised by the parsers.
// ===========================================
// Shadow protocol v1 — verifier results and outcomes
// ===========================================
// public API — the outcome union is the daemon's whole read surface.
// ONE completed shape per OPERATION (memo §8.0): a materialization-only
// probe is never forced to invent a process termination, and an attestation
// without a verifier result is unrepresentable.

import type {
	AuthoringAttestationV1,
} from "./types-attestation.js";
import type {
	ExecutionBindingLeaf,
	ExpectedExecutionPolicyV1,
	ShadowExecutionBinding,
	ShadowExecutionClaimV1,
	ShadowFreshnessBinding,
} from "./types-binding.js";
import type {
	CanonicalJson,
	CanonicalPath,
	Digest,
	OpaqueId,
	ResolvedDependencyBindingV1,
} from "./types-core.js";

// ── verifier results (memo §4.2) ───────────────────────────────────────────
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
/** A signal is never complete, and `diagnostics_total === diagnostics.length`
 *  is enforced by the parser — a truncated list is `output_truncated`. */
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

/** `introduced` (multiset post − pre) exists EXACTLY when both runs are
 *  complete — which is why the complete and incomplete results are separate
 *  types rather than one type with optional fields.
 *
 *  IDENTITY CONTRACT (functional review 2026-09-05, finding 7; D33). The
 *  subtraction is over diagnostic IDENTITY, never over the display position:
 *  a literal multiset difference of `{file, line, column, code, message}`
 *  records would report every pre-existing error as introduced whenever a
 *  line above it moved (the reviewer's probe: prepending `// header` moved an
 *  unchanged TS2322 from line 1 to line 2). `DiagnosticV1.line`/`column` are
 *  PRESENTATION — canonical sort order for the list — and are not part of
 *  identity. Identity is `(file after path mapping across moves, code,
 *  normalized message, the diagnostic's source-line TEXT, ordinal among
 *  equal such tuples)`, so duplicate same-message errors keep their counts
 *  and a relocated line keeps its diagnostic. A correspondence that cannot
 *  be decided (the anchoring line text itself changed, or a move left more
 *  than one candidate) is NOT silently dropped and NOT silently cancelled
 *  against an unrelated equal message: Plan 03's delta matcher reports it as
 *  `unresolved` beside `introduced` (a field this frozen shape does not yet
 *  carry — adding it is a recorded protocol change, D33), and policy decides
 *  what an unresolved correspondence means for the gate. Until that matcher
 *  and its parity corpus (comment insertion, line deletion, file moves,
 *  duplicate same-message errors, real introduced errors) exist, this shape
 *  does NOT by itself prove introduced-only enforcement. */
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

// ── phases and closed reasons ──────────────────────────────────────────────
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

export interface WorkspaceDiff {
	added: readonly CanonicalPath[];
	modified: readonly CanonicalPath[];
	deleted: readonly CanonicalPath[];
	bytes_changed: number;
}

/** Which held value the measurement disagreed with. */
export type MismatchComparison =
	| "claim_vs_measurement"
	| "policy_vs_measurement"
	| "authority_vs_measurement"
	| "cache_vs_measurement";
/** Values travel as canonical JSON so any field type (numbers included) is
 *  representable; `unavailable_reason` is REQUIRED whenever the measured
 *  value is absent — no empty-string sentinel is ever a valid brand. */
export type BindingFieldMismatchV1 =
	| { field: ExecutionBindingLeaf; comparison: MismatchComparison; expected: CanonicalJson; measured: CanonicalJson }
	| {
			field: ExecutionBindingLeaf;
			comparison: MismatchComparison;
			expected: CanonicalJson;
			measured?: never;
			unavailable_reason: "not_reached" | "not_provisioned" | "not_applicable";
	  };
/** Non-empty by TYPE, not by constructor promise. */
export type NonEmpty<T> = readonly [T, ...T[]];

export interface OutcomeBase {
	schema_version: 1;
	status: "completed";
	request_id: OpaqueId;
	bundle_id: OpaqueId;
	execution_claim: ShadowExecutionClaimV1;
	expected_execution: ExpectedExecutionPolicyV1;
	measured_execution: ShadowExecutionBinding;
	freshness_claim: ShadowFreshnessBinding; // ECHOED, never attested
	duration_ms: number;
}
/** Plan 02: binding measurements only; no target process ran. */
export type MaterializedOutcomeV1 = OutcomeBase & { kind: "materialized" };
/** Plan 03: the verifier result owns its own process terminations. */
export type VerifiedOutcomeV1 = OutcomeBase & { kind: "verified"; verifier: CompleteShadowTscResultV1 };
export type AttestedOutcomeV1 = OutcomeBase & {
	kind: "attested";
	verifier: CompleteShadowTscResultV1;
	attestation: AuthoringAttestationV1;
};
/** DEFERRED — Workstream 06 (destructive rehearsal): a top-level process with
 *  effects. Seam reservation only; its memo owns the contract. */
export type RehearsedOutcomeV1 = OutcomeBase & {
	kind: "rehearsed";
	termination: ProcessTermination;
	workspace_diff: WorkspaceDiff;
	stdout_head: string;
	stderr_head: string;
	divergence_risk: "low" | "medium" | "high";
};
export type CompletedShadowOutcome =
	| MaterializedOutcomeV1
	| VerifiedOutcomeV1
	| AttestedOutcomeV1
	| RehearsedOutcomeV1;

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
