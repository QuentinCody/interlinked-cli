import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasErrorCode } from "../../harness/check-engine/tool-errors.js";
import { detectMetricPolicyLoosening } from "../../harness/evaluator/metric-policy-integrity.js";
import { parseWaterLineJson } from "../../harness/water-line-json.js";
import { isJsonObject } from "../json-types.js";
import { isCheckPolicyFile } from "../../harness/check-policy-values.js";
import { structuralPolicyId, type PolicyProfile } from "./profile.js";

export interface StructuralPolicyProposal {
	state: "none" | "reviewable" | "would-weaken" | "unavailable";
	target: ".interlinked/check-policy.json";
	document: Record<string, unknown> | null;
	omittedMetrics: string[];
	findings: string[];
}

/** Build ordinary existing configuration as review material. This function performs no writes. */
export function buildStructuralPolicyProposal(root: string, profile: PolicyProfile): StructuralPolicyProposal {
	const result: StructuralPolicyProposal = { state: "none", target: ".interlinked/check-policy.json", document: null,
		omittedMetrics: [], findings: [] };
	const metrics: Record<string, unknown> = {};
	for (const [id, entry] of Object.entries(profile.metrics)) {
		const key = structuralPolicyId(id);
		if (key) metrics[key] = entry;
		else result.omittedMetrics.push(id);
	}
	if (!Object.keys(metrics).length) return result;
	const path = join(root, result.target);
	let before: string | null = null;
	try { before = readFileSync(path, "utf8"); }
	catch (error) {
		if (!hasErrorCode(error, "ENOENT")) return { ...result, state: "unavailable", findings: ["Current policy could not be read"] };
	}
	const parsed = before === null ? { ok: true as const, value: {}, duplicateKeys: [] } : parseWaterLineJson(before);
	if (!parsed.ok || !isJsonObject(parsed.value) || !isCheckPolicyFile(parsed.value) || parsed.duplicateKeys.length || parsed.value.metrics !== undefined && !isJsonObject(parsed.value.metrics)) {
		return { ...result, state: "unavailable", findings: ["Current policy needs an unambiguous JSON object before a proposal can preserve its fields"] };
	}
	const currentMetrics = isJsonObject(parsed.value.metrics) ? parsed.value.metrics : {};
	const document = { ...parsed.value, metrics: { ...currentMetrics, ...metrics } };
	const findings = detectMetricPolicyLoosening(path, before, JSON.stringify(document), { root }).map(finding => `[${finding.rule}] ${finding.message}`);
	return { ...result, state: findings.length ? "would-weaken" : "reviewable", document, findings };
}
