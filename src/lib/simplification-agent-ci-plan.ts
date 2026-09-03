// ===========================================
// Simplification Agent CI — declarative P4/P5 plans
// ===========================================
// These are plans, not executors. They make role isolation, protected
// boundaries, and independent validation inspectable before a future remote
// implementation is authorized.

import { isJsonObject } from "./json-types.js";
import {
	boundaryOrder,
	compareCodeUnits,
	isBoundary,
	isRemedy,
	isRepoPath,
	isSha256,
	pathIsSelectedByRequest,
	remedyOrder,
	requireUniqueRepositoryPaths,
	sameStrings,
	sha256Canonical,
	type SimplificationProtectedBoundary,
} from "./simplification-agent-ci-plan-primitives.js";
import type { SimplificationPlanParseResult } from "./simplification-agent-ci-plan-primitives.js";
import {
	canonicalSimplificationAgentCiCacheKey,
	canonicalSimplificationAgentCiJson,
	type SimplificationAgentCiRiskTier,
	type ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request.js";
import type { SimplificationRemedy } from "./simplification-types.js";

const SIMPLIFICATION_P4_PLAN_VERSION = "simplification-orchestration-plan/v2" as const;

interface SimplificationAgentCiPartition {
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
interface SimplificationAgentCiP4InventoryBinding {
	inventory_sha256: string;
	inventory_files: string[];
	scoped_files: string[];
}

interface SimplificationAgentCiP4PartitionCoverage {
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

interface SimplificationAgentCiP4Plan {
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

const MAX_P4_PARTITION_ID_LENGTH = 256;
const P4_PARTITION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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
