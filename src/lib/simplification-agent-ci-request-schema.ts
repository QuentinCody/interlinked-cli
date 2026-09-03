// ===========================================
// Simplification Agent CI request — schema constants and shapes
// ===========================================
// Wire versions, bounded vocabularies, and the request's type surface. This
// module holds no behavior, so the parser, the canonical-hash helpers, and the
// entry module all depend on it without depending on each other.

import type { SimplificationDeepHandoffRequest, SimplificationRemedy } from "./simplification-types.js";

export const SIMPLIFICATION_AGENT_CI_REQUEST_VERSION = "simplification-request/v1" as const;
export const SIMPLIFICATION_LENS_VERSION = "simplification-lens/v1" as const;

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const MAX_LIST_ENTRIES = 4_096;
export const MAX_STRING_LENGTH = 4_096;
export const VALID_RISK_TIERS = ["lite", "full"] as const;
export const VALID_SCOPE_KINDS = ["repository", "diff", "paths"] as const;
export const VALIDATION_MODES = ["none", "candidate"] as const;

export type SimplificationAgentCiRiskTier = (typeof VALID_RISK_TIERS)[number];
export type SimplificationAgentCiScopeKind = (typeof VALID_SCOPE_KINDS)[number];
export type SimplificationAgentCiValidationMode = (typeof VALIDATION_MODES)[number];

export interface SimplificationAgentCiRepositoryRef {
	workspace_id: string;
	repository_id: string;
	commit_sha: string;
	tree_sha: string;
	inventory_sha256: string;
}

export interface SimplificationAgentCiScope {
	kind: SimplificationAgentCiScopeKind;
	base_sha: string | null;
	head_sha: string;
	paths: string[];
	includes: string[];
	excludes: string[];
}

export interface SimplificationAgentCiToolEvidence {
	name: string;
	version: string;
	output_sha256: string;
}

export interface SimplificationAgentCiEvidenceBinding {
	deterministic_digest_sha256: string;
	tools: SimplificationAgentCiToolEvidence[];
	policy_hashes: string[];
	adversarial_fixture_sha256: string;
	benchmark_fixture_sha256: string;
	runtime_capability_sha256: string;
	workspace_policy_sha256: string;
	prior_findings_sha256: string;
}

export interface SimplificationAgentCiModelBinding {
	provider: string;
	family: string;
	model: string;
	version: string;
}

export interface SimplificationAgentCiOrchestrationBinding {
	risk_tier: SimplificationAgentCiRiskTier;
	model: SimplificationAgentCiModelBinding;
	coordinator_prompt_sha256: string;
	partition_plan_version: string;
}

export interface SimplificationAgentCiValidationRequest {
	mode: SimplificationAgentCiValidationMode;
	check_plan_sha256: string | null;
	max_candidates: number;
}

export interface SimplificationAgentCiSubmissionMarker {
	state: "not_submitted";
	transport: "unimplemented";
	reason: string;
}

export interface SimplificationAgentCiRequestV1 {
	schema_version: typeof SIMPLIFICATION_AGENT_CI_REQUEST_VERSION;
	kind: "agent_ci.simplification_review";
	lens_version: typeof SIMPLIFICATION_LENS_VERSION;
	repository: SimplificationAgentCiRepositoryRef;
	scope: SimplificationAgentCiScope;
	requested_remedies: SimplificationRemedy[];
	evidence: SimplificationAgentCiEvidenceBinding;
	orchestration: SimplificationAgentCiOrchestrationBinding;
	validation: SimplificationAgentCiValidationRequest;
	record: boolean;
	no_cache: boolean;
	idempotency_key: string;
	submission: SimplificationAgentCiSubmissionMarker;
}

/** Public API — the caller-facing draft shape; consumed by the request
 *  builder in simplification-agent-ci-request.ts and by the plan-validation
 *  suites through the parent's re-export. */
export type SimplificationAgentCiRequestDraft = Omit<
	SimplificationAgentCiRequestV1,
	"schema_version" | "kind" | "lens_version" | "idempotency_key" | "submission"
> & {
	submission_reason: string;
};

declare const VALID_SIMPLIFICATION_REQUEST: unique symbol;
export type ValidSimplificationAgentCiRequest = Readonly<SimplificationAgentCiRequestV1> & {
	readonly [VALID_SIMPLIFICATION_REQUEST]: true;
};

/** Public API — the return shape of the parent's request parser. */
export type SimplificationAgentCiRequestParseResult =
	| { ok: true; request: ValidSimplificationAgentCiRequest }
	| { ok: false; reason: string };

/** Public API — the return shape of bindSimplificationAgentCiHandoff in
 *  simplification-agent-ci-request-canonical.ts. */
export type SimplificationAgentCiHandoffBindingResult =
	| {
		ok: true;
		handoff: SimplificationDeepHandoffRequest;
		handoff_sha256: string;
	  }
	| { ok: false; reason: string };

/** Public API — the per-section failure shape every parser in
 *  simplification-agent-ci-request-parse.ts returns. */
export interface ParseFailure {
	reason: string;
}
