// ===========================================
// Simplification Agent CI — portable request artifact
// ===========================================
// This module defines an inspectable, content-addressed request artifact. It
// deliberately does not submit work: the remote Agent CI transport does not
// exist in this package yet, and the parser refuses any claim that it did.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "./json-types.js";
import { parseSimplificationHandoff } from "./simplification-schema.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationDeepHandoffRequest,
	type SimplificationRemedy,
} from "./simplification-types.js";
import { isPinnedExactVersion } from "./simplification-version.js";

const SIMPLIFICATION_AGENT_CI_REQUEST_VERSION = "simplification-request/v1" as const;
const SIMPLIFICATION_LENS_VERSION = "simplification-lens/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_LIST_ENTRIES = 4_096;
const MAX_STRING_LENGTH = 4_096;
const VALID_RISK_TIERS = ["lite", "full"] as const;
const VALID_SCOPE_KINDS = ["repository", "diff", "paths"] as const;
const VALIDATION_MODES = ["none", "candidate"] as const;

export type SimplificationAgentCiRiskTier = (typeof VALID_RISK_TIERS)[number];
type SimplificationAgentCiScopeKind = (typeof VALID_SCOPE_KINDS)[number];
type SimplificationAgentCiValidationMode = (typeof VALIDATION_MODES)[number];

interface SimplificationAgentCiRepositoryRef {
	workspace_id: string;
	repository_id: string;
	commit_sha: string;
	tree_sha: string;
	inventory_sha256: string;
}

interface SimplificationAgentCiScope {
	kind: SimplificationAgentCiScopeKind;
	base_sha: string | null;
	head_sha: string;
	paths: string[];
	includes: string[];
	excludes: string[];
}

interface SimplificationAgentCiToolEvidence {
	name: string;
	version: string;
	output_sha256: string;
}

interface SimplificationAgentCiEvidenceBinding {
	deterministic_digest_sha256: string;
	tools: SimplificationAgentCiToolEvidence[];
	policy_hashes: string[];
	adversarial_fixture_sha256: string;
	benchmark_fixture_sha256: string;
	runtime_capability_sha256: string;
	workspace_policy_sha256: string;
	prior_findings_sha256: string;
}

interface SimplificationAgentCiModelBinding {
	provider: string;
	family: string;
	model: string;
	version: string;
}

interface SimplificationAgentCiOrchestrationBinding {
	risk_tier: SimplificationAgentCiRiskTier;
	model: SimplificationAgentCiModelBinding;
	coordinator_prompt_sha256: string;
	partition_plan_version: string;
}

interface SimplificationAgentCiValidationRequest {
	mode: SimplificationAgentCiValidationMode;
	check_plan_sha256: string | null;
	max_candidates: number;
}

interface SimplificationAgentCiSubmissionMarker {
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

export type SimplificationAgentCiRequestParseResult =
	| { ok: true; request: ValidSimplificationAgentCiRequest }
	| { ok: false; reason: string };

export type SimplificationAgentCiHandoffBindingResult =
	| {
		ok: true;
		handoff: SimplificationDeepHandoffRequest;
		handoff_sha256: string;
	  }
	| { ok: false; reason: string };

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown, location: string): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${location} contains a non-finite number`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry, index) => canonicalJsonValue(entry, `${location}[${index}]`)).join(",")}]`;
	}
	if (!isJsonObject(value)) throw new TypeError(`${location} is not JSON-compatible`);
	const keys = Object.keys(value).sort();
	const members = keys.map((key) => {
		const member = value[key];
		if (member === undefined) throw new TypeError(`${location}.${key} is undefined`);
		return `${JSON.stringify(key)}:${canonicalJsonValue(member, `${location}.${key}`)}`;
	});
	return `{${members.join(",")}}`;
}

/** Stable JSON used only for content identities; object keys sort recursively. */
export function canonicalSimplificationAgentCiJson(value: unknown): string {
	return canonicalJsonValue(value, "request");
}

/**
 * Validate and content-address the local CLI's existing deep-handoff shape.
 * This is an adapter only: the shared schema insists the artifact remains
 * explicitly `not_submitted`.
 */
export function bindSimplificationAgentCiHandoff(
	input: unknown,
): SimplificationAgentCiHandoffBindingResult {
	const handoff = parseSimplificationHandoff(input);
	if (!handoff) return { ok: false, reason: "invalid local simplification deep handoff" };
	return {
		ok: true,
		handoff,
		handoff_sha256: sha256(canonicalSimplificationAgentCiJson(handoff)),
	};
}

function unknownKeys(value: JsonObject, allowed: readonly string[], location: string): string | null {
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

function checkedSha256(value: unknown, location: string): string | { reason: string } {
	return typeof value === "string" && SHA256_PATTERN.test(value)
		? value
		: { reason: `${location} must be a lowercase sha256 hex digest` };
}

function checkedGitObject(value: unknown, location: string): string | { reason: string } {
	return typeof value === "string" && GIT_OBJECT_PATTERN.test(value)
		? value
		: { reason: `${location} must be a full lowercase Git object id` };
}

interface ParseFailure {
	reason: string;
}

function isParseFailure(value: unknown): value is ParseFailure {
	return isJsonObject(value) && Object.keys(value).length === 1 &&
		typeof value.reason === "string";
}

function reasonFrom(value: unknown): string | null {
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
	const canonical = options.order
		? [...result].sort((left, right) => options.order!.indexOf(left) - options.order!.indexOf(right))
		: [...result].sort();
	for (const [index, entry] of result.entries()) {
		if (entry !== canonical[index]) return { reason: `${location} must use canonical ordering` };
	}
	return result;
}

function parseRepository(value: unknown): SimplificationAgentCiRepositoryRef | { reason: string } {
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

function parseScope(value: unknown): SimplificationAgentCiScope | { reason: string } {
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
	if (
		(kind === "diff" && base_sha === null) ||
		(kind !== "diff" && base_sha !== null)
	) return { reason: "request.scope.base_sha is required only for diff scope" };
	if (kind === "repository" && Array.isArray(paths) && paths.length !== 0) {
		return { reason: "request.scope.paths must be empty for repository scope" };
	}
	if (kind === "paths" && Array.isArray(paths) && paths.length === 0) {
		return { reason: "request.scope.paths must not be empty for paths scope" };
	}
	if (
		typeof head_sha !== "string" || !Array.isArray(paths) ||
		!Array.isArray(includes) || !Array.isArray(excludes)
	) return { reason: "request.scope is invalid" };
	return { kind, base_sha, head_sha, paths, includes, excludes };
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

function parseEvidence(value: unknown): SimplificationAgentCiEvidenceBinding | { reason: string } {
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

function parseOrchestration(value: unknown): SimplificationAgentCiOrchestrationBinding | { reason: string } {
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

function parseValidation(value: unknown): SimplificationAgentCiValidationRequest | { reason: string } {
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
	if (!Number.isInteger(value.max_candidates) || typeof value.max_candidates !== "number" || value.max_candidates < 0 || value.max_candidates > 100) {
		return { reason: "request.validation.max_candidates must be an integer from 0 through 100" };
	}
	if (value.mode === "none" && (check_plan_sha256 !== null || value.max_candidates !== 0)) {
		return { reason: "request.validation none mode must omit a check plan and use zero candidates" };
	}
	if (value.mode === "candidate" && (typeof check_plan_sha256 !== "string" || value.max_candidates === 0)) {
		return { reason: "request.validation candidate mode requires a check plan and at least one candidate" };
	}
	return {
		mode: value.mode as SimplificationAgentCiValidationMode,
		check_plan_sha256,
		max_candidates: value.max_candidates,
	};
}

function parseRemedies(value: unknown): SimplificationRemedy[] | { reason: string } {
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

function parseSubmission(value: unknown): SimplificationAgentCiSubmissionMarker | { reason: string } {
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

function requestHashMaterial(request: SimplificationAgentCiRequestV1): JsonObject {
	return {
		schema_version: request.schema_version,
		kind: request.kind,
		lens_version: request.lens_version,
		repository: request.repository,
		scope: request.scope,
		requested_remedies: request.requested_remedies,
		evidence: request.evidence,
		orchestration: request.orchestration,
		validation: request.validation,
		record: request.record,
		no_cache: request.no_cache,
		submission: request.submission,
	};
}

/** Hash of the exact portable submission intent, excluding its self-derived key. */
export function canonicalSimplificationAgentCiRequestHash(
	request: SimplificationAgentCiRequestV1,
): string {
	return sha256(canonicalSimplificationAgentCiJson(requestHashMaterial(request)));
}

/**
 * Result cache identity. Operational switches (`record`, `no_cache`) and the
 * not-submitted marker cannot alter findings, so they are deliberately absent.
 */
export function canonicalSimplificationAgentCiCacheKey(
	request: ValidSimplificationAgentCiRequest,
): string {
	const material: JsonObject = {
		schema_version: request.schema_version,
		lens_version: request.lens_version,
		repository: request.repository,
		scope: request.scope,
		requested_remedies: request.requested_remedies,
		evidence: request.evidence,
		orchestration: request.orchestration,
		validation: request.validation,
	};
	return sha256(canonicalSimplificationAgentCiJson(material));
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const member of Object.values(value)) deepFreeze(member);
	}
	return value;
}

/** Strict constructing parser; unknown keys and non-canonical ordering fail. */
export function parseSimplificationAgentCiRequest(
	input: unknown,
): SimplificationAgentCiRequestParseResult {
	if (!isJsonObject(input)) return { ok: false, reason: "request must be an object" };
	const extra = unknownKeys(
		input,
		[
			"schema_version",
			"kind",
			"lens_version",
			"repository",
			"scope",
			"requested_remedies",
			"evidence",
			"orchestration",
			"validation",
			"record",
			"no_cache",
			"idempotency_key",
			"submission",
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
	if (
		!("workspace_id" in repository) || !("kind" in scope) || !Array.isArray(requested_remedies) ||
		!("tools" in evidence) || !("risk_tier" in orchestration) || !("mode" in validation) ||
		!("state" in submission) || typeof idempotency_key !== "string"
	) return { ok: false, reason: "request contains an invalid nested object" };
	if (repository.commit_sha !== scope.head_sha) {
		return { ok: false, reason: "request scope head_sha must equal the pinned repository commit_sha" };
	}
	const request: SimplificationAgentCiRequestV1 = {
		schema_version: SIMPLIFICATION_AGENT_CI_REQUEST_VERSION,
		kind: "agent_ci.simplification_review",
		lens_version: SIMPLIFICATION_LENS_VERSION,
		repository,
		scope,
		requested_remedies,
		evidence,
		orchestration,
		validation,
		record: input.record,
		no_cache: input.no_cache,
		idempotency_key,
		submission,
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
