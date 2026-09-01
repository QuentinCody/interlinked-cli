// ===========================================
// Simplification Agent CI — experiment evidence manifest
// ===========================================
// Impact reporting may describe observations freely, but the word "causal"
// is earned only by a fully pinned controlled-experiment manifest.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "./json-types.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import { isPinnedExactVersion } from "./simplification-version.js";

const SIMPLIFICATION_EXPERIMENT_VERSION = "simplification-experiment/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLAIM_KINDS = ["observational", "causal"] as const;
const DESIGNS = ["randomized_paired", "randomized_parallel"] as const;
const DIRECTIONS = ["lower_is_better", "higher_is_better"] as const;

export type SimplificationExperimentClaimKind = (typeof CLAIM_KINDS)[number];
export type SimplificationExperimentDesignKind = (typeof DESIGNS)[number];

export interface SimplificationExperimentMetric {
	name: string;
	unit: string;
	direction: (typeof DIRECTIONS)[number];
}

export interface SimplificationExperimentArm {
	name: string;
	instructions_sha256: string;
}

export interface SimplificationExperimentSafetyOutcome {
	protected_behavior_regressions: number;
	required_checks_passed: boolean;
	receipt_path: string;
	receipt_sha256: string;
}

export interface SimplificationExperimentCompletenessOutcome {
	planned_runs: number;
	completed_runs: number;
	scored_runs: number;
	coverage_path: string;
	coverage_sha256: string;
}

export interface SimplificationCausalDesign {
	design: SimplificationExperimentDesignKind;
	experimental_unit: string;
	assignment_seed: string;
	assignment_algorithm: string;
	control: SimplificationExperimentArm;
	treatment: SimplificationExperimentArm;
	analysis_plan_sha256: string;
	preregistration_sha256: string;
	missing_data_policy: string;
	blinded_evaluator: boolean;
}

export interface SimplificationExperimentManifest {
	schema_version: typeof SIMPLIFICATION_EXPERIMENT_VERSION;
	experiment_id: string;
	claim: {
		kind: SimplificationExperimentClaimKind;
		statement: string;
	};
	repository: {
		repository_id: string;
		tree_sha: string;
		source_artifact_sha256: string;
		dirty: false;
	};
	task_suite: {
		name: string;
		version: string;
		task_set_sha256: string;
		evaluator_sha256: string;
	};
	model: {
		provider: string;
		family: string;
		model: string;
		version: string;
		parameters_sha256: string;
	};
	environment: {
		container_image_digest: string;
		dependency_lock_sha256: string;
		harness_version: string;
		runtime_versions: Array<{ name: string; version: string }>;
	};
	runs: {
		started_at: string;
		completed_at: string;
		sample_size: number;
		failed_runs: number;
		exclusions: string[];
	};
	outcomes: {
		primary_metric: string;
		metrics: SimplificationExperimentMetric[];
		safety: SimplificationExperimentSafetyOutcome;
		completeness: SimplificationExperimentCompletenessOutcome;
		raw_results_path: string;
		raw_results_sha256: string;
		analysis_output_path: string;
		analysis_output_sha256: string;
	};
	causal_design: SimplificationCausalDesign | null;
}

declare const VALID_EXPERIMENT: unique symbol;
export type ValidSimplificationExperimentManifest = Readonly<SimplificationExperimentManifest> & {
	readonly [VALID_EXPERIMENT]: true;
};

export type SimplificationExperimentParseResult =
	| { ok: true; manifest: ValidSimplificationExperimentManifest }
	| { ok: false; reason: string };

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function sha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

function artifactPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) return false;
	if (value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function gitObject(value: unknown): value is string {
	return typeof value === "string" && GIT_OBJECT_PATTERN.test(value);
}

function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function sortedUniqueStrings(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every(nonempty)) return false;
	if (new Set(value).size !== value.length) return false;
	return value.every((entry, index) => index === 0 || entry >= (value[index - 1] ?? ""));
}

function isClaimKind(value: unknown): value is SimplificationExperimentClaimKind {
	return typeof value === "string" && CLAIM_KINDS.some((kind) => kind === value);
}

function isMetricDirection(
	value: unknown,
): value is SimplificationExperimentMetric["direction"] {
	return typeof value === "string" && DIRECTIONS.some((direction) => direction === value);
}

function isDesignKind(value: unknown): value is SimplificationExperimentDesignKind {
	return typeof value === "string" && DESIGNS.some((design) => design === value);
}

function parseClaim(value: unknown): SimplificationExperimentManifest["claim"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["kind", "statement"])) return null;
	const kind = value.kind;
	if (!isClaimKind(kind) || !nonempty(value.statement)) return null;
	return { kind, statement: value.statement };
}

function parseRepository(value: unknown): SimplificationExperimentManifest["repository"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["repository_id", "tree_sha", "source_artifact_sha256", "dirty"],
	)) return null;
	if (!nonempty(value.repository_id) || !gitObject(value.tree_sha) || !sha256(value.source_artifact_sha256)) return null;
	if (value.dirty !== false) return null;
	return {
		repository_id: value.repository_id,
		tree_sha: value.tree_sha,
		source_artifact_sha256: value.source_artifact_sha256,
		dirty: false,
	};
}

function parseTaskSuite(value: unknown): SimplificationExperimentManifest["task_suite"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "version", "task_set_sha256", "evaluator_sha256"])) return null;
	if (!nonempty(value.name) || !nonempty(value.version) || !sha256(value.task_set_sha256) || !sha256(value.evaluator_sha256)) return null;
	if (!isPinnedExactVersion(value.version)) return null;
	return {
		name: value.name,
		version: value.version,
		task_set_sha256: value.task_set_sha256,
		evaluator_sha256: value.evaluator_sha256,
	};
}

function parseModel(value: unknown): SimplificationExperimentManifest["model"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["provider", "family", "model", "version", "parameters_sha256"],
	)) return null;
	if (
		!nonempty(value.provider) || !nonempty(value.family) || !nonempty(value.model) ||
		!nonempty(value.version) || !sha256(value.parameters_sha256)
	) return null;
	if (!isPinnedExactVersion(value.version)) return null;
	return {
		provider: value.provider,
		family: value.family,
		model: value.model,
		version: value.version,
		parameters_sha256: value.parameters_sha256,
	};
}

function parseRuntimeVersions(value: unknown): Array<{ name: string; version: string }> | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const result: Array<{ name: string; version: string }> = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !exactKeys(entry, ["name", "version"])) return null;
		if (!nonempty(entry.name) || !nonempty(entry.version)) return null;
		if (!isPinnedExactVersion(entry.version)) return null;
		result.push({ name: entry.name, version: entry.version });
	}
	const names = result.map((entry) => entry.name);
	if (new Set(names).size !== names.length) return null;
	if (!names.every((name, index) => index === 0 || name >= (names[index - 1] ?? ""))) return null;
	return result;
}

function parseEnvironment(value: unknown): SimplificationExperimentManifest["environment"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["container_image_digest", "dependency_lock_sha256", "harness_version", "runtime_versions"],
	)) return null;
	const runtime_versions = parseRuntimeVersions(value.runtime_versions);
	if (
		typeof value.container_image_digest !== "string" ||
		!IMAGE_DIGEST_PATTERN.test(value.container_image_digest) ||
		!sha256(value.dependency_lock_sha256) || !nonempty(value.harness_version) || !runtime_versions
	) return null;
	if (!isPinnedExactVersion(value.harness_version)) return null;
	return {
		container_image_digest: value.container_image_digest,
		dependency_lock_sha256: value.dependency_lock_sha256,
		harness_version: value.harness_version,
		runtime_versions,
	};
}

function parseRuns(value: unknown): SimplificationExperimentManifest["runs"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["started_at", "completed_at", "sample_size", "failed_runs", "exclusions"],
	)) return null;
	if (!isoTimestamp(value.started_at) || !isoTimestamp(value.completed_at)) return null;
	if (Date.parse(value.completed_at) < Date.parse(value.started_at)) return null;
	if (!Number.isInteger(value.sample_size) || typeof value.sample_size !== "number" || value.sample_size < 1) return null;
	if (!Number.isInteger(value.failed_runs) || typeof value.failed_runs !== "number" || value.failed_runs < 0) return null;
	if (value.failed_runs > value.sample_size || !sortedUniqueStrings(value.exclusions)) return null;
	return {
		started_at: value.started_at,
		completed_at: value.completed_at,
		sample_size: value.sample_size,
		failed_runs: value.failed_runs,
		exclusions: [...value.exclusions],
	};
}

function parseMetric(value: unknown): SimplificationExperimentMetric | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "unit", "direction"])) return null;
	const direction = value.direction;
	if (!nonempty(value.name) || !nonempty(value.unit) || !isMetricDirection(direction)) return null;
	return { name: value.name, unit: value.unit, direction };
}

function parseSafetyOutcome(value: unknown): SimplificationExperimentSafetyOutcome | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"protected_behavior_regressions",
			"required_checks_passed",
			"receipt_path",
			"receipt_sha256",
		],
	)) return null;
	if (
		typeof value.protected_behavior_regressions !== "number"
		|| !Number.isInteger(value.protected_behavior_regressions)
		|| value.protected_behavior_regressions < 0
		|| typeof value.required_checks_passed !== "boolean"
		|| !artifactPath(value.receipt_path)
		|| !sha256(value.receipt_sha256)
	) return null;
	return {
		protected_behavior_regressions: value.protected_behavior_regressions,
		required_checks_passed: value.required_checks_passed,
		receipt_path: value.receipt_path,
		receipt_sha256: value.receipt_sha256,
	};
}

function parseCompletenessOutcome(
	value: unknown,
): SimplificationExperimentCompletenessOutcome | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["planned_runs", "completed_runs", "scored_runs", "coverage_path", "coverage_sha256"],
	)) return null;
	for (const count of [value.planned_runs, value.completed_runs, value.scored_runs]) {
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
	}
	if (
		typeof value.planned_runs !== "number"
		|| typeof value.completed_runs !== "number"
		|| typeof value.scored_runs !== "number"
		|| value.completed_runs > value.planned_runs
		|| value.scored_runs > value.completed_runs
		|| !artifactPath(value.coverage_path)
		|| !sha256(value.coverage_sha256)
	) return null;
	return {
		planned_runs: value.planned_runs,
		completed_runs: value.completed_runs,
		scored_runs: value.scored_runs,
		coverage_path: value.coverage_path,
		coverage_sha256: value.coverage_sha256,
	};
}

function parseOutcomes(value: unknown): SimplificationExperimentManifest["outcomes"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"primary_metric",
			"metrics",
			"safety",
			"completeness",
			"raw_results_path",
			"raw_results_sha256",
			"analysis_output_path",
			"analysis_output_sha256",
		],
	)) return null;
	if (!nonempty(value.primary_metric) || !Array.isArray(value.metrics) || value.metrics.length === 0) return null;
	const metrics: SimplificationExperimentMetric[] = [];
	for (const entry of value.metrics) {
		const metric = parseMetric(entry);
		if (!metric) return null;
		metrics.push(metric);
	}
	const names = metrics.map((metric) => metric.name);
	if (new Set(names).size !== names.length || !names.includes(value.primary_metric)) return null;
	if (!names.every((name, index) => index === 0 || name >= (names[index - 1] ?? ""))) return null;
	const safety = parseSafetyOutcome(value.safety);
	const completeness = parseCompletenessOutcome(value.completeness);
	if (
		!safety || !completeness || !artifactPath(value.raw_results_path)
		|| !sha256(value.raw_results_sha256) || !artifactPath(value.analysis_output_path)
		|| !sha256(value.analysis_output_sha256)
	) return null;
	return {
		primary_metric: value.primary_metric,
		metrics,
		safety,
		completeness,
		raw_results_path: value.raw_results_path,
		raw_results_sha256: value.raw_results_sha256,
		analysis_output_path: value.analysis_output_path,
		analysis_output_sha256: value.analysis_output_sha256,
	};
}

function completenessMatchesRuns(
	outcomes: SimplificationExperimentManifest["outcomes"],
	runs: SimplificationExperimentManifest["runs"],
): boolean {
	return outcomes.completeness.planned_runs === runs.sample_size
		&& outcomes.completeness.completed_runs === runs.sample_size - runs.failed_runs;
}

function parseArm(value: unknown): SimplificationExperimentArm | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "instructions_sha256"])) return null;
	if (!nonempty(value.name) || !sha256(value.instructions_sha256)) return null;
	return { name: value.name, instructions_sha256: value.instructions_sha256 };
}

function parseCausalDesign(value: unknown): SimplificationCausalDesign | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"design",
			"experimental_unit",
			"assignment_seed",
			"assignment_algorithm",
			"control",
			"treatment",
			"analysis_plan_sha256",
			"preregistration_sha256",
			"missing_data_policy",
			"blinded_evaluator",
		],
	)) return null;
	const design = value.design;
	if (!isDesignKind(design)) return null;
	if (
		!nonempty(value.experimental_unit) || !nonempty(value.assignment_seed) ||
		!nonempty(value.assignment_algorithm) || !nonempty(value.missing_data_policy)
	) return null;
	const control = parseArm(value.control);
	const treatment = parseArm(value.treatment);
	if (!control || !treatment || control.name === treatment.name) return null;
	if (control.instructions_sha256 === treatment.instructions_sha256) return null;
	if (!sha256(value.analysis_plan_sha256) || !sha256(value.preregistration_sha256)) return null;
	if (typeof value.blinded_evaluator !== "boolean") return null;
	return {
		design,
		experimental_unit: value.experimental_unit,
		assignment_seed: value.assignment_seed,
		assignment_algorithm: value.assignment_algorithm,
		control,
		treatment,
		analysis_plan_sha256: value.analysis_plan_sha256,
		preregistration_sha256: value.preregistration_sha256,
		missing_data_policy: value.missing_data_policy,
		blinded_evaluator: value.blinded_evaluator,
	};
}

function freezeRecursively<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const member of Object.values(value)) freezeRecursively(member);
	}
	return value;
}

function causalRelationshipError(
	claim: SimplificationExperimentManifest["claim"],
	runs: SimplificationExperimentManifest["runs"],
	causalDesign: SimplificationCausalDesign | null,
): string | null {
	if (claim.kind === "causal" && causalDesign === null) {
		return "causal claims require a complete controlled-experiment design";
	}
	if (claim.kind === "causal" && runs.sample_size < 2) {
		return "causal claims require at least two experimental units";
	}
	if (claim.kind === "observational" && causalDesign !== null) {
		return "observational claims must not carry an unused causal design";
	}
	return null;
}

export function parseSimplificationExperimentManifest(
	input: unknown,
): SimplificationExperimentParseResult {
	if (!isJsonObject(input) || !exactKeys(
		input,
		[
			"schema_version",
			"experiment_id",
			"claim",
			"repository",
			"task_suite",
			"model",
			"environment",
			"runs",
			"outcomes",
			"causal_design",
		],
	)) return { ok: false, reason: "experiment manifest has an unknown or missing top-level field" };
	if (input.schema_version !== SIMPLIFICATION_EXPERIMENT_VERSION || !nonempty(input.experiment_id)) {
		return { ok: false, reason: "experiment manifest version or id is invalid" };
	}
	const claim = parseClaim(input.claim);
	const repository = parseRepository(input.repository);
	const task_suite = parseTaskSuite(input.task_suite);
	const model = parseModel(input.model);
	const environment = parseEnvironment(input.environment);
	const runs = parseRuns(input.runs);
	const outcomes = parseOutcomes(input.outcomes);
	if (!claim || !repository || !task_suite || !model || !environment || !runs || !outcomes) {
		return { ok: false, reason: "experiment manifest has incomplete or unpinned evidence metadata" };
	}
	if (!completenessMatchesRuns(outcomes, runs)) {
		return { ok: false, reason: "experiment completeness counts do not match run receipts" };
	}
	const causal_design = input.causal_design === null ? null : parseCausalDesign(input.causal_design);
	if (input.causal_design !== null && !causal_design) {
		return { ok: false, reason: "experiment causal_design is incomplete" };
	}
	const causalError = causalRelationshipError(claim, runs, causal_design);
	if (causalError) return { ok: false, reason: causalError };
	const manifest: SimplificationExperimentManifest = {
		schema_version: SIMPLIFICATION_EXPERIMENT_VERSION,
		experiment_id: input.experiment_id,
		claim,
		repository,
		task_suite,
		model,
		environment,
		runs,
		outcomes,
		causal_design,
	};
	freezeRecursively(manifest);
	// SAFETY: exact-shape parsers constructed every nested field, causal
	// metadata was checked against claim kind, and the result is frozen.
	return { ok: true, manifest: manifest as ValidSimplificationExperimentManifest };
}

export function simplificationExperimentManifestSha256(
	manifest: ValidSimplificationExperimentManifest,
): string {
	return createHash("sha256")
		.update(canonicalSimplificationAgentCiJson(manifest), "utf8")
		.digest("hex");
}
