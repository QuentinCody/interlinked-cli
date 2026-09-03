// ===========================================
// Simplification Agent CI — declarative P5 validation plan
// ===========================================
// A plan, not an executor. It declares how one simplification candidate would
// be validated in isolation before any human approves adoption.

import { isJsonObject } from "./json-types.js";
import {
	boundaryOrder,
	compareCodeUnits,
	isBoundary,
	isSha256,
	type SimplificationProtectedBoundary,
} from "./simplification-agent-ci-plan-primitives.js";
import type { SimplificationPlanParseResult } from "./simplification-agent-ci-plan-primitives.js";
import {
	canonicalSimplificationAgentCiCacheKey,
	canonicalSimplificationAgentCiJson,
	type ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request.js";

const SIMPLIFICATION_P5_PLAN_VERSION = "simplification-validation-plan/v1" as const;

export interface SimplificationValidationCandidate {
	fingerprint: string;
	overlap_group: string | null;
	protected_boundaries: SimplificationProtectedBoundary[];
	human_contract_narrowing_sha256: string | null;
	independent_validator_sha256: string | null;
}

interface SimplificationValidationCandidatePlan
	extends SimplificationValidationCandidate {
	eligibility: "eligible" | "human_narrowing_required";
	reason_codes: string[];
}

interface SimplificationAgentCiP5Plan {
	schema_version: typeof SIMPLIFICATION_P5_PLAN_VERSION;
	phase: "P5";
	execution: "declarative_only";
	activation: "explicit_request_only";
	request_cache_key: string;
	candidates: SimplificationValidationCandidatePlan[];
	isolation: {
		immutable_source_artifact: true;
		one_candidate_or_compatible_overlap_group_per_sandbox: true;
		credentials: "workflow_identity_only";
		outbound_network_during_checks: "sealed";
	};
	steps: Array<{
		step_id: string;
		depends_on: string[];
		operation: string;
	}>;
	required_checks: string[];
	receipt: {
		baseline_required: true;
		matching_baseline_failure_is_success: false;
		exact_patch_and_dependency_delta_required: true;
		unrunnable_required_check: "inconclusive";
	};
	adoption: {
		auto_apply: false;
		auto_push: false;
		human_approval_required: true;
	};
}

function normalizeCandidate(candidate: SimplificationValidationCandidate): SimplificationValidationCandidatePlan {
	const protected_boundaries = [...new Set(candidate.protected_boundaries)]
		.sort((left, right) => boundaryOrder(left) - boundaryOrder(right));
	const suppliedNarrowing = candidate.human_contract_narrowing_sha256 !== null;
	const suppliedValidator = candidate.independent_validator_sha256 !== null;
	const protectedEligible = protected_boundaries.length === 0 || (suppliedNarrowing && suppliedValidator);
	const reason_codes: string[] = [];
	if (protected_boundaries.length > 0 && !suppliedNarrowing) reason_codes.push("protected_contract_not_narrowed_by_human");
	if (protected_boundaries.length > 0 && !suppliedValidator) reason_codes.push("independent_validator_missing");
	return {
		...candidate,
		protected_boundaries,
		eligibility: protectedEligible ? "eligible" : "human_narrowing_required",
		reason_codes,
	};
}

const P5_STEPS: SimplificationAgentCiP5Plan["steps"] = [
	{ step_id: "bind-source", depends_on: [], operation: "verify immutable reviewed tree and artifact digest" },
	{ step_id: "fork-artifact", depends_on: ["bind-source"], operation: "fork the source artifact without mutating the user branch" },
	{ step_id: "create-sandbox", depends_on: ["fork-artifact"], operation: "create an isolated credential-minimal sandbox" },
	{ step_id: "baseline", depends_on: ["create-sandbox"], operation: "run the declared baseline check plan" },
	{ step_id: "patch", depends_on: ["baseline"], operation: "patch one candidate or proven-compatible overlap group" },
	{ step_id: "seal-egress", depends_on: ["patch"], operation: "seal outbound network before repository checks" },
	{ step_id: "validate", depends_on: ["seal-egress"], operation: "run every required independent check" },
	{ step_id: "exact-delta", depends_on: ["validate"], operation: "measure patch, manifest, lockfile, artifact, and dependency deltas" },
	{ step_id: "persist-receipt", depends_on: ["exact-delta"], operation: "store bounded outputs and a content-addressed validation receipt" },
	{ step_id: "human-approval", depends_on: ["persist-receipt"], operation: "request approval without applying or pushing the patch" },
];

function buildP5PlanFromKey(
	requestCacheKey: string,
	candidates: SimplificationValidationCandidate[],
): SimplificationAgentCiP5Plan {
	const normalized = candidates
		.map(normalizeCandidate)
		.sort((left, right) => compareCodeUnits(left.fingerprint, right.fingerprint));
	return {
		schema_version: SIMPLIFICATION_P5_PLAN_VERSION,
		phase: "P5",
		execution: "declarative_only",
		activation: "explicit_request_only",
		request_cache_key: requestCacheKey,
		candidates: normalized,
		isolation: {
			immutable_source_artifact: true,
			one_candidate_or_compatible_overlap_group_per_sandbox: true,
			credentials: "workflow_identity_only",
			outbound_network_during_checks: "sealed",
		},
		steps: P5_STEPS.map((step) => ({ ...step, depends_on: [...step.depends_on] })),
		required_checks: [
			"typecheck_or_compile",
			"build",
			"focused_tests",
			"full_tests",
			"security",
			"public_api_compatibility",
			"mutation_or_differential_when_configured",
		],
		receipt: {
			baseline_required: true,
			matching_baseline_failure_is_success: false,
			exact_patch_and_dependency_delta_required: true,
			unrunnable_required_check: "inconclusive",
		},
		adoption: {
			auto_apply: false,
			auto_push: false,
			human_approval_required: true,
		},
	};
}

/** Construct an explicit P5 validation plan. It does not create a Sandbox. */
export function buildSimplificationAgentCiP5Plan(
	request: ValidSimplificationAgentCiRequest,
	candidates: SimplificationValidationCandidate[],
): SimplificationAgentCiP5Plan {
	if (request.validation.mode !== "candidate") {
		throw new TypeError("P5 validation requires request.validation.mode=candidate");
	}
	if (!isSha256(request.validation.check_plan_sha256)) {
		throw new TypeError("P5 validation requires a pinned request.validation.check_plan_sha256");
	}
	if (candidates.length > request.validation.max_candidates) {
		throw new RangeError("P5 candidate count exceeds the request maximum");
	}
	return buildP5PlanFromKey(canonicalSimplificationAgentCiCacheKey(request), candidates);
}

function nullableSha256(value: unknown): value is string | null {
	return value === null || isSha256(value);
}

function parseValidationCandidate(value: unknown): SimplificationValidationCandidate | null {
	if (!isJsonObject(value)) return null;
	const keys = [
		"eligibility",
		"fingerprint",
		"human_contract_narrowing_sha256",
		"independent_validator_sha256",
		"overlap_group",
		"protected_boundaries",
		"reason_codes",
	].sort();
	if (Object.keys(value).sort().join("|") !== keys.join("|")) return null;
	if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) return null;
	if (value.overlap_group !== null && typeof value.overlap_group !== "string") return null;
	if (!nullableSha256(value.human_contract_narrowing_sha256)) return null;
	if (!nullableSha256(value.independent_validator_sha256)) return null;
	if (!Array.isArray(value.protected_boundaries) || !value.protected_boundaries.every(isBoundary)) return null;
	return {
		fingerprint: value.fingerprint,
		overlap_group: value.overlap_group,
		protected_boundaries: [...value.protected_boundaries],
		human_contract_narrowing_sha256: value.human_contract_narrowing_sha256,
		independent_validator_sha256: value.independent_validator_sha256,
	};
}

export function parseSimplificationAgentCiP5Plan(
	input: unknown,
	request: ValidSimplificationAgentCiRequest,
): SimplificationPlanParseResult<SimplificationAgentCiP5Plan> {
	if (!isJsonObject(input) || !isSha256(input.request_cache_key)) {
		return { ok: false, reason: "P5 plan must carry a sha256 request_cache_key" };
	}
	if (!Array.isArray(input.candidates)) return { ok: false, reason: "P5 plan candidates must be an array" };
	const candidates: SimplificationValidationCandidate[] = [];
	for (const entry of input.candidates) {
		const candidate = parseValidationCandidate(entry);
		if (!candidate) return { ok: false, reason: "P5 plan has an invalid candidate" };
		candidates.push(candidate);
	}
	let rebuilt: SimplificationAgentCiP5Plan;
	try {
		rebuilt = buildSimplificationAgentCiP5Plan(request, candidates);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "P5 plan is not authorized by the request",
		};
	}
	if (canonicalSimplificationAgentCiJson(input) !== canonicalSimplificationAgentCiJson(rebuilt)) {
		return { ok: false, reason: "P5 plan differs from the canonical validation topology" };
	}
	return { ok: true, plan: rebuilt };
}
