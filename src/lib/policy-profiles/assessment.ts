import { metricPolicyApplies, type MetricPolicies, type MetricPolicyMode, type MetricPolicyEntry, type MetricPolicyScope } from "../../harness/metric-policy.js";
import { METRIC_CATALOG } from "../metrics/catalog-metrics.js";
import { emptyReading } from "../metrics/adapter-values.js";
import { profileMeasurementContract } from "./profile.js";
import type { InventoryFile, InventoryGap, MetricReading } from "../metrics/measurement-types.js";

export interface MetricPolicyAssessment {
	id: string;
	requestedMode: MetricPolicyMode;
	mode: "report" | "warn" | "off";
	measurementState: MetricReading["state"];
	measurementContract: string | null;
	status: "off" | "not-applicable" | "evidence-unavailable" | "scope-unmeasured" | "no-target" | "compared";
	reportingTarget: number | null;
	exceedsTarget: boolean | null;
	warning: boolean;
	populationFiles: number;
	selectedFiles: number;
	issues: string[];
}
export interface AssessmentContext {
	gaps?: readonly InventoryGap[];
	discoveryIssues?: readonly string[];
	canonicalThresholds?: Readonly<Record<string, number>>;
}

/** Select the declared population and establish whether the retained aggregate covers it. */
function assessmentScope(id: string, scope: MetricPolicyScope, files: readonly InventoryFile[], context: AssessmentContext) {
	const definition = METRIC_CATALOG.find(metric => metric.id === id);
	const population = files.filter(file => definition?.roles.includes(file.role) && definition.languages.includes(file.language ?? ""));
	const selected = population.filter(file => metricPolicyApplies(scope, file.path, file.role));
	const gaps = context.gaps?.filter(gap => definition?.roles.includes(gap.role) && metricPolicyApplies(scope, gap.path, gap.role)) ?? [];
	return { populationFiles: population.length, selectedFiles: selected.length, direction: definition?.direction,
		unmeasured: selected.length !== population.length || gaps.length > 0 || (context.discoveryIssues?.length ?? 0) > 0 };
}

function initialAssessment(
	reading: MetricReading, entry: MetricPolicyEntry | undefined,
	scope: ReturnType<typeof assessmentScope>, context: AssessmentContext,
): MetricPolicyAssessment {
	const requestedMode = entry?.mode ?? "report", mode = requestedMode === "block" ? "warn" : requestedMode;
	const issues = reading.id === "function-tokens" || reading.id === "file.lines" ? [...reading.limitations] : [];
	if (requestedMode === "block") issues.push("Requested block has no project-report enforcement. Review structural-three proposals separately.");
	const reportingTarget = entry ? entry.threshold ?? context.canonicalThresholds?.[reading.id] ?? null : null;
	return { id: reading.id, requestedMode, mode, measurementState: reading.state,
		measurementContract: reading.id === "file.lines" && !entry ? "Physical lines excluding the terminal empty segment" : profileMeasurementContract(reading.id),
		status: "no-target", reportingTarget, exceedsTarget: null, warning: false, populationFiles: scope.populationFiles, selectedFiles: scope.selectedFiles, issues };
}

function assessReading(
	reading: MetricReading, entry: MetricPolicyEntry | undefined,
	files: readonly InventoryFile[], context: AssessmentContext,
): MetricPolicyAssessment {
	const scope = assessmentScope(reading.id, entry?.scope ?? {}, files, context);
	const result = initialAssessment(reading, entry, scope, context);
	if (result.mode === "off") return { ...result, status: "off" };
	if (reading.state === "not-applicable") return { ...result, status: "not-applicable" };
	if (reading.state !== "measured" || reading.value === null || !Number.isFinite(reading.value)) return { ...result, status: "evidence-unavailable" };
	if (scope.unmeasured) {
		result.issues.push("Retained aggregate does not establish a complete measurement for this selected population");
		return { ...result, status: "scope-unmeasured" };
	}
	const { reportingTarget } = result;
	if (reportingTarget === null) return result;
	const exceedsTarget = scope.direction === "higher" ? reading.value < reportingTarget : reading.value > reportingTarget;
	return { ...result, status: "compared", exceedsTarget, warning: result.mode === "warn" && exceedsTarget };
}

/** Disposition consumes retained numeric evidence without changing its value, scope or score. */
export function assessMetricPolicies(readings: readonly MetricReading[], policies: MetricPolicies, files: readonly InventoryFile[], context: AssessmentContext = {}): MetricPolicyAssessment[] {
	const selectedReadings = readings.map(reading => reading.id === "file.lines" && policies[reading.id]
		? emptyReading("file.lines", "unsupported", reading.eligibleEntities,
			"The retained AST reading excludes a terminal empty segment. The hook policy uses newline-split lines, so this target needs a matching measurement.")
		: reading);
	if (policies["function-tokens"] && !readings.some(reading => reading.id === "function-tokens")) {
		selectedReadings.push(emptyReading("function-tokens", "unsupported", 0, "Canonical function-token measurement was not collected by this project-report adapter"));
	}
	return selectedReadings.map(reading => assessReading(reading, policies[reading.id], files, context));
}
