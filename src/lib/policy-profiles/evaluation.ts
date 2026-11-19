import { buildActionInventory, type ActionObservation } from "../action-inventory.js";
import { crapThresholdFor, maxCognitiveFor, maxCyclomaticFor, maxFunctionTokensFor } from "../../harness/metric-caps.js";
import { maxLinesFor } from "../../harness/large-file-policy.js";
import { collectCompositeScoreReport } from "../metrics/composite-report.js";
import { collectRepositoryInventory } from "../metrics/inventory.js";
import { assessMetricPolicies, type MetricPolicyAssessment } from "./assessment.js";
import { policyProfileHash, type PolicyProfile } from "./profile.js";
import { buildStructuralPolicyProposal } from "./proposal.js";
import { evaluateProfileRules, type ProfileRuleResult } from "./rules.js";

function metricObservation(row: MetricPolicyAssessment, sourceHash: string, policyHash: string): ActionObservation | null {
	if (row.mode === "off" || row.status === "compared" && !row.exceedsTarget || row.status === "no-target" || row.status === "not-applicable") return null;
	const gap = row.status !== "compared";
	return { check: `metric-policy:${row.id}`, file: "<repository>", line: 0, classification: gap ? "evidence_gap" : "measurement",
		evidence: "proven", enforcement: row.mode, sourceHash, policyHash,
		message: `${row.id} ${row.status}. Reporting target ${row.reportingTarget ?? "absent"}. ${row.issues.join(" ")}`,
		nextStep: gap ? "Resolve the measurement or scope gap before comparing this reporting target." : "Inspect this measured reporting-target exceedance against the intended design.",
		validation: "Repeat the same source-bound measurement and inspect its denominator and limitations." };
}

function appendRuleObservations(observations: ActionObservation[], rules: ProfileRuleResult[], profileHash: string, registryHash: string): void {
	for (const rule of rules) for (const finding of rule.findings) observations.push({
		check: `profile-rule:${rule.id}`, subject: rule.check, file: finding.file, line: finding.line,
		classification: "candidate", evidence: finding.evidence, enforcement: rule.mode,
		sourceHash: finding.sourceHash, policyHash: profileHash, message: finding.text,
		nextStep: "Review the detector match against the source and its supported exceptions.",
		validation: "Validate the behavior and rerun this detector on the changed source.",
	});
	for (const rule of rules) if (rule.mode !== "off") for (const gap of rule.notMeasured) observations.push({
		check: `profile-rule:${rule.id}`, subject: gap, file: "<repository>", line: 0, classification: "evidence_gap",
		evidence: "proven", enforcement: rule.mode, sourceHash: null, policyHash: profileHash, detectorHash: registryHash, message: gap,
		nextStep: "Resolve detector source eligibility or missing evidence before interpreting this selection.",
		validation: "Rerun the same profile and inspect its completed and unmeasured source coverage.",
	});
}

/** Explicit local measurement reuses fixed adapters and selected registry detectors. */
export function evaluatePolicyProfile(root: string, profile: PolicyProfile) {
	const beganAt = new Date().toISOString();
	const inventory = collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" }), measurements = collectCompositeScoreReport(root);
	const issues = [...inventory.issues];
	if (inventory.inputHash !== measurements.inputHash) issues.push("Source inventory changed between detector and metric collection");
	const profileHash = policyProfileHash(profile);
	const metricPolicies = assessMetricPolicies(measurements.metrics, profile.metrics, inventory.files, {
		gaps: measurements.scope.notMeasured, discoveryIssues: [...issues, ...measurements.scope.discoveryIssues],
		canonicalThresholds: { cyclomatic: maxCyclomaticFor(root), cognitive: maxCognitiveFor(root), "function-tokens": maxFunctionTokensFor(root),
			"file.lines": maxLinesFor(root), "coverage.crap": crapThresholdFor(root) },
	});
	const rules = evaluateProfileRules(root, profile.rules, inventory.files, { gaps: inventory.gaps, excluded: inventory.excluded, discoveryIssues: inventory.issues });
	const observations = metricPolicies.map(row => metricObservation(row, inventory.sourceHash, profileHash)).filter((row): row is ActionObservation => row !== null);
	appendRuleObservations(observations, rules, profileHash, measurements.registryHash);
	const limitations = ["Profile evaluation is read-only. Reporting targets supply advisory comparisons and no adopted runtime enforcement.",
		"Detector completion describes execution of its existing contract. Missing notices, language support and internal finding limits constrain coverage.",
		"Aggregate subsets require fresh scoped measurements. Source snapshots and retained evidence carry separate hashes."];
	return { schemaVersion: 1 as const, modelCalls: 0 as const, profile, profileHash, beganAt, endedAt: new Date().toISOString(),
		scope: { root: inventory.root, rolesVersion: inventory.version, inputHash: inventory.inputHash, metricInputHash: measurements.inputHash,
			files: inventory.files.length, exclusions: inventory.excluded, gaps: inventory.gaps, issues },
		measurements, metricPolicies, rules, actions: buildActionInventory(observations, limitations),
		structuralProposal: buildStructuralPolicyProposal(root, profile), limitations };
}

export type PolicyProfileEvaluation = ReturnType<typeof evaluatePolicyProfile>;
