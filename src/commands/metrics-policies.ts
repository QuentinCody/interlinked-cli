import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHECK_REGISTRY } from "../harness/check-registry/index.js";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { isCheckPolicyFile } from "../harness/check-policy-values.js";
import { hasErrorCode } from "../harness/check-engine/tool-errors.js";
import { parseWaterLineJson } from "../harness/water-line-json.js";
import { METRIC_CATALOG } from "../lib/metrics/catalog-metrics.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { evaluatePolicyProfile, type PolicyProfileEvaluation } from "../lib/policy-profiles/evaluation.js";
import { parsePolicyProfile, policyProfileHash, profileMeasurementContract, structuralPolicyId, type PolicyProfile } from "../lib/policy-profiles/profile.js";
import { buildStructuralPolicyProposal } from "../lib/policy-profiles/proposal.js";

export interface MetricsPoliciesOptions { cwd?: string; json?: boolean; short?: boolean; full?: boolean; id?: string; }

function readProfile(path: string): PolicyProfile {
	const parsed = parseWaterLineJson(readFileSync(path, "utf8"));
	if (!parsed.ok) throw new Error(`Profile is not strict JSON (${parsed.error})`);
	if (parsed.duplicateKeys.length) throw new Error(`Profile repeats keys ${parsed.duplicateKeys.join(", ")}`);
	return parsePolicyProfile(parsed.value);
}

function configuredProfile(root: string, id = "current-repository"): PolicyProfile {
	for (const file of ["check-policy.json", "check-policy.local.json"]) {
		try {
			const parsed = parseWaterLineJson(readFileSync(resolve(root, ".interlinked", file), "utf8"));
			if (!parsed.ok || parsed.duplicateKeys.length || !isCheckPolicyFile(parsed.value)) throw new Error(`Configured check policy ${file} is malformed or ambiguous`);
		} catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
	}
	const policy = loadCheckPolicy(root);
	if (policy.metric_policy_issues?.length) throw new Error(policy.metric_policy_issues.join("\n"));
	return parsePolicyProfile({ schemaVersion: 1, id, metrics: policy.metrics ?? {}, rules: {} });
}

function failure(options: MetricsPoliciesOptions, error: unknown): void {
	outputError(getOutputMode(options), error instanceof Error ? error.message : "Policy profile command failed");
}

export function metricsPoliciesExportCommand(options: MetricsPoliciesOptions): void {
	try {
		const profile = configuredProfile(options.cwd ?? process.cwd(), options.id);
		output(getOutputMode(options), profile, { normal: () => JSON.stringify(profile, null, 2),
			short: () => `${profile.id} ${Object.keys(profile.metrics).length} configured metrics` });
	} catch (error) { failure(options, error); }
}

export function metricsPoliciesInspectCommand(file: string, options: MetricsPoliciesOptions): void {
	try {
		const root = resolve(options.cwd ?? process.cwd()), profile = readProfile(resolve(root, file));
		const metrics = Object.entries(profile.metrics).map(([id, entry]) => ({ id, requestedMode: entry.mode ?? "report",
			reportMode: entry.mode === "block" ? "warn" : entry.mode ?? "report", reportingTarget: entry.threshold ?? null,
			reportReading: id !== "file.lines" && METRIC_CATALOG.some(metric => metric.id === id), advisoryHook: id === "file.lines",
			measurementContract: profileMeasurementContract(id),
			retainedReadingContract: id === "file.lines" ? "Physical lines excluding the terminal empty segment" : profileMeasurementContract(id),
			editPolicy: structuralPolicyId(id), definition: METRIC_CATALOG.find(metric => metric.id === id), scope: entry.scope ?? {} }));
		const rules = Object.entries(profile.rules).map(([id, entry]) => {
			const check = CHECK_REGISTRY.find(check => check.id === entry.check);
			return { id, ...entry, registeredPhase: check?.phase, determinism: check?.determinism };
		});
		const result = { schemaVersion: 1, modelCalls: 0, profile, profileHash: policyProfileHash(profile), metrics, rules,
			structuralProposal: buildStructuralPolicyProposal(root, profile),
			limitations: ["Inspection executes no target code or detector. Profile references select installed contracts.",
				"Project report modes are report, warn and off. Structural-three adoption proposals use existing policy integrity."] };
		const summary = `${profile.id} ${metrics.length} metric targets and ${rules.length} detector selections`;
		output(getOutputMode(options), result, { short: () => summary,
			normal: () => [summary, ...metrics.map(row => `${row.id}  requested ${row.requestedMode}  report ${row.reportMode}  target ${row.reportingTarget ?? "absent"}`),
				`Structural proposal ${result.structuralProposal.state}`, ...result.limitations].join("\n"),
			full: () => JSON.stringify(result, null, 2) });
	} catch (error) { failure(options, error); }
}

function renderEvaluation(result: PolicyProfileEvaluation, full: boolean): string {
	const warnings = result.metricPolicies.filter(row => row.warning).length + result.rules.filter(row => row.warning).length;
	const lines = [`${result.profile.id}  ${result.measurements.metrics.length} retained metric readings  ${warnings} advisory selections`,
		`${result.scope.files} inventory inputs  ${result.actions.actions.length} evidence actions  no model calls`];
	for (const row of result.metricPolicies) lines.push(`${row.id.padEnd(28)} ${row.measurementState.padEnd(14)} ${row.mode.padEnd(6)} ${row.status}  reporting target ${row.reportingTarget ?? "absent"}`);
	for (const rule of result.rules) {
		lines.push(`${rule.id}  ${rule.check}  ${rule.state}  ${rule.findings.length} matches  ${rule.completedFiles}/${rule.selectedFiles} detector calls completed`);
		if (full) {
			for (const finding of rule.findings) lines.push(`  ${finding.file}:${finding.line} ${finding.text}`);
			for (const gap of rule.notMeasured) lines.push(`  Unmeasured ${gap}`);
		}
	}
	lines.push(`Structural proposal ${result.structuralProposal.state}`, ...result.scope.issues, ...result.limitations);
	if (full) for (const action of result.actions.actions) lines.push(`  ${action.file}:${action.line} ${action.classification} ${action.evidence.map(row => row.message).join(" | ")}`);
	return lines.join("\n");
}

export function metricsPoliciesEvaluateCommand(file: string | undefined, options: MetricsPoliciesOptions): void {
	try {
		const root = resolve(options.cwd ?? process.cwd());
		const profile = file ? readProfile(resolve(root, file)) : configuredProfile(root);
		const result = evaluatePolicyProfile(root, profile);
		output(getOutputMode(options), result, { normal: () => renderEvaluation(result, false), full: () => renderEvaluation(result, true),
			short: () => `${profile.id} ${result.metricPolicies.length} metric readings ${result.rules.length} detector selections ${result.actions.actions.length} evidence actions` });
	} catch (error) { failure(options, error); }
}
