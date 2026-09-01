// ===========================================
// Simplification Agent CI — declarative P4/P5 plans
// ===========================================
// These are plans, not executors. They make role isolation, protected
// boundaries, and independent validation inspectable before a future remote
// implementation is authorized.

import { createHash } from "node:crypto";
import { isJsonObject } from "./json-types.js";
import { matchesAnyGlob } from "./path-glob.js";
import {
	canonicalSimplificationAgentCiCacheKey,
	canonicalSimplificationAgentCiJson,
	type SimplificationAgentCiRiskTier,
	type ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationRemedy,
} from "./simplification-types.js";

const SIMPLIFICATION_P4_PLAN_VERSION = "simplification-orchestration-plan/v2" as const;
const SIMPLIFICATION_P5_PLAN_VERSION = "simplification-validation-plan/v1" as const;

export const SIMPLIFICATION_PROTECTED_BOUNDARIES = [
	"authorization",
	"trust-boundary-validation",
	"secret-handling",
	"data-loss-prevention",
	"migrations-and-rollback",
	"accessibility",
	"compatibility",
	"auditability",
	"sole-nontrivial-test",
] as const;

export type SimplificationProtectedBoundary =
	(typeof SIMPLIFICATION_PROTECTED_BOUNDARIES)[number];

export interface SimplificationAgentCiPartition {
	partition_id: string;
	files: string[];
	remedies: SimplificationRemedy[];
	protected_boundaries: SimplificationProtectedBoundary[];
}

/**
 * Path projection of the content-addressed repository inventory used by the
 * partition planner. The full inventory artifact may carry blob, byte-size,
 * language, and public-surface metadata; this binding supplies the path sets
 * needed to prove that P4 assignments are complete and in scope.
 */
export interface SimplificationAgentCiP4InventoryBinding {
	inventory_sha256: string;
	inventory_files: string[];
	scoped_files: string[];
}

export interface SimplificationAgentCiP4PartitionCoverage {
	request_inventory_sha256: string;
	inventory_path_set_sha256: string;
	scoped_path_set_sha256: string;
	assigned_path_set_sha256: string;
	partition_assignment_sha256: string;
	inventory_files: number;
	scoped_files: number;
	assigned_files: number;
	complete: true;
}

interface SimplificationSpecialistPlan {
	agent_id: string;
	role: "simplification_specialist";
	partition_id: string;
	reads: "declared_partition_and_shared_context";
	sees_other_specialists: false;
	remedies: SimplificationRemedy[];
	output: "schema_valid_findings_or_explicit_no_findings_with_read_set";
}

export interface SimplificationAgentCiP4Plan {
	schema_version: typeof SIMPLIFICATION_P4_PLAN_VERSION;
	phase: "P4";
	execution: "declarative_only";
	request_cache_key: string;
	risk_tier: SimplificationAgentCiRiskTier;
	context: {
		repository_text_trust: "untrusted";
		delivery: "shared_content_addressed_artifact";
		boundary_tags_stripped: true;
		allowlisted_tools_only: true;
	};
	partitions: SimplificationAgentCiPartition[];
	partition_coverage: SimplificationAgentCiP4PartitionCoverage;
	roles: {
		coordinator: {
			role: "coordinator";
			model_tier: "top";
			responsibilities: string[];
		};
		specialists: SimplificationSpecialistPlan[];
		capability_specialist: {
			role: "cross_partition_capability_specialist";
			remedies: ["stdlib", "native"];
			requires_version_pins: true;
			output: "evidence_only";
		};
		synthesizer: {
			role: "synthesizer";
			may_invent_evidence: false;
			must_assign_overlap_groups_before_totals: true;
			must_rerun_after_any_input_change: true;
		};
		skeptic: {
			role: "independent_skeptic";
			fanout: "one_per_eligible_finding";
			sees_original_rationale: false;
			default_disposition: "unconfirmed";
		};
		completeness_auditor: {
			role: "completeness_auditor";
			reads: "inventory_assignments_read_telemetry_and_failures";
			reads_finding_rationale: false;
			mints_final_coverage_receipt: true;
		};
	};
	rereview: {
		prior_findings_required: true;
		unfixed_must_reemit: true;
		user_acked_stays_closed_unless_materially_worse: true;
		skipped_partition_means_unknown_not_fixed: true;
	};
}

export interface SimplificationValidationCandidate {
	fingerprint: string;
	overlap_group: string | null;
	protected_boundaries: SimplificationProtectedBoundary[];
	human_contract_narrowing_sha256: string | null;
	independent_validator_sha256: string | null;
}

export interface SimplificationValidationCandidatePlan
	extends SimplificationValidationCandidate {
	eligibility: "eligible" | "human_narrowing_required";
	reason_codes: string[];
}

export interface SimplificationAgentCiP5Plan {
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

export type SimplificationPlanParseResult<T> =
	| { ok: true; plan: T }
	| { ok: false; reason: string };

const PROMPT_BOUNDARY_TAGS = [
	"repository_input",
	"repository_instructions",
	"changed_files",
	"deterministic_evidence",
	"prior_findings",
	"specialist_output",
	"contract_evidence",
] as const;

const BOUNDARY_TAG_PATTERN = new RegExp(
	`</?(?:${PROMPT_BOUNDARY_TAGS.join("|")})[^>]*>`,
	"gi",
);
const MAX_P4_PARTITION_ID_LENGTH = 256;
const P4_PARTITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Strip coordinator-owned boundary tags from untrusted repository text. */
export function sanitizeSimplificationPromptInput(value: string): string {
	return value.replace(BOUNDARY_TAG_PATTERN, "");
}

function remedyOrder(remedy: SimplificationRemedy): number {
	return SIMPLIFICATION_REMEDIES.indexOf(remedy);
}

function boundaryOrder(boundary: SimplificationProtectedBoundary): number {
	return SIMPLIFICATION_PROTECTED_BOUNDARIES.indexOf(boundary);
}

function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(canonicalSimplificationAgentCiJson(value), "utf8")
		.digest("hex");
}

function requireUniqueRepositoryPaths(values: unknown, location: string): string[] {
	if (!Array.isArray(values)) throw new TypeError(`${location} must be an array`);
	if (values.length > 100_000) {
		throw new TypeError(`${location} must contain at most 100000 paths`);
	}
	if (!values.every(isRepoPath)) {
		throw new TypeError(`${location} must contain normalized repository-relative paths`);
	}
	if (new Set(values).size !== values.length) {
		throw new TypeError(`${location} must not contain duplicates`);
	}
	return [...values].sort(compareCodeUnits);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathIsSelectedByRequest(
	request: ValidSimplificationAgentCiRequest,
	path: string,
): boolean {
	const included = request.scope.includes.length === 0 ||
		matchesAnyGlob(path, request.scope.includes);
	return included && !matchesAnyGlob(path, request.scope.excludes);
}

function normalizeP4InventoryBinding(
	request: ValidSimplificationAgentCiRequest,
	binding: SimplificationAgentCiP4InventoryBinding,
): SimplificationAgentCiP4InventoryBinding {
	if (!isSha256(binding.inventory_sha256) ||
		binding.inventory_sha256 !== request.repository.inventory_sha256) {
		throw new TypeError("P4 inventory binding must match request.repository.inventory_sha256");
	}
	const inventory_files = requireUniqueRepositoryPaths(
		binding.inventory_files,
		"P4 inventory binding inventory_files",
	);
	const scoped_files = requireUniqueRepositoryPaths(
		binding.scoped_files,
		"P4 inventory binding scoped_files",
	);
	const inventorySet = new Set(inventory_files);
	const outsideInventory = scoped_files.find((file) => !inventorySet.has(file));
	if (outsideInventory) {
		throw new TypeError(`P4 scoped file is absent from the bound inventory: ${outsideInventory}`);
	}
	const policySelected = inventory_files.filter((path) => pathIsSelectedByRequest(request, path));
	const requestedPaths = request.scope.kind === "repository"
		? policySelected
		: [...request.scope.paths].sort(compareCodeUnits);
	if (!sameStrings(scoped_files, requestedPaths)) {
		throw new TypeError(
			request.scope.kind === "repository"
				? "P4 scoped_files must exactly match the inventory after request include/exclude policy"
				: "P4 scoped_files must exactly match request.scope.paths",
		);
	}
	const outsidePolicy = scoped_files.find((path) => !pathIsSelectedByRequest(request, path));
	if (outsidePolicy) {
		throw new TypeError(`P4 scoped file is excluded by request include/exclude policy: ${outsidePolicy}`);
	}
	return {
		inventory_sha256: binding.inventory_sha256,
		inventory_files,
		scoped_files,
	};
}

function normalizePartition(partition: SimplificationAgentCiPartition): SimplificationAgentCiPartition {
	return {
		partition_id: partition.partition_id,
		files: [...new Set(partition.files)].sort(),
		remedies: [...new Set(partition.remedies)].sort((left, right) => remedyOrder(left) - remedyOrder(right)),
		protected_boundaries: [...new Set(partition.protected_boundaries)]
			.sort((left, right) => boundaryOrder(left) - boundaryOrder(right)),
	};
}

interface P4PartitionValidationContext {
	inventory: Set<string>;
	scoped: Set<string>;
	requested_remedies: Set<SimplificationRemedy>;
	file_owners: Map<string, string>;
}

function requireP4PartitionId(
	partition: SimplificationAgentCiPartition,
	partitionIds: Set<string>,
): void {
	if (typeof partition.partition_id !== "string" ||
		partition.partition_id.length > MAX_P4_PARTITION_ID_LENGTH ||
		!P4_PARTITION_ID_PATTERN.test(partition.partition_id)) {
		throw new TypeError("P4 partition_id must be a non-empty stable identifier");
	}
	if (partitionIds.has(partition.partition_id)) {
		throw new TypeError(`P4 partition_id must be unique: ${partition.partition_id}`);
	}
	partitionIds.add(partition.partition_id);
}

function assignP4PartitionFiles(
	partition: SimplificationAgentCiPartition,
	context: P4PartitionValidationContext,
): void {
	if (!Array.isArray(partition.files) || partition.files.length === 0) {
		throw new TypeError(`P4 partition ${partition.partition_id} must assign at least one file`);
	}
	if (new Set(partition.files).size !== partition.files.length) {
		throw new TypeError(`P4 partition ${partition.partition_id} files must not contain duplicates`);
	}
	for (const file of partition.files) {
		if (!isRepoPath(file)) {
			throw new TypeError(`P4 partition ${partition.partition_id} contains an invalid file path`);
		}
		if (!context.inventory.has(file)) {
			throw new TypeError(`P4 partition file is absent from the bound inventory: ${file}`);
		}
		if (!context.scoped.has(file)) {
			throw new TypeError(`P4 partition file is outside the resolved request scope: ${file}`);
		}
		const priorOwner = context.file_owners.get(file);
		if (priorOwner) {
			throw new TypeError(
				`P4 partition file ${file} is assigned to both ${priorOwner} and ${partition.partition_id}`,
			);
		}
		context.file_owners.set(file, partition.partition_id);
	}
}

function requireP4PartitionRemedies(
	partition: SimplificationAgentCiPartition,
	requestedRemedies: ReadonlySet<SimplificationRemedy>,
): void {
	if (!Array.isArray(partition.remedies) || partition.remedies.length === 0) {
		throw new TypeError(`P4 partition ${partition.partition_id} must assign at least one remedy`);
	}
	if (new Set(partition.remedies).size !== partition.remedies.length) {
		throw new TypeError(`P4 partition ${partition.partition_id} remedies must not contain duplicates`);
	}
	for (const remedy of partition.remedies) {
		if (!isRemedy(remedy) || !requestedRemedies.has(remedy)) {
			throw new TypeError(
				`P4 partition ${partition.partition_id} contains an unrequested remedy: ${String(remedy)}`,
			);
		}
	}
}

function requireP4PartitionBoundaries(partition: SimplificationAgentCiPartition): void {
	if (!Array.isArray(partition.protected_boundaries) ||
		!partition.protected_boundaries.every(isBoundary) ||
		new Set(partition.protected_boundaries).size !== partition.protected_boundaries.length) {
		throw new TypeError(
			`P4 partition ${partition.partition_id} protected_boundaries must be unique known values`,
		);
	}
}

function normalizeP4Partitions(
	request: ValidSimplificationAgentCiRequest,
	partitions: SimplificationAgentCiPartition[],
	binding: SimplificationAgentCiP4InventoryBinding,
): SimplificationAgentCiPartition[] {
	if (!Array.isArray(partitions)) throw new TypeError("P4 partitions must be an array");
	if (partitions.length > 4_096) throw new TypeError("P4 partitions must contain at most 4096 entries");
	const partitionIds = new Set<string>();
	const context: P4PartitionValidationContext = {
		inventory: new Set(binding.inventory_files),
		scoped: new Set(binding.scoped_files),
		requested_remedies: new Set(request.requested_remedies),
		file_owners: new Map(),
	};
	for (const partition of partitions) {
		if (!isJsonObject(partition)) throw new TypeError("P4 partition must be an object");
		requireP4PartitionId(partition, partitionIds);
		assignP4PartitionFiles(partition, context);
		requireP4PartitionRemedies(partition, context.requested_remedies);
		requireP4PartitionBoundaries(partition);
	}
	const missing = binding.scoped_files.filter((file) => !context.file_owners.has(file));
	if (missing.length > 0) {
		throw new TypeError(`P4 partition assignment is incomplete; missing: ${missing.join(", ")}`);
	}
	return partitions
		.map(normalizePartition)
		.sort((left, right) => compareCodeUnits(left.partition_id, right.partition_id));
}

interface P4Topology {
	partitions: SimplificationAgentCiPartition[];
	partition_coverage: SimplificationAgentCiP4PartitionCoverage;
}

function buildP4PlanFromKey(
	requestCacheKey: string,
	riskTier: SimplificationAgentCiRiskTier,
	topology: P4Topology,
): SimplificationAgentCiP4Plan {
	const normalized = topology.partitions;
	return {
		schema_version: SIMPLIFICATION_P4_PLAN_VERSION,
		phase: "P4",
		execution: "declarative_only",
		request_cache_key: requestCacheKey,
		risk_tier: riskTier,
		context: {
			repository_text_trust: "untrusted",
			delivery: "shared_content_addressed_artifact",
			boundary_tags_stripped: true,
			allowlisted_tools_only: true,
		},
		partitions: normalized,
		partition_coverage: topology.partition_coverage,
		roles: {
			coordinator: {
				role: "coordinator",
				model_tier: "top",
				responsibilities: [
					"risk-tier and partition fanout",
					"schema validation and deduplication",
					"reasonableness filtering without invented evidence",
				],
			},
			specialists: normalized.map((partition) => ({
				agent_id: `specialist:${partition.partition_id}`,
				role: "simplification_specialist",
				partition_id: partition.partition_id,
				reads: "declared_partition_and_shared_context",
				sees_other_specialists: false,
				remedies: [...partition.remedies],
				output: "schema_valid_findings_or_explicit_no_findings_with_read_set",
			})),
			capability_specialist: {
				role: "cross_partition_capability_specialist",
				remedies: ["stdlib", "native"],
				requires_version_pins: true,
				output: "evidence_only",
			},
			synthesizer: {
				role: "synthesizer",
				may_invent_evidence: false,
				must_assign_overlap_groups_before_totals: true,
				must_rerun_after_any_input_change: true,
			},
			skeptic: {
				role: "independent_skeptic",
				fanout: "one_per_eligible_finding",
				sees_original_rationale: false,
				default_disposition: "unconfirmed",
			},
			completeness_auditor: {
				role: "completeness_auditor",
				reads: "inventory_assignments_read_telemetry_and_failures",
				reads_finding_rationale: false,
				mints_final_coverage_receipt: true,
			},
		},
		rereview: {
			prior_findings_required: true,
			unfixed_must_reemit: true,
			user_acked_stays_closed_unless_materially_worse: true,
			skipped_partition_means_unknown_not_fixed: true,
		},
	};
}

/** Construct a P4 fanout plan tied to every result-affecting request input. */
export function buildSimplificationAgentCiP4Plan(
	request: ValidSimplificationAgentCiRequest,
	partitions: SimplificationAgentCiPartition[],
	inventoryBinding: SimplificationAgentCiP4InventoryBinding,
): SimplificationAgentCiP4Plan {
	const binding = normalizeP4InventoryBinding(request, inventoryBinding);
	const normalized = normalizeP4Partitions(request, partitions, binding);
	const assignedFiles = [...new Set(normalized.flatMap((partition) => partition.files))]
		.sort(compareCodeUnits);
	const assignment = normalized.map((partition) => ({
		partition_id: partition.partition_id,
		files: partition.files,
	}));
	return buildP4PlanFromKey(
		canonicalSimplificationAgentCiCacheKey(request),
		request.orchestration.risk_tier,
		{
			partitions: normalized,
			partition_coverage: {
				request_inventory_sha256: binding.inventory_sha256,
				inventory_path_set_sha256: sha256Canonical(binding.inventory_files),
				scoped_path_set_sha256: sha256Canonical(binding.scoped_files),
				assigned_path_set_sha256: sha256Canonical(assignedFiles),
				partition_assignment_sha256: sha256Canonical(assignment),
				inventory_files: binding.inventory_files.length,
				scoped_files: binding.scoped_files.length,
				assigned_files: assignedFiles.length,
				complete: true,
			},
		},
	);
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRepoPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
		!value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isRemedy(value: unknown): value is SimplificationRemedy {
	return typeof value === "string" && SIMPLIFICATION_REMEDIES.some((remedy) => remedy === value);
}

function isBoundary(value: unknown): value is SimplificationProtectedBoundary {
	return typeof value === "string" &&
		SIMPLIFICATION_PROTECTED_BOUNDARIES.some((boundary) => boundary === value);
}

function parsePartition(value: unknown): SimplificationAgentCiPartition | null {
	if (!isJsonObject(value)) return null;
	if (Object.keys(value).sort().join("|") !== "files|partition_id|protected_boundaries|remedies") return null;
	if (typeof value.partition_id !== "string" || value.partition_id.length === 0) return null;
	if (!Array.isArray(value.files) || !value.files.every(isRepoPath)) return null;
	if (!Array.isArray(value.remedies) || value.remedies.length === 0 || !value.remedies.every(isRemedy)) return null;
	if (!Array.isArray(value.protected_boundaries) || !value.protected_boundaries.every(isBoundary)) return null;
	return {
		partition_id: value.partition_id,
		files: [...value.files],
		remedies: [...value.remedies],
		protected_boundaries: [...value.protected_boundaries],
	};
}

/** Strictly parse by rebuilding the complete fixed topology and byte-comparing canonical JSON. */
export function parseSimplificationAgentCiP4Plan(
	input: unknown,
	request: ValidSimplificationAgentCiRequest,
	inventoryBinding: SimplificationAgentCiP4InventoryBinding,
): SimplificationPlanParseResult<SimplificationAgentCiP4Plan> {
	if (!isJsonObject(input) || !isSha256(input.request_cache_key)) {
		return { ok: false, reason: "P4 plan must carry a sha256 request_cache_key" };
	}
	if (input.risk_tier !== "lite" && input.risk_tier !== "full") {
		return { ok: false, reason: "P4 plan risk_tier must be lite or full" };
	}
	if (!Array.isArray(input.partitions)) return { ok: false, reason: "P4 plan partitions must be an array" };
	const partitions: SimplificationAgentCiPartition[] = [];
	for (const entry of input.partitions) {
		const partition = parsePartition(entry);
		if (!partition) return { ok: false, reason: "P4 plan has an invalid partition" };
		partitions.push(partition);
	}
	let rebuilt: SimplificationAgentCiP4Plan;
	try {
		rebuilt = buildSimplificationAgentCiP4Plan(request, partitions, inventoryBinding);
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : "P4 plan has invalid partition coverage",
		};
	}
	if (canonicalSimplificationAgentCiJson(input) !== canonicalSimplificationAgentCiJson(rebuilt)) {
		return { ok: false, reason: "P4 plan differs from the canonical role-isolation topology" };
	}
	return { ok: true, plan: rebuilt };
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
