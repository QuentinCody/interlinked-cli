// ===========================================
// Simplification Agent CI — portable request artifact
// ===========================================
// This module defines an inspectable, content-addressed request artifact. It
// deliberately does not submit work: the remote Agent CI transport does not
// exist in this package yet, and the parser refuses any claim that it did.

import { isJsonObject } from "./json-types.js";
import {
	canonicalSimplificationAgentCiRequestHash,
	compareCodeUnits,
	deepFreeze,
} from "./simplification-agent-ci-request-canonical.js";
import {
	checkedSha256,
	parseEvidence,
	parseOrchestration,
	parseRemedies,
	parseRepository,
	parseScope,
	parseSubmission,
	parseValidation,
	reasonFrom,
	unknownKeys,
} from "./simplification-agent-ci-request-parse.js";
import {
	SIMPLIFICATION_AGENT_CI_REQUEST_VERSION,
	SIMPLIFICATION_LENS_VERSION,
	type ParseFailure,
	type SimplificationAgentCiRequestDraft,
	type SimplificationAgentCiRequestParseResult,
	type SimplificationAgentCiRequestV1,
	type ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request-schema.js";
import { SIMPLIFICATION_REMEDIES } from "./simplification-types.js";

// Public API: the request module stays the single entry point for consumers of
// the artifact — its identities, its type surface, and the handoff adapter.
export {
	canonicalSimplificationAgentCiCacheKey,
	canonicalSimplificationAgentCiJson,
} from "./simplification-agent-ci-request-canonical.js";
// Public API: the artifact's type surface, re-exported from the same entry.
export type {
	SimplificationAgentCiRiskTier,
	ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request-schema.js";

type NestedRequestParts = Pick<SimplificationAgentCiRequestV1, "repository" | "scope" | "requested_remedies" | "evidence" | "orchestration" | "validation" | "submission">;

/** Narrow the parsed members together; null means one member kept a failure shape. */
function narrowNestedParts(parts: { [K in keyof NestedRequestParts]: NestedRequestParts[K] | ParseFailure }): NestedRequestParts | null {
	const { repository, scope, requested_remedies, evidence, orchestration, validation, submission } = parts;
	if (!("workspace_id" in repository) || !("kind" in scope) || !Array.isArray(requested_remedies)) return null;
	if (!("tools" in evidence) || !("risk_tier" in orchestration) || !("mode" in validation) || !("state" in submission)) return null;
	return { repository, scope, requested_remedies, evidence, orchestration, validation, submission };
}

/** Strict constructing parser; unknown keys and non-canonical ordering fail. */
export function parseSimplificationAgentCiRequest(
	input: unknown,
): SimplificationAgentCiRequestParseResult {
	if (!isJsonObject(input)) return { ok: false, reason: "request must be an object" };
	const extra = unknownKeys(
		input,
		[
			"schema_version", "kind", "lens_version", "repository", "scope", "requested_remedies", "evidence",
			"orchestration", "validation", "record", "no_cache", "idempotency_key", "submission",
		],
		"request",
	);
	if (extra) return { ok: false, reason: extra };
	if (input.schema_version !== SIMPLIFICATION_AGENT_CI_REQUEST_VERSION) {
		return { ok: false, reason: `request.schema_version must be ${SIMPLIFICATION_AGENT_CI_REQUEST_VERSION}` };
	}
	if (input.kind !== "agent_ci.simplification_review" || input.lens_version !== SIMPLIFICATION_LENS_VERSION) {
		return { ok: false, reason: "request kind or simplification lens version is unsupported" };
	}
	const repository = parseRepository(input.repository);
	const scope = parseScope(input.scope);
	const requested_remedies = parseRemedies(input.requested_remedies);
	const evidence = parseEvidence(input.evidence);
	const orchestration = parseOrchestration(input.orchestration);
	const validation = parseValidation(input.validation);
	const submission = parseSubmission(input.submission);
	for (const parsed of [repository, scope, requested_remedies, evidence, orchestration, validation, submission]) {
		const bad = reasonFrom(parsed);
		if (bad) return { ok: false, reason: bad };
	}
	if (typeof input.record !== "boolean" || typeof input.no_cache !== "boolean") {
		return { ok: false, reason: "request.record and request.no_cache must be booleans" };
	}
	const idempotency_key = checkedSha256(input.idempotency_key, "request.idempotency_key");
	const keyBad = reasonFrom(idempotency_key);
	if (keyBad) return { ok: false, reason: keyBad };
	const nested = narrowNestedParts({ repository, scope, requested_remedies, evidence, orchestration, validation, submission });
	if (!nested || typeof idempotency_key !== "string") return { ok: false, reason: "request contains an invalid nested object" };
	if (nested.repository.commit_sha !== nested.scope.head_sha) {
		return { ok: false, reason: "request scope head_sha must equal the pinned repository commit_sha" };
	}
	const request: SimplificationAgentCiRequestV1 = {
		schema_version: SIMPLIFICATION_AGENT_CI_REQUEST_VERSION,
		kind: "agent_ci.simplification_review",
		lens_version: SIMPLIFICATION_LENS_VERSION,
		repository: nested.repository,
		scope: nested.scope,
		requested_remedies: nested.requested_remedies,
		evidence: nested.evidence,
		orchestration: nested.orchestration,
		validation: nested.validation,
		record: input.record,
		no_cache: input.no_cache,
		idempotency_key,
		submission: nested.submission,
	};
	const expectedKey = canonicalSimplificationAgentCiRequestHash(request);
	if (request.idempotency_key !== expectedKey) {
		return { ok: false, reason: "request.idempotency_key does not match the canonical request hash" };
	}
	deepFreeze(request);
	// SAFETY: this constructing parser checked every field, exact object shape,
	// canonical ordering, and the self-derived idempotency key before branding.
	return { ok: true, request: request as ValidSimplificationAgentCiRequest };
}

function normalizeDraft(draft: SimplificationAgentCiRequestDraft): SimplificationAgentCiRequestV1 {
	const order = new Map(SIMPLIFICATION_REMEDIES.map((remedy, index) => [remedy, index]));
	const requested_remedies = [...new Set(draft.requested_remedies)].sort(
		(left, right) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER),
	);
	const request: SimplificationAgentCiRequestV1 = {
		schema_version: SIMPLIFICATION_AGENT_CI_REQUEST_VERSION,
		kind: "agent_ci.simplification_review",
		lens_version: SIMPLIFICATION_LENS_VERSION,
		repository: { ...draft.repository },
		scope: {
			...draft.scope,
			paths: [...new Set(draft.scope.paths)].sort(),
			includes: [...new Set(draft.scope.includes)].sort(),
			excludes: [...new Set(draft.scope.excludes)].sort(),
		},
		requested_remedies,
		evidence: {
			...draft.evidence,
			tools: [...draft.evidence.tools]
				.map((tool) => ({ ...tool }))
				.sort((left, right) => compareCodeUnits(left.name, right.name)),
			policy_hashes: [...new Set(draft.evidence.policy_hashes)].sort(),
		},
		orchestration: {
			...draft.orchestration,
			model: { ...draft.orchestration.model },
		},
		validation: { ...draft.validation },
		record: draft.record,
		no_cache: draft.no_cache,
		idempotency_key: "0".repeat(64),
		submission: {
			state: "not_submitted",
			transport: "unimplemented",
			reason: draft.submission_reason,
		},
	};
	request.idempotency_key = canonicalSimplificationAgentCiRequestHash(request);
	return request;
}

/** Build and validate a canonical local artifact. It performs no I/O. */
export function buildSimplificationAgentCiRequest(
	draft: SimplificationAgentCiRequestDraft,
): ValidSimplificationAgentCiRequest {
	const parsed = parseSimplificationAgentCiRequest(normalizeDraft(draft));
	if (!parsed.ok) throw new TypeError(`invalid simplification Agent CI request: ${parsed.reason}`);
	return parsed.request;
}
