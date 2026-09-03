// ===========================================
// Simplification Agent CI request — member parsers
// ===========================================
// One strict parser per member of the request artifact. Each returns either the
// narrowed member or a `{ reason }` failure, so the entry module keeps a single
// readable control flow over the whole object.

import { isJsonObject, type JsonObject } from "./json-types.js";
import { checkedCandidateCount, narrowScopeFields, scopeConsistencyReason, validationModeReason } from "./simplification-agent-ci-request-shape.js";
import {
	GIT_OBJECT_PATTERN,
	MAX_LIST_ENTRIES,
	MAX_STRING_LENGTH,
	SHA256_PATTERN,
	VALID_RISK_TIERS,
	VALID_SCOPE_KINDS,
	VALIDATION_MODES,
	type ParseFailure,
	type SimplificationAgentCiEvidenceBinding,
	type SimplificationAgentCiModelBinding,
	type SimplificationAgentCiOrchestrationBinding,
	type SimplificationAgentCiRepositoryRef,
	type SimplificationAgentCiRiskTier,
	type SimplificationAgentCiScope,
	type SimplificationAgentCiScopeKind,
	type SimplificationAgentCiSubmissionMarker,
	type SimplificationAgentCiToolEvidence,
	type SimplificationAgentCiValidationMode,
	type SimplificationAgentCiValidationRequest,
} from "./simplification-agent-ci-request-schema.js";
import { SIMPLIFICATION_REMEDIES, type SimplificationRemedy } from "./simplification-types.js";
import { isPinnedExactVersion } from "./simplification-version.js";

export function unknownKeys(value: JsonObject, allowed: readonly string[], location: string): string | null {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
	return unknown.length === 0 ? null : `${location} has unknown field(s): ${unknown.join(", ")}`;
}

function requiredString(value: unknown, location: string): string | { reason: string } {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) {
		return { reason: `${location} must be a non-empty string of at most ${MAX_STRING_LENGTH} characters` };
	}
	return value;
}

export function checkedSha256(value: unknown, location: string): string | { reason: string } {
	return typeof value === "string" && SHA256_PATTERN.test(value)
		? value
		: { reason: `${location} must be a lowercase sha256 hex digest` };
}

function checkedGitObject(value: unknown, location: string): string | { reason: string } {
	return typeof value === "string" && GIT_OBJECT_PATTERN.test(value)
		? value
		: { reason: `${location} must be a full lowercase Git object id` };
}

function isParseFailure(value: unknown): value is ParseFailure {
	return isJsonObject(value) && Object.keys(value).length === 1 &&
		typeof value.reason === "string";
}

export function reasonFrom(value: unknown): string | null {
	return isParseFailure(value) ? value.reason : null;
}

function isRepoRelativePath(value: string): boolean {
	if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

interface StringListOptions {
	require_paths?: boolean;
	order?: readonly string[];
}

function parseCanonicalStringList(
	value: unknown,
	location: string,
	options: StringListOptions = {},
): string[] | { reason: string } {
	if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
		return { reason: `${location} must be an array with at most ${MAX_LIST_ENTRIES} entries` };
	}
	const result: string[] = [];
	for (const [index, entry] of value.entries()) {
		const parsed = requiredString(entry, `${location}[${index}]`);
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
		if (typeof parsed !== "string") return { reason: `${location}[${index}] is invalid` };
		if (options.require_paths === true && !isRepoRelativePath(parsed)) {
			return { reason: `${location}[${index}] must be a normalized repository-relative path` };
		}
		result.push(parsed);
	}
	if (new Set(result).size !== result.length) return { reason: `${location} must not contain duplicates` };
	const order = options.order;
	const canonical = order ? [...result].sort((left, right) => order.indexOf(left) - order.indexOf(right)) : [...result].sort();
	for (const [index, entry] of result.entries()) {
		if (entry !== canonical[index]) return { reason: `${location} must use canonical ordering` };
	}
	return result;
}

export function parseRepository(value: unknown): SimplificationAgentCiRepositoryRef | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.repository must be an object" };
	const extra = unknownKeys(
		value,
		["workspace_id", "repository_id", "commit_sha", "tree_sha", "inventory_sha256"],
		"request.repository",
	);
	if (extra) return { reason: extra };
	const workspace_id = requiredString(value.workspace_id, "request.repository.workspace_id");
	const repository_id = requiredString(value.repository_id, "request.repository.repository_id");
	const commit_sha = checkedGitObject(value.commit_sha, "request.repository.commit_sha");
	const tree_sha = checkedGitObject(value.tree_sha, "request.repository.tree_sha");
	const inventory_sha256 = checkedSha256(
		value.inventory_sha256,
		"request.repository.inventory_sha256",
	);
	for (const parsed of [workspace_id, repository_id, commit_sha, tree_sha, inventory_sha256]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	if (
		typeof workspace_id !== "string" || typeof repository_id !== "string" ||
		typeof commit_sha !== "string" || typeof tree_sha !== "string" ||
		typeof inventory_sha256 !== "string"
	) return { reason: "request.repository is invalid" };
	return { workspace_id, repository_id, commit_sha, tree_sha, inventory_sha256 };
}

function parseNullableGitObject(value: unknown, location: string): string | null | { reason: string } {
	return value === null ? null : checkedGitObject(value, location);
}

export function parseScope(value: unknown): SimplificationAgentCiScope | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.scope must be an object" };
	const extra = unknownKeys(
		value,
		["kind", "base_sha", "head_sha", "paths", "includes", "excludes"],
		"request.scope",
	);
	if (extra) return { reason: extra };
	if (typeof value.kind !== "string" || !VALID_SCOPE_KINDS.includes(value.kind as SimplificationAgentCiScopeKind)) {
		return { reason: `request.scope.kind must be one of ${VALID_SCOPE_KINDS.join("|")}` };
	}
	const kind = value.kind as SimplificationAgentCiScopeKind;
	const base_sha = parseNullableGitObject(value.base_sha, "request.scope.base_sha");
	const head_sha = checkedGitObject(value.head_sha, "request.scope.head_sha");
	const paths = parseCanonicalStringList(value.paths, "request.scope.paths", { require_paths: true });
	const includes = parseCanonicalStringList(value.includes, "request.scope.includes");
	const excludes = parseCanonicalStringList(value.excludes, "request.scope.excludes");
	if (isParseFailure(base_sha)) return base_sha;
	for (const parsed of [head_sha, paths, includes, excludes]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	const inconsistent = scopeConsistencyReason(kind, base_sha, paths);
	if (inconsistent) return { reason: inconsistent };
	const fields = narrowScopeFields(head_sha, paths, includes, excludes);
	if (!fields) return { reason: "request.scope is invalid" };
	return { kind, base_sha, ...fields };
}

function parseToolEvidence(value: unknown, index: number): SimplificationAgentCiToolEvidence | { reason: string } {
	const location = `request.evidence.tools[${index}]`;
	if (!isJsonObject(value)) return { reason: `${location} must be an object` };
	const extra = unknownKeys(value, ["name", "version", "output_sha256"], location);
	if (extra) return { reason: extra };
	const name = requiredString(value.name, `${location}.name`);
	const version = requiredString(value.version, `${location}.version`);
	const output_sha256 = checkedSha256(value.output_sha256, `${location}.output_sha256`);
	for (const parsed of [name, version, output_sha256]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	if (typeof name !== "string" || typeof version !== "string" || typeof output_sha256 !== "string") {
		return { reason: `${location} is invalid` };
	}
	return { name, version, output_sha256 };
}

function parseTools(value: unknown): SimplificationAgentCiToolEvidence[] | { reason: string } {
	if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
		return { reason: `request.evidence.tools must have at most ${MAX_LIST_ENTRIES} entries` };
	}
	const tools: SimplificationAgentCiToolEvidence[] = [];
	for (const [index, entry] of value.entries()) {
		const tool = parseToolEvidence(entry, index);
		const bad = reasonFrom(tool);
		if (bad) return { reason: bad };
		if ("name" in tool) tools.push(tool);
	}
	const names = tools.map((tool) => tool.name);
	if (new Set(names).size !== names.length) return { reason: "request.evidence.tools names must be unique" };
	if (names.some((name, index) => index > 0 && name < (names[index - 1] ?? ""))) {
		return { reason: "request.evidence.tools must be sorted by name" };
	}
	return tools;
}

export function parseEvidence(value: unknown): SimplificationAgentCiEvidenceBinding | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.evidence must be an object" };
	const extra = unknownKeys(
		value,
		[
			"deterministic_digest_sha256",
			"tools",
			"policy_hashes",
			"adversarial_fixture_sha256",
			"benchmark_fixture_sha256",
			"runtime_capability_sha256",
			"workspace_policy_sha256",
			"prior_findings_sha256",
		],
		"request.evidence",
	);
	if (extra) return { reason: extra };
	const deterministic_digest_sha256 = checkedSha256(
		value.deterministic_digest_sha256,
		"request.evidence.deterministic_digest_sha256",
	);
	const tools = parseTools(value.tools);
	const policy_hashes = parseCanonicalStringList(value.policy_hashes, "request.evidence.policy_hashes");
	const adversarial_fixture_sha256 = checkedSha256(
		value.adversarial_fixture_sha256,
		"request.evidence.adversarial_fixture_sha256",
	);
	const benchmark_fixture_sha256 = checkedSha256(
		value.benchmark_fixture_sha256,
		"request.evidence.benchmark_fixture_sha256",
	);
	const runtime_capability_sha256 = checkedSha256(
		value.runtime_capability_sha256,
		"request.evidence.runtime_capability_sha256",
	);
	const workspace_policy_sha256 = checkedSha256(
		value.workspace_policy_sha256,
		"request.evidence.workspace_policy_sha256",
	);
	const prior_findings_sha256 = checkedSha256(
		value.prior_findings_sha256,
		"request.evidence.prior_findings_sha256",
	);
	for (const parsed of [
		deterministic_digest_sha256,
		tools,
		policy_hashes,
		adversarial_fixture_sha256,
		benchmark_fixture_sha256,
		runtime_capability_sha256,
		workspace_policy_sha256,
		prior_findings_sha256,
	]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	if (
		typeof deterministic_digest_sha256 !== "string" || !Array.isArray(tools) ||
		!Array.isArray(policy_hashes) || typeof runtime_capability_sha256 !== "string" ||
		typeof adversarial_fixture_sha256 !== "string" ||
		typeof benchmark_fixture_sha256 !== "string" ||
		typeof workspace_policy_sha256 !== "string" || typeof prior_findings_sha256 !== "string"
	) return { reason: "request.evidence is invalid" };
	return {
		deterministic_digest_sha256,
		tools,
		policy_hashes,
		adversarial_fixture_sha256,
		benchmark_fixture_sha256,
		runtime_capability_sha256,
		workspace_policy_sha256,
		prior_findings_sha256,
	};
}

function parseModel(value: unknown): SimplificationAgentCiModelBinding | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.orchestration.model must be an object" };
	const extra = unknownKeys(value, ["provider", "family", "model", "version"], "request.orchestration.model");
	if (extra) return { reason: extra };
	const provider = requiredString(value.provider, "request.orchestration.model.provider");
	const family = requiredString(value.family, "request.orchestration.model.family");
	const model = requiredString(value.model, "request.orchestration.model.model");
	const version = requiredString(value.version, "request.orchestration.model.version");
	for (const parsed of [provider, family, model, version]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	if ([provider, family, model, version].some((entry) => typeof entry !== "string")) {
		return { reason: "request.orchestration.model is invalid" };
	}
	if (typeof version === "string" && !isPinnedExactVersion(version)) {
		return { reason: "request.orchestration.model.version must be an exact pinned revision" };
	}
	return {
		provider: provider as string,
		family: family as string,
		model: model as string,
		version: version as string,
	};
}

export function parseOrchestration(value: unknown): SimplificationAgentCiOrchestrationBinding | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.orchestration must be an object" };
	const extra = unknownKeys(
		value,
		["risk_tier", "model", "coordinator_prompt_sha256", "partition_plan_version"],
		"request.orchestration",
	);
	if (extra) return { reason: extra };
	if (typeof value.risk_tier !== "string" || !VALID_RISK_TIERS.includes(value.risk_tier as SimplificationAgentCiRiskTier)) {
		return { reason: `request.orchestration.risk_tier must be one of ${VALID_RISK_TIERS.join("|")}` };
	}
	const model = parseModel(value.model);
	const coordinator_prompt_sha256 = checkedSha256(
		value.coordinator_prompt_sha256,
		"request.orchestration.coordinator_prompt_sha256",
	);
	const partition_plan_version = requiredString(
		value.partition_plan_version,
		"request.orchestration.partition_plan_version",
	);
	for (const parsed of [model, coordinator_prompt_sha256, partition_plan_version]) {
		const bad = reasonFrom(parsed);
		if (bad) return { reason: bad };
	}
	if (!("model" in value) || !("provider" in model)) return { reason: "request.orchestration.model is invalid" };
	if (typeof coordinator_prompt_sha256 !== "string" || typeof partition_plan_version !== "string") {
		return { reason: "request.orchestration is invalid" };
	}
	return {
		risk_tier: value.risk_tier as SimplificationAgentCiRiskTier,
		model,
		coordinator_prompt_sha256,
		partition_plan_version,
	};
}

export function parseValidation(value: unknown): SimplificationAgentCiValidationRequest | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.validation must be an object" };
	const extra = unknownKeys(value, ["mode", "check_plan_sha256", "max_candidates"], "request.validation");
	if (extra) return { reason: extra };
	if (typeof value.mode !== "string" || !VALIDATION_MODES.includes(value.mode as SimplificationAgentCiValidationMode)) {
		return { reason: `request.validation.mode must be one of ${VALIDATION_MODES.join("|")}` };
	}
	const check_plan_sha256 = value.check_plan_sha256 === null
		? null
		: checkedSha256(value.check_plan_sha256, "request.validation.check_plan_sha256");
	if (isParseFailure(check_plan_sha256)) return check_plan_sha256;
	const max_candidates = checkedCandidateCount(value.max_candidates);
	if (typeof max_candidates !== "number") return max_candidates;
	const invalidMode = validationModeReason(value.mode, check_plan_sha256, max_candidates);
	if (invalidMode) return { reason: invalidMode };
	return {
		mode: value.mode as SimplificationAgentCiValidationMode,
		check_plan_sha256,
		max_candidates,
	};
}

export function parseRemedies(value: unknown): SimplificationRemedy[] | { reason: string } {
	const parsed = parseCanonicalStringList(value, "request.requested_remedies", {
		order: SIMPLIFICATION_REMEDIES,
	});
	const bad = reasonFrom(parsed);
	if (bad) return { reason: bad };
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return { reason: "request.requested_remedies must contain at least one remedy" };
	}
	for (const remedy of parsed) {
		if (!SIMPLIFICATION_REMEDIES.some((known) => known === remedy)) {
			return { reason: `request.requested_remedies contains unknown remedy ${remedy}` };
		}
	}
	return parsed as SimplificationRemedy[];
}

export function parseSubmission(value: unknown): SimplificationAgentCiSubmissionMarker | { reason: string } {
	if (!isJsonObject(value)) return { reason: "request.submission must be an object" };
	const extra = unknownKeys(value, ["state", "transport", "reason"], "request.submission");
	if (extra) return { reason: extra };
	if (value.state !== "not_submitted" || value.transport !== "unimplemented") {
		return { reason: "request.submission may only describe an unimplemented, not-submitted transport" };
	}
	const reason = requiredString(value.reason, "request.submission.reason");
	const bad = reasonFrom(reason);
	if (bad) return { reason: bad };
	if (typeof reason !== "string") return { reason: "request.submission.reason is invalid" };
	return { state: "not_submitted", transport: "unimplemented", reason };
}
