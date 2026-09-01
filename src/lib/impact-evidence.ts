// ===========================================
// Evidence-classed local impact report
// ===========================================
// This report describes recorded facts. It never turns an estimate or an
// observed worktree delta into a causal claim.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BASELINE_FOLD_LOG_REL } from "../harness/baseline-autofold.js";
import { findingsCorpusPath, loadFindings } from "../harness/findings/corpus.js";
import {
	parseSimplificationRunReceipt,
	simplificationRunsPath,
	type SimplificationRunReceipt,
} from "../harness/findings/simplification-record.js";
import {
	loadReconciliation,
	reconciliationPath,
	reconciliationStateOf,
} from "../harness/spec/reconciliation.js";
import {
	parseSimplificationExperimentManifest,
	simplificationExperimentManifestSha256,
	type SimplificationExperimentCompletenessOutcome,
	type SimplificationExperimentManifest,
	type SimplificationExperimentSafetyOutcome,
} from "./simplification-agent-ci-experiment.js";
import { isJsonObject } from "./json-types.js";
import { readLocalSessions } from "./local-activity.js";
import { getSessionsDir } from "./local-activity-paths.js";
import {
	loadManualDebtMarkerSnapshotReceipts,
	manualDebtMarkerSnapshotsPath,
} from "./manual-debt-marker-record.js";
import {
	readDependencyDeltaEvidence,
	readGitWorktreeEvidence,
	type DependencyDeltaEvidence,
	type GitWorktreeEvidence,
} from "./impact-git-evidence.js";
import type {
	SimplificationDelta,
	SimplificationFinding,
	SimplificationScopeReceipt,
} from "./simplification-types.js";

type ImpactAvailability = "available" | "not-recorded" | "unavailable";

interface BaselineFoldKindEvidence {
	events: number;
	changed: number;
	refused: number;
}

interface BaselineFoldEvidence {
	availability: ImpactAvailability;
	evidence_class: "observed";
	events: number;
	malformed_rows: number;
	by_kind: Record<string, BaselineFoldKindEvidence>;
	scope: string;
	reason?: string | undefined;
}

interface ActivityEvidence {
	availability: ImpactAvailability;
	evidence_class: "observed";
	sessions: number;
	ended_sessions: number;
	tool_calls: number;
	errors: number;
	edit_events: number;
	lines_added: number;
	lines_removed: number;
	tokens: {
		input: number;
		output: number;
		cache_read: number;
		cache_creation: number;
	};
	scope: string;
}

interface FindingsEvidence {
	availability: ImpactAvailability;
	evidence_class: "observed";
	review_findings: number;
	reconciliation: { open: number; touched: number; acked: number };
	lifecycle: { candidate: number; approved: number; distilled: number; superseded: number };
	simplification: {
		findings: number;
		reconciliation: { open: number; touched: number; acked: number };
		lifecycle: { candidate: number; approved: number; distilled: number; superseded: number };
	};
	scope: string;
}

interface ManualDebtLifecycleEvidence {
	availability: ImpactAvailability;
	evidence_class: "observed";
	snapshot_count: number;
	transitions: {
		opened: number;
		changed: number;
		closed: number;
	};
	current_markers: number;
	path: string;
	latest_scope: {
		repository_root: string;
		tree_sha: string | null;
		roots: string[];
		files_scanned: number;
	} | null;
	scope: string;
	reason?: string | undefined;
}

interface SimplificationImpactRunScope {
	run_fingerprint: string;
	recorded_at: string;
	command: "scan" | "review" | "audit";
	tree_sha: string | null;
	scope: SimplificationScopeReceipt;
	coverage_status: "complete" | "partial" | "unavailable";
	finding_observations: number;
}

interface SimplificationReceiptEvidence {
	availability: ImpactAvailability;
	path: string;
	receipt_rows: number;
	valid_receipts: number;
	malformed_receipts: number;
	run_count: number;
	finding_observations: number;
	latest_finding_count: number;
	scopes: SimplificationImpactRunScope[];
	reason?: string | undefined;
}

export interface SimplificationImpactAggregate {
	available: boolean;
	availability: ImpactAvailability;
	representative_findings: number;
	overlap_groups_represented: number;
	representative_fingerprints: string[];
	loc_delta: number | null;
	loc_known_findings: number;
	loc_unknown_findings: number;
	dependencies_removed: string[];
	scope: string;
	note: string;
}

interface PotentialImpactEvidence extends SimplificationImpactAggregate {
	evidence_class: "potential";
}

interface SandboxValidatedImpactEvidence extends SimplificationImpactAggregate {
	evidence_class: "sandbox-validated";
	eligible_validated_findings: number;
}

export interface CausalImpactEvidence {
	evidence_class: "causal";
	available: boolean;
	availability: ImpactAvailability;
	manifest_path: string | null;
	manifest_sha256: string | null;
	artifacts_verified: boolean;
	experiment_id: string | null;
	claim_statement: string | null;
	safety: SimplificationExperimentSafetyOutcome | null;
	completeness: SimplificationExperimentCompletenessOutcome | null;
	scope: string;
	note: string;
}

export interface ImpactEvidenceReport {
	schema_version: 1;
	base: string;
	claim_boundary: string;
	simplification_receipts: SimplificationReceiptEvidence;
	evidence: {
		potential: PotentialImpactEvidence;
		sandbox_validated: SandboxValidatedImpactEvidence;
		observed: {
			evidence_class: "observed";
			sources: {
				git_worktree: GitWorktreeEvidence;
				dependencies: DependencyDeltaEvidence;
				baseline_folds: BaselineFoldEvidence;
				activity: ActivityEvidence;
				findings: FindingsEvidence;
				manual_debt: ManualDebtLifecycleEvidence;
			};
		};
		causal: CausalImpactEvidence;
	};
}

export interface BuildImpactEvidenceOptions {
	base?: string | undefined;
	experimentManifest?: string | undefined;
}

interface ParsedSimplificationReceipts {
	evidence: SimplificationReceiptEvidence;
	receipts: SimplificationRunReceipt[];
	latest: SimplificationFinding[];
}

function emptyFoldEvidence(availability: ImpactAvailability, reason?: string): BaselineFoldEvidence {
	return {
		availability,
		evidence_class: "observed",
		events: 0,
		malformed_rows: 0,
		by_kind: {},
		scope: "append-only SessionEnd tighten-only baseline fold audit rows",
		...(reason ? { reason } : {}),
	};
}

function foldNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readBaselineFoldEvidence(cwd: string): BaselineFoldEvidence {
	const path = join(cwd, BASELINE_FOLD_LOG_REL);
	if (!existsSync(path)) return emptyFoldEvidence("not-recorded");
	const result = emptyFoldEvidence("available");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return emptyFoldEvidence("unavailable", error instanceof Error ? error.message : String(error));
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isJsonObject(parsed) || typeof parsed.kind !== "string") {
				result.malformed_rows++;
				continue;
			}
			const row = result.by_kind[parsed.kind] ?? { events: 0, changed: 0, refused: 0 };
			row.events++;
			row.changed += foldNumber(parsed.changed);
			row.refused += foldNumber(parsed.refused);
			result.by_kind[parsed.kind] = row;
			result.events++;
		} catch {
			result.malformed_rows++;
		}
	}
	return result;
}

function safeCount(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readActivityEvidence(cwd: string): ActivityEvidence {
	const sessions = readLocalSessions(cwd);
	const totals: ActivityEvidence = {
		availability: existsSync(getSessionsDir(cwd)) ? "available" : "not-recorded",
		evidence_class: "observed",
		sessions: sessions.length,
		ended_sessions: 0,
		tool_calls: 0,
		errors: 0,
		edit_events: 0,
		lines_added: 0,
		lines_removed: 0,
		tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
		scope: "retained local session summaries; edit rows are gross events and may overlap git deltas",
	};
	for (const session of sessions) {
		if (session.phase === "ENDED") totals.ended_sessions++;
		totals.tool_calls += safeCount(session.tool_count);
		totals.errors += safeCount(session.error_count);
		const edits = session.edits ?? [];
		totals.edit_events += edits.length;
		for (const edit of edits) {
			totals.lines_added += safeCount(edit.lines_added);
			totals.lines_removed += safeCount(edit.lines_removed);
		}
		totals.tokens.input += safeCount(session.tokens_total?.input);
		totals.tokens.output += safeCount(session.tokens_total?.output);
		totals.tokens.cache_read += safeCount(session.tokens_total?.cache_read);
		totals.tokens.cache_creation += safeCount(session.tokens_total?.cache_creation);
	}
	return totals;
}

function readFindingsEvidence(cwd: string): FindingsEvidence {
	const corpus = loadFindings(cwd);
	const rows = corpus.filter((finding) => finding.bug_class.startsWith("review_"));
	const simplificationRows = corpus.filter(
		(finding) => finding.extensions?.simplification !== undefined,
	);
	const reconciliation = loadReconciliation(cwd);
	const result: FindingsEvidence = {
		availability:
			existsSync(findingsCorpusPath(cwd)) || existsSync(reconciliationPath(cwd))
				? "available"
				: "not-recorded",
		evidence_class: "observed",
		review_findings: rows.length,
		reconciliation: { open: 0, touched: 0, acked: 0 },
		lifecycle: { candidate: 0, approved: 0, distilled: 0, superseded: 0 },
		simplification: {
			findings: simplificationRows.length,
			reconciliation: { open: 0, touched: 0, acked: 0 },
			lifecycle: { candidate: 0, approved: 0, distilled: 0, superseded: 0 },
		},
		scope: "review and simplification finding workflow states; touched and acked are lifecycle facts, not proof that a defect or simplification was fixed",
	};
	for (const finding of rows) {
		result.reconciliation[reconciliationStateOf(reconciliation, finding.id)]++;
		result.lifecycle[finding.status]++;
	}
	for (const finding of simplificationRows) {
		result.simplification.reconciliation[
			reconciliationStateOf(reconciliation, finding.id)
		]++;
		result.simplification.lifecycle[finding.status]++;
	}
	return result;
}

function readManualDebtLifecycleEvidence(cwd: string): ManualDebtLifecycleEvidence {
	const path = manualDebtMarkerSnapshotsPath(cwd);
	const snapshots = loadManualDebtMarkerSnapshotReceipts(cwd);
	const latest = snapshots.at(-1) ?? null;
	const transitions = { opened: 0, changed: 0, closed: 0 };
	for (const snapshot of snapshots) {
		for (const transition of snapshot.transitions) transitions[transition.action]++;
	}
	const fileExists = existsSync(path);
	return {
		availability: snapshots.length > 0 ? "available" : fileExists ? "unavailable" : "not-recorded",
		evidence_class: "observed",
		snapshot_count: snapshots.length,
		transitions,
		current_markers: latest?.materialized_markers.length ?? 0,
		path,
		latest_scope: latest
			? {
				repository_root: latest.scan.repository.root,
				tree_sha: latest.scan.repository.tree_sha,
				roots: [...latest.scan.coverage.roots],
				files_scanned: latest.scan.coverage.files_scanned,
			}
			: null,
		scope: "Valid append-only manual debt marker snapshots; transition totals span retained snapshots and current marker count comes from the latest scope-aware materialized state.",
		...(snapshots.length === 0
			? { reason: fileExists ? "No valid manual debt marker snapshot is readable." : "No manual debt marker snapshot is recorded." }
			: {}),
	};
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

function readSimplificationReceipts(cwd: string): ParsedSimplificationReceipts {
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

function potentialEvidence(receipts: ParsedSimplificationReceipts): PotentialImpactEvidence {
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

function sandboxValidatedEvidence(
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

function unavailableCausal(
	availability: ImpactAvailability,
	manifestPath: string | null,
	note: string,
): CausalImpactEvidence {
	return {
		evidence_class: "causal",
		available: false,
		availability,
		manifest_path: manifestPath,
		manifest_sha256: null,
		artifacts_verified: false,
		experiment_id: null,
		claim_statement: null,
		safety: null,
		completeness: null,
		scope: "Causal attribution requires a schema-valid pinned controlled-experiment manifest.",
		note,
	};
}

interface CausalArtifactRef {
	label: string;
	path: string;
	sha256: string;
}

function causalArtifactRefs(manifest: SimplificationExperimentManifest): CausalArtifactRef[] {
	return [
		{
			label: "raw results",
			path: manifest.outcomes.raw_results_path,
			sha256: manifest.outcomes.raw_results_sha256,
		},
		{
			label: "analysis output",
			path: manifest.outcomes.analysis_output_path,
			sha256: manifest.outcomes.analysis_output_sha256,
		},
		{
			label: "safety receipt",
			path: manifest.outcomes.safety.receipt_path,
			sha256: manifest.outcomes.safety.receipt_sha256,
		},
		{
			label: "completeness coverage",
			path: manifest.outcomes.completeness.coverage_path,
			sha256: manifest.outcomes.completeness.coverage_sha256,
		},
	];
}

function verifyCausalArtifacts(
	manifestPath: string,
	manifest: SimplificationExperimentManifest,
): string | null {
	const base = dirname(manifestPath);
	for (const artifact of causalArtifactRefs(manifest)) {
		const path = resolve(base, artifact.path);
		let bytes: Buffer;
		try {
			bytes = readFileSync(path);
		} catch {
			return `${artifact.label} artifact is unreadable: ${artifact.path}`;
		}
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== artifact.sha256) {
			return `${artifact.label} artifact hash does not match: ${artifact.path}`;
		}
	}
	return null;
}

function readCausalEvidence(cwd: string, manifestPath: string | undefined): CausalImpactEvidence {
	if (manifestPath === undefined) {
		return unavailableCausal(
			"not-recorded",
			null,
			"No controlled-experiment manifest was supplied.",
		);
	}
	const path = isAbsolute(manifestPath) ? manifestPath : resolve(cwd, manifestPath);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`Explicit experiment manifest is unreadable: ${path}`, { cause: error });
	}
	let input: unknown;
	try {
		input = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return unavailableCausal("unavailable", path, `Experiment manifest is not valid JSON: ${detail}`);
	}
	const parsed = parseSimplificationExperimentManifest(input);
	if (!parsed.ok) {
		return unavailableCausal("unavailable", path, `Experiment manifest rejected: ${parsed.reason}`);
	}
	if (parsed.manifest.claim.kind !== "causal") {
		return unavailableCausal(
			"unavailable",
			path,
			"Experiment manifest claim.kind is observational; causal evidence requires claim.kind=causal.",
		);
	}
	const manifest = parsed.manifest;
	const artifactFailure = verifyCausalArtifacts(path, manifest);
	if (artifactFailure !== null) {
		return {
			...unavailableCausal("unavailable", path, artifactFailure),
			manifest_sha256: simplificationExperimentManifestSha256(manifest),
			experiment_id: manifest.experiment_id,
			safety: manifest.outcomes.safety,
			completeness: manifest.outcomes.completeness,
		};
	}
	return {
		evidence_class: "causal",
		available: true,
		availability: "available",
		manifest_path: path,
		manifest_sha256: simplificationExperimentManifestSha256(manifest),
		artifacts_verified: true,
		experiment_id: manifest.experiment_id,
		claim_statement: manifest.claim.statement,
		safety: manifest.outcomes.safety,
		completeness: manifest.outcomes.completeness,
		scope: `${manifest.repository.repository_id}@${manifest.repository.tree_sha}; ${manifest.task_suite.name}@${manifest.task_suite.version}; ${manifest.runs.sample_size} experimental unit(s); ${manifest.model.provider}/${manifest.model.model}@${manifest.model.version}`,
		note: "Causal class is available only for the claim and pinned scope declared by this controlled-experiment manifest; raw, analysis, safety, and completeness artifacts matched their declared SHA-256 digests.",
	};
}

function normalizeBuildOptions(
	baseOrOptions: string | BuildImpactEvidenceOptions,
): { base: string; experimentManifest: string | undefined } {
	return typeof baseOrOptions === "string"
		? { base: baseOrOptions, experimentManifest: undefined }
		: { base: baseOrOptions.base ?? "HEAD", experimentManifest: baseOrOptions.experimentManifest };
}

export function buildImpactEvidence(
	cwd: string,
	baseOrOptions: string | BuildImpactEvidenceOptions = "HEAD",
): ImpactEvidenceReport {
	const options = normalizeBuildOptions(baseOrOptions);
	const gitWorktree = readGitWorktreeEvidence(cwd, options.base);
	const dependencies = readDependencyDeltaEvidence(cwd, gitWorktree.resolved_base);
	const simplificationReceipts = readSimplificationReceipts(cwd);
	return {
		schema_version: 1,
		base: options.base,
		claim_boundary:
			"Potential, Sandbox-validated candidate, observed repository change, and controlled causal evidence are distinct classes; none substitutes for another.",
		simplification_receipts: simplificationReceipts.evidence,
		evidence: {
			potential: potentialEvidence(simplificationReceipts),
			sandbox_validated: sandboxValidatedEvidence(simplificationReceipts),
			observed: {
				evidence_class: "observed",
				sources: {
					git_worktree: gitWorktree,
					dependencies,
					baseline_folds: readBaselineFoldEvidence(cwd),
					activity: readActivityEvidence(cwd),
					findings: readFindingsEvidence(cwd),
					manual_debt: readManualDebtLifecycleEvidence(cwd),
				},
			},
			causal: readCausalEvidence(cwd, options.experimentManifest),
		},
	};
}
