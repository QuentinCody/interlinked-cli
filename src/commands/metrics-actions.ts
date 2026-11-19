import { buildActionInventory, type ActionInventory, type ActionObservation } from "../lib/action-inventory.js";
import type { FileMetric, FnMetric, MetricsReport } from "./metrics-renderers.js";

/** Measurements suggest work; crossing a reporting threshold does not adopt a blocking policy. */
export function metricActions(input: { functions: readonly FnMetric[]; files: readonly FileMetric[]; caps: MetricsReport["caps"]; notMeasured?: readonly { file: string; reason: string }[] }): ActionInventory {
	const observations: ActionObservation[] = [];
	const hashes = new Map(input.files.map(file => [file.file, file.sourceSha256 ?? null]));
	const add = (check: string, file: string, line: number, subject: string | undefined, classification: ActionObservation["classification"], message: string, nextStep: string, validation: string): void => {
		observations.push({ check, file, line, ...(subject ? { subject } : {}), classification, message,
			evidence: classification === "measurement" ? "proven" : "heuristic", sourceHash: hashes.get(file) ?? null,
			policyHash: null, nextStep, validation });
	};
	for (const fn of input.functions) {
		if (fn.cyclomatic > input.caps.cyclomatic) add("cyclomatic", fn.file, fn.line, fn.name, "measurement",
			`Measured complexity ${fn.cyclomatic} exceeds the review threshold ${input.caps.cyclomatic}.`,
			"Review branch responsibilities and whether cohesive decomposition helps; a threshold is not proof of a defect.", "Remeasure complexity and run the affected behavioral tests.");
		if (fn.crap !== null && fn.crap >= input.caps.crap) add("crap", fn.file, fn.line, fn.name, "measurement",
			`Measured CRAP ${fn.crap} reaches the review threshold ${input.caps.crap}.`,
			"Inspect complex paths with weak coverage; add behavioral tests or simplify redundant branches.", "Regenerate current coverage, rerun affected tests and remeasure CRAP.");
		if (fn.canonicalTokens != null && input.caps.functionTokens !== undefined && fn.canonicalTokens > input.caps.functionTokens) add("function_tokens", fn.file, fn.line, fn.name, "measurement",
			`Measured function size ${fn.canonicalTokens} exceeds the review threshold ${input.caps.functionTokens}.`,
			"Review the function's responsibilities; extract only cohesive behavior that improves understanding.", "Remeasure canonical tokens and verify preserved behavior with affected tests.");
	}
	for (const file of input.files) {
		if (file.linePct === null) add("coverage", file.file, 1, undefined, "evidence_gap",
			"No line coverage measurement is available for this file.", "Generate coverage for this file using the project's test runner; missing coverage is not zero coverage.", "Rerun metrics with a coverage report for the same source version.");
		if (file.companion === false) add("test_companion", file.file, 1, undefined, "evidence_gap",
			"No companion test was found by the supported naming and layout conventions.", "Check existing integration coverage and test mappings before adding a meaningful behavioral test.", "Run the mapped tests and confirm this source's behavior is exercised.");
	}
	for (const gap of input.notMeasured ?? []) add("source_measurement", gap.file, 1, undefined, "evidence_gap", gap.reason,
		"Inspect the unavailable source or analyzer and establish measurement coverage before drawing conclusions.", "Rerun the inventory and confirm the named source is measured by a supported adapter.");
	return buildActionInventory(observations, ["This inventory contains measurement opportunities and evidence gaps, not a count of confirmed defects or blocking verdicts.", "Only measured source and available adapters contribute; unsupported and deferred analysis must be reviewed separately."]);
}

export function renderMetricActions(inventory: ActionInventory | undefined, full: boolean): string[] {
	if (!inventory) return [];
	const gaps = inventory.actions.filter(action => action.classification === "evidence_gap").length;
	if (!full) return ["", `  ${inventory.actions.length} local action(s), including ${gaps} evidence gap(s). Use --full or --json for complete evidence and next steps.`];
	return ["", "  Complete local action inventory (advisory)", ...inventory.actions.flatMap(action => [
		`    ${action.file}:${action.line} [${action.classification}] ${action.evidence.map(row => row.message).join("; ")}`,
		...action.nextSteps.map(step => `      Next: ${step}`),
		...action.validation.map(step => `      Validate: ${step}`),
	])];
}
