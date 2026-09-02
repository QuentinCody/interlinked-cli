// ===========================================
// Simplification Agent CI — experiment outcome parsing + scalar field predicates
// ===========================================
// Extracted from simplification-agent-ci-experiment.ts. The predicates here are
// the shared field-shape vocabulary the manifest parsers speak; the outcome
// parsers are the one lane that needs artifact-path validation.

import { isJsonObject, type JsonObject } from "./json-types.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIRECTIONS = ["lower_is_better", "higher_is_better"] as const;

export interface SimplificationExperimentMetric {
	name: string;
	unit: string;
	direction: (typeof DIRECTIONS)[number];
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

export interface SimplificationExperimentOutcomes {
	primary_metric: string;
	metrics: SimplificationExperimentMetric[];
	safety: SimplificationExperimentSafetyOutcome;
	completeness: SimplificationExperimentCompletenessOutcome;
	raw_results_path: string;
	raw_results_sha256: string;
	analysis_output_path: string;
	analysis_output_sha256: string;
}

export function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

export function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

export function sha256(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

function artifactPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) return false;
	if (value.includes("\\") || /^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function gitObject(value: unknown): value is string {
	return typeof value === "string" && GIT_OBJECT_PATTERN.test(value);
}

export function isoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

export function sortedUniqueStrings(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every(nonempty)) return false;
	if (new Set(value).size !== value.length) return false;
	return value.every((entry, index) => index === 0 || entry >= (value[index - 1] ?? ""));
}

function isMetricDirection(
	value: unknown,
): value is SimplificationExperimentMetric["direction"] {
	return typeof value === "string" && DIRECTIONS.some((direction) => direction === value);
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

/** Every metric in the list, or null if the list is empty/not an array/malformed. */
function parseMetricList(value: unknown): SimplificationExperimentMetric[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const metrics: SimplificationExperimentMetric[] = [];
	for (const entry of value) {
		const metric = parseMetric(entry);
		if (!metric) return null;
		metrics.push(metric);
	}
	return metrics;
}

/** Metric names must be unique, ascending, and contain the declared primary metric. */
function metricNamesValid(metrics: SimplificationExperimentMetric[], primary: string): boolean {
	const names = metrics.map((metric) => metric.name);
	if (new Set(names).size !== names.length || !names.includes(primary)) return false;
	return names.every((name, index) => index === 0 || name >= (names[index - 1] ?? ""));
}

type OutcomeArtifacts = Pick<
	SimplificationExperimentOutcomes,
	"raw_results_path" | "raw_results_sha256" | "analysis_output_path" | "analysis_output_sha256"
>;

/** The four repo-relative artifact references that pin the raw and analysed results. */
function parseOutcomeArtifacts(value: JsonObject): OutcomeArtifacts | null {
	if (!artifactPath(value.raw_results_path) || !sha256(value.raw_results_sha256)) return null;
	if (!artifactPath(value.analysis_output_path) || !sha256(value.analysis_output_sha256)) {
		return null;
	}
	return {
		raw_results_path: value.raw_results_path,
		raw_results_sha256: value.raw_results_sha256,
		analysis_output_path: value.analysis_output_path,
		analysis_output_sha256: value.analysis_output_sha256,
	};
}

export function parseOutcomes(value: unknown): SimplificationExperimentOutcomes | null {
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
	if (!nonempty(value.primary_metric)) return null;
	const metrics = parseMetricList(value.metrics);
	if (!metrics || !metricNamesValid(metrics, value.primary_metric)) return null;
	const safety = parseSafetyOutcome(value.safety);
	const completeness = parseCompletenessOutcome(value.completeness);
	const artifacts = parseOutcomeArtifacts(value);
	if (!safety || !completeness || !artifacts) return null;
	return {
		primary_metric: value.primary_metric,
		metrics,
		safety,
		completeness,
		...artifacts,
	};
}
