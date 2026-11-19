import { buildActionInventory, type ActionInventory, type ActionObservation } from "../action-inventory.js";
import type { CompositeScoreReport } from "./composite-report.js";
import type { MetricsScoreReport } from "./score-report.js";
import { interpolateBurden } from "./score-profile.js";

export type CompositeActionInput = Pick<CompositeScoreReport,
	"findings" | "metrics" | "deletionCandidates" | "sourceHash" | "rulesHash" | "registryHash" | "evidenceIssues">
	& { scope: Pick<CompositeScoreReport["scope"], "notMeasured" | "discoveryIssues"> };

const LIMITATIONS = [
	"Actions reuse retained measurements; this projection runs no analyzer, target code or model.",
	"Experimental profile burden and detector matches are review opportunities, not adopted policy violations or confirmed defects.",
	"Repository-wide measurements are not localized defects; inspect their raw scope, limitations and evidence before changing code.",
];

function metricAdvice(metric: string): { nextStep: string; validation: string } {
	if (metric.startsWith("coverage") || metric.startsWith("mutation") || metric.startsWith("tests.")) return {
		nextStep: "Inspect current behavioral evidence and add meaningful tests for the named paths; establish source freshness before interpreting missing or surviving results.",
		validation: "Run the affected tests and refresh source-matched coverage or mutation evidence before remeasuring.",
	};
	if (metric.startsWith("architecture")) return {
		nextStep: "Inspect the reported import edges, entry points and boundaries; check dynamic and external consumers before changing dependencies.",
		validation: "Rebuild the dependency graph and run integration tests for the affected boundary.",
	};
	if (metric.startsWith("redundancy")) return {
		nextStep: "Inspect reachability and public or dynamic consumers before proposing removal; confirm the reported repetition or unused path in context.",
		validation: "Verify affected consumers, run behavioral tests and compare the refreshed static evidence.",
	};
	if (metric.startsWith("types") || metric.startsWith("correctness") || metric.startsWith("contracts")) return {
		nextStep: "Review the claim against the implementation, types, callers and intended contract; distinguish a supported exception from a defect before editing.",
		validation: "Typecheck the affected project and test the specific behavioral claim, then rerun the relevant detector.",
	};
	return { nextStep: "Inspect the measured responsibilities and branches; change the design only where it improves understanding or behavior, not solely to lower the profile score.",
		validation: "Run affected behavioral tests and remeasure the same metric on the changed source." };
}

function deletionKey(candidate: CompositeActionInput["deletionCandidates"][number]): string {
	return JSON.stringify(["deletion_review", candidate.file, candidate.line]);
}

/** The report already joins these findings into a removal review; preserve that explicit relationship. */
function deletionLinks(candidates: CompositeActionInput["deletionCandidates"]): Map<string, string> {
	const links = new Map<string, string>();
	for (const candidate of candidates) for (const id of candidate.evidenceIds) {
		links.set(JSON.stringify([id, candidate.file, candidate.line, candidate.sourceSha256]),
			deletionKey(candidate));
	}
	return links;
}

function* metricObservations(report: CompositeActionInput): Generator<ActionObservation> {
	for (const metric of report.metrics) {
		if (metric.state === "not-applicable") continue;
		const missing = metric.state !== "measured";
		if (!missing && !(metric.score !== null && metric.score > 0)) continue;
		yield { policyHash: report.rulesHash, detectorHash: report.registryHash, check: metric.id, file: "<repository>", line: 0,
			sourceHash: report.sourceHash, classification: missing ? "evidence_gap" : "measurement", evidence: "proven",
			message: `${metric.id}: ${metric.state}; value ${metric.value ?? "unavailable"}, profile burden ${metric.score ?? "unavailable"}; ${metric.measuredEntities}/${metric.eligibleEntities} entities measured. ${metric.limitations.join(" ")}`,
			evidenceRefs: metric.evidenceIds, ...metricAdvice(metric.id),
		};
	}
}

/** Complete projection of an existing composite report; never recollect source or evidence. */
export function compositeScoreActions(report: CompositeActionInput): ActionInventory {
	const rows: ActionObservation[] = [];
	const provenance = { policyHash: report.rulesHash, detectorHash: report.registryHash };
	const links = deletionLinks(report.deletionCandidates);
	for (const finding of report.findings) {
		const actionKey = links.get(JSON.stringify([finding.id, finding.file, finding.line, finding.sourceSha256]));
		rows.push({ ...provenance, ...(actionKey ? { actionKey } : {}),
		check: finding.metric, file: finding.file, line: finding.line, endLine: finding.endLine, subject: finding.message,
		message: finding.message, classification: "candidate", evidence: finding.evidence,
		sourceHash: finding.sourceSha256, evidenceRefs: [finding.id], relatedLocations: finding.related,
		...metricAdvice(finding.metric),
		});
	}
	for (const row of metricObservations(report)) rows.push(row);
	for (const candidate of report.deletionCandidates) rows.push({ ...provenance,
		actionKey: deletionKey(candidate),
		check: "deletion_review", file: candidate.file, line: candidate.line, endLine: candidate.endLine, classification: "candidate", evidence: "heuristic",
		sourceHash: candidate.sourceSha256, evidenceRefs: [candidate.id, ...candidate.evidenceIds],
		message: `${candidate.signals.join("; ")}. Review blockers: ${candidate.blockers.length ? candidate.blockers.join("; ") : "none retained; review still required"}.`,
		...metricAdvice("redundancy"),
	});
	for (const gap of report.scope.notMeasured) rows.push({ ...provenance, check: "source_measurement", file: gap.path,
		line: 0, classification: "evidence_gap", evidence: "proven", sourceHash: null, message: gap.reason,
		nextStep: "Resolve source access or adapter support and confirm that this source belongs in the selected measurement scope.",
		validation: "Rerun the inventory and confirm this file is measured or explicitly excluded by reviewed policy.",
	});
	for (const issue of [...report.scope.discoveryIssues, ...report.evidenceIssues]) rows.push({ ...provenance,
		check: "measurement_evidence", file: "<repository>", line: 0, subject: issue, message: issue,
		classification: "evidence_gap", evidence: "proven", sourceHash: report.sourceHash,
		nextStep: "Resolve the reported discovery or evidence problem before drawing a repository-wide conclusion.",
		validation: "Repeat the same measurement and verify that the evidence gap is resolved with current source identity.",
	});
	return buildActionInventory(rows, LIMITATIONS);
}

/** Structural actions use the selected profile's existing normalization, not enforcement caps. */
export function structuralScoreActions(report: MetricsScoreReport): ActionInventory {
	const rows: ActionObservation[] = [];
	const provenance = { policyHash: report.rulesHash, detectorHash: report.profileHash };
	for (const file of report.files) for (const fn of file.functions) {
		for (const { id: metric } of report.metrics) {
			if (metric === "difficulty" && fn.volume < report.profile.halsteadVolumeFloor) continue;
			const burden = interpolateBurden(fn[metric], report.profile.metrics[metric].knots);
			if (burden <= 0) continue;
			rows.push({ ...provenance, check: metric, file: file.file, line: fn.line, endLine: fn.endLine,
				startOffset: fn.startOffset, endOffset: fn.endOffset, subject: fn.name,
				classification: "measurement", evidence: "proven", sourceHash: file.sha256,
				message: `${fn.name}: ${metric} ${fn[metric]}; positive burden under ${report.profile.id}. This is not an enforcement threshold.`,
				...metricAdvice(metric),
			});
		}
	}
	for (const gap of report.scope.notMeasured) rows.push({ ...provenance, check: "source_measurement",
		file: gap.file, line: 0, sourceHash: null, message: gap.reason, classification: "evidence_gap", evidence: "proven",
		nextStep: "Inspect source availability and the selected profile's supported languages before drawing conclusions.",
		validation: "Remeasure this file with a supported adapter or record an explicit scope exclusion.",
	});
	for (const gap of [...report.scope.discoveryIssues, ...report.unavailable]) rows.push({ ...provenance,
		check: "profile_coverage", file: "<repository>", line: 0, subject: gap, sourceHash: report.sourceHash,
		message: gap, classification: "evidence_gap", evidence: "proven",
		nextStep: "Use a profile or evidence source that supports this dimension; the structural profile cannot assess it.",
		validation: "Inspect the new report's scope and source identity; do not treat unavailable measurements as zero burden.",
	});
	return buildActionInventory(rows, LIMITATIONS);
}
