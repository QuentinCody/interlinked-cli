import { wireArray, wireLiteral, wireObject, wireString } from "../value-validation.js";
import { dispositionDirection, FINDING_DISPOSITIONS, type FindingDisposition } from "./finding-contracts.js";
import { parseFindingRun, type FindingRun } from "./finding-assessment.js";
import type { FindingBundle } from "./finding-evidence.js";
import { digest } from "./store.js";

export interface FindingLabel { caseId: string; acceptable: FindingDisposition[]; rationale: string; evidenceIds: string[]; }
export interface FindingLabels { bundleId: string; reviewer: string; labels: FindingLabel[]; }
const labelShape = wireObject<FindingLabel>({ caseId: wireString, acceptable: wireArray(wireLiteral(...FINDING_DISPOSITIONS)), rationale: wireString, evidenceIds: wireArray(wireString) });
const labelsShape = wireObject<FindingLabels>({ bundleId: wireString, reviewer: wireString, labels: wireArray(labelShape) });

/** A blind template uses only the bundle, never model predictions. */
export function findingLabelTemplate(bundle: FindingBundle): FindingLabels {
	return { bundleId: bundle.id, reviewer: "", labels: bundle.packets.map(packet => ({ caseId: packet.caseId, acceptable: [], rationale: "", evidenceIds: packet.evidence.map(row => row.id) })) };
}

export function parseFindingLabels(value: unknown): FindingLabels {
	if (!labelsShape(value) || !value.reviewer.trim()) throw new Error("Invalid reviewer labels");
	if (new Set(value.labels.map(row => row.caseId)).size !== value.labels.length) throw new Error("Duplicate reference label");
	for (const row of value.labels) {
		if (!row.acceptable.length || !row.rationale.trim()) throw new Error("Every reference label needs an acceptable outcome and rationale");
		if (!row.evidenceIds.length && !row.acceptable.includes("insufficient_evidence")) throw new Error("Decisive labels require evidence citations");
	}
	return value;
}

/** Distribution concentration is retained for inspection, never treated as reference accuracy. */
export function compareFindingDecision(choice: FindingDisposition, acceptable: FindingDisposition[]): string {
	if (acceptable.includes(choice)) return "aligned";
	const direction = dispositionDirection(choice), expected = acceptable.map(dispositionDirection);
	if (direction === "unknown" || expected.includes("unknown")) return "uncertain";
	return expected.includes(direction) ? "aligned_direction_different_reason" : "disagreement";
}

export function reviewFindings(run: FindingRun, labels: FindingLabels) {
	parseFindingRun(run);
	parseFindingLabels(labels);
	if (labels.bundleId !== run.bundle.id || labels.labels.length !== run.records.length) throw new Error("Labels must cover exactly this frozen bundle");
	const rows = run.records.map((record, index) => {
		const packet = run.bundle.packets[index]!, reference = labels.labels.find(row => row.caseId === record.caseId);
		if (!reference || reference.evidenceIds.some(id => !packet.evidence.some(row => row.id === id))) throw new Error("Missing label or invalid evidence citation");
		const answer = record.response?.answers.disposition;
		const choice = answer?.type === "choice" && FINDING_DISPOSITIONS.find(option => option === answer.choice);
		return { caseId: record.caseId, family: packet.family, status: record.status, reason: record.reason, comparison: record.status === "answered" && choice ? compareFindingDecision(choice, reference.acceptable) : "unassessed", choice: choice || null, probabilities: answer?.type === "choice" ? answer.probabilities : null, confidence: answer?.type === "choice" ? answer.confidence : null, reference };
	});
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.comparison] = (counts[row.comparison] ?? 0) + 1;
	return { schema: "interlinked.finding-review/1", runId: run.id, bundleId: run.bundle.id, labelsId: digest(labels), reviewer: labels.reviewer, referenceKind: "reviewer judgment, not independent ground truth", population: rows.length, counts, rows };
}
