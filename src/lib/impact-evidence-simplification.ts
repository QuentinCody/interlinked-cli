// ===========================================
// Evidence-classed local impact report — simplification receipts
// ===========================================
// Reads the append-only simplification run receipt stream and aggregates the
// latest reconciled observations into the potential and sandbox-validated
// evidence classes. A candidate is never implied to be accepted or applied.

import { existsSync, readFileSync } from "node:fs";
import {
	parseSimplificationRunReceipt,
	simplificationRunsPath,
	type SimplificationRunReceipt,
} from "../harness/findings/simplification-record.js";
import type {
	PotentialImpactEvidence,
	SandboxValidatedImpactEvidence,
	SimplificationImpactAggregate,
	SimplificationImpactRunScope,
	SimplificationReceiptEvidence,
} from "./impact-evidence-types.js";
import type {
	SimplificationDelta,
	SimplificationFinding,
} from "./simplification-types.js";

export interface ParsedSimplificationReceipts {
	evidence: SimplificationReceiptEvidence;
	receipts: SimplificationRunReceipt[];
	latest: SimplificationFinding[];
}

function runScope(receipt: SimplificationRunReceipt): SimplificationImpactRunScope {
	return {
		run_fingerprint: receipt.run_fingerprint,
		recorded_at: receipt.recorded_at,
		command: receipt.report.command,
		tree_sha: receipt.report.repository.tree_sha,
		scope: receipt.report.scope,
		coverage_status: receipt.report.coverage.status,
		finding_observations: receipt.report.findings.length,
	};
}

function receiptAvailability(
	validReceipts: number,
	receiptRows: number,
): Pick<SimplificationReceiptEvidence, "availability" | "reason"> {
	if (validReceipts > 0) return { availability: "available" };
	if (receiptRows > 0) {
		return {
			availability: "unavailable",
			reason: "The simplification receipt stream contains no schema-valid, hash-bound run receipt.",
		};
	}
	return {
		availability: "not-recorded",
		reason: "No recorded simplification run receipt is available.",
	};
}

function reconcileAuthoritativeSimplificationScope(
	latestByFingerprint: Map<string, SimplificationFinding>,
	report: SimplificationRunReceipt["report"],
): void {
	if (report.coverage.status !== "complete") return;
	if (report.scope.kind === "repository" && report.scope.selected_paths === null) {
		latestByFingerprint.clear();
		return;
	}
	if (report.scope.selected_paths === null) return;
	const authoritativePaths = new Set(report.scope.selected_paths);
	for (const [fingerprint, prior] of latestByFingerprint) {
		if (authoritativePaths.has(prior.location.path)) latestByFingerprint.delete(fingerprint);
	}
}

interface ParsedSimplificationReceiptLines {
	receipts: SimplificationRunReceipt[];
	receiptRows: number;
	malformedReceipts: number;
}

function parseSimplificationReceiptLines(content: string): ParsedSimplificationReceiptLines {
	const receipts: SimplificationRunReceipt[] = [];
	let receiptRows = 0;
	let malformedReceipts = 0;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		receiptRows++;
		try {
			const receipt = parseSimplificationRunReceipt(JSON.parse(line));
			if (receipt) receipts.push(receipt);
			else malformedReceipts++;
		} catch {
			malformedReceipts++;
		}
	}
	return { receipts, receiptRows, malformedReceipts };
}

export function readSimplificationReceipts(cwd: string): ParsedSimplificationReceipts {
	const path = simplificationRunsPath(cwd);
	const baseEvidence: SimplificationReceiptEvidence = {
		availability: "not-recorded",
		path,
		receipt_rows: 0,
		valid_receipts: 0,
		malformed_receipts: 0,
		run_count: 0,
		finding_observations: 0,
		latest_finding_count: 0,
		scopes: [],
		reason: "No recorded simplification run receipt is available.",
	};
	if (!existsSync(path)) return { evidence: baseEvidence, receipts: [], latest: [] };
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		return {
			evidence: {
				...baseEvidence,
				availability: "unavailable",
				reason: error instanceof Error ? error.message : String(error),
			},
			receipts: [],
			latest: [],
		};
	}
	const { receipts, receiptRows, malformedReceipts } = parseSimplificationReceiptLines(content);
	const latestByFingerprint = new Map<string, SimplificationFinding>();
	let findingObservations = 0;
	for (const receipt of receipts) {
		reconcileAuthoritativeSimplificationScope(latestByFingerprint, receipt.report);
		for (const finding of receipt.report.findings) {
			latestByFingerprint.set(finding.fingerprint, finding);
			findingObservations++;
		}
	}
	const availability = receiptAvailability(receipts.length, receiptRows);
	return {
		evidence: {
			availability: availability.availability,
			path,
			receipt_rows: receiptRows,
			valid_receipts: receipts.length,
			malformed_receipts: malformedReceipts,
			run_count: receipts.length,
			finding_observations: findingObservations,
			latest_finding_count: latestByFingerprint.size,
			scopes: receipts.map(runScope),
			...(availability.reason ? { reason: availability.reason } : {}),
		},
		receipts,
		latest: [...latestByFingerprint.values()],
	};
}

function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function compareRepresentativeStrength<Finding extends SimplificationFinding>(
	left: Finding,
	right: Finding,
	deltaOf: (finding: Finding) => SimplificationDelta,
): number {
	const leftDelta = deltaOf(left);
	const rightDelta = deltaOf(right);
	const leftLocKnown = leftDelta.loc === null ? 0 : 1;
	const rightLocKnown = rightDelta.loc === null ? 0 : 1;
	return rightLocKnown - leftLocKnown
		|| Math.abs(rightDelta.loc ?? 0) - Math.abs(leftDelta.loc ?? 0)
		|| rightDelta.dependencies_removed.length - leftDelta.dependencies_removed.length
		|| right.confidence - left.confidence
		|| compareCodeUnits(left.fingerprint, right.fingerprint);
}

function selectOverlapRepresentatives<Finding extends SimplificationFinding>(
	findings: Finding[],
	deltaOf: (finding: Finding) => SimplificationDelta,
): Finding[] {
	const selected: Finding[] = [];
	const usedGroups = new Set<string>();
	for (const finding of [...findings].sort((left, right) =>
		compareRepresentativeStrength(left, right, deltaOf))) {
		const group = finding.overlap_group;
		if (group !== null && usedGroups.has(group)) continue;
		selected.push(finding);
		if (group !== null) usedGroups.add(group);
	}
	return selected;
}

function aggregateDeltas<Finding extends SimplificationFinding>(
	findings: Finding[],
	deltaOf: (finding: Finding) => SimplificationDelta,
): Omit<
	SimplificationImpactAggregate,
	"available" | "availability" | "scope" | "note"
> {
	const representatives = selectOverlapRepresentatives(findings, deltaOf);
	const dependencies = new Set<string>();
	let locDelta = 0;
	let locKnown = 0;
	let locUnknown = 0;
	const groups = new Set<string>();
	for (const finding of representatives) {
		const delta = deltaOf(finding);
		for (const dependency of delta.dependencies_removed) dependencies.add(dependency);
		if (delta.loc === null) locUnknown++;
		else {
			locDelta += delta.loc;
			locKnown++;
		}
		if (finding.overlap_group !== null) groups.add(finding.overlap_group);
	}
	return {
		representative_findings: representatives.length,
		overlap_groups_represented: groups.size,
		representative_fingerprints: representatives.map((finding) => finding.fingerprint),
		loc_delta: locUnknown === 0 ? locDelta : null,
		loc_known_findings: locKnown,
		loc_unknown_findings: locUnknown,
		dependencies_removed: [...dependencies].sort(compareCodeUnits),
	};
}

export function potentialEvidence(
	receipts: ParsedSimplificationReceipts,
): PotentialImpactEvidence {
	const aggregate = aggregateDeltas(receipts.latest, (finding) => finding.impact.estimated);
	const available = receipts.evidence.availability === "available";
	return {
		evidence_class: "potential",
		available,
		availability: receipts.evidence.availability,
		...aggregate,
		loc_delta: available ? aggregate.loc_delta : null,
		scope: "Latest valid observations reconciled by complete repository or selected-path coverage; strongest recorded delta per non-null overlap group (known absolute LOC, dependency count, confidence, then fingerprint); null groups remain independent.",
		note: available
			? "Estimated advisory deltas from recorded simplification findings; candidates are not accepted changes."
			: receipts.evidence.reason ?? "Potential impact is not recorded.",
	};
}

function sandboxEligible(finding: SimplificationFinding): finding is SimplificationFinding & {
	impact: SimplificationFinding["impact"] & { validated: SimplificationDelta };
} {
	return finding.validation.status === "passed" &&
		finding.validation.executor === "sandbox" &&
		finding.impact.validated !== null;
}

export function sandboxValidatedEvidence(
	receipts: ParsedSimplificationReceipts,
): SandboxValidatedImpactEvidence {
	const eligible = receipts.latest.filter(sandboxEligible);
	const aggregate = aggregateDeltas(eligible, (finding) => finding.impact.validated);
	const available = eligible.length > 0;
	return {
		evidence_class: "sandbox-validated",
		available,
		availability: available
			? "available"
			: receipts.evidence.availability === "unavailable"
				? "unavailable"
				: "not-recorded",
		eligible_validated_findings: eligible.length,
		...aggregate,
		loc_delta: available ? aggregate.loc_delta : null,
		scope: "Latest valid appended observations that carry passed Sandbox validation and exact non-null validated deltas; overlap representatives are selected after this gate.",
		note: available
			? "Exact candidate-patch deltas validated in a Sandbox; no candidate is implied to be accepted or applied."
			: "No latest recorded finding has passed Sandbox validation with an exact validated delta.",
	};
}
