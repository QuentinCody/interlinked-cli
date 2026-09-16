// ===========================================
// `interlinked simplify` — read-only-by-default simplification evidence
// ===========================================
// Local execution composes existing deterministic scanners. Their output is
// advisory: repeatable static evidence is not proof that behavior can safely
// disappear. `--record` persists evidence only; it never changes source or a
// branch. Semantic review and patch validation belong to Agent CI.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	loadSimplificationRecordedStatus,
	recordSimplificationReport,
	type SimplificationRecordedStatus,
	type SimplificationRecordResult,
} from "../harness/findings/simplification-record.js";
import {
	SIMPLIFICATION_HANDOFF_SCHEMA_VERSION,
	SIMPLIFICATION_REMEDIES,
	SIMPLIFICATION_REPORT_SCHEMA_VERSION,
	type SimplificationDeepHandoffRequest,
	type SimplificationEvidenceState,
	type SimplificationFinding,
	type SimplificationRemedy,
	type SimplificationReport,
	type SimplificationRepositoryIdentity,
	type SimplificationScopeReceipt,
	type SimplificationSummary,
} from "../lib/simplification-types.js";
import { buildSimplificationCoverage } from "./simplify-coverage.js";
import { collectAdvisoryOpportunityEvidence } from "./simplify-opportunity-detectors.js";
import { collectDiagnosticSimplificationEvidence } from "./simplify-diagnostics.js";
import {
	collectDeadCodeEvidence,
	collectSingleInterfaceEvidence,
	type SimplificationCandidateDraft,
} from "./simplify-detectors.js";
import { repositoryIdentity, repositoryScope, resolveReviewScope } from "./simplify-scope.js";
import { discoverFiles } from "./verify/file-discovery.js";

const TEXT_FINDING_LIMIT = 10;

export interface SimplifyCommandOptions {
    diagnostics?: string;
	cwd?: string;
	json?: boolean;
	record?: boolean;
	changed?: boolean;
	staged?: boolean;
	range?: string;
	deepHandoff?: boolean;
}

export interface SimplifyStatusOptions {
	cwd?: string;
	json?: boolean;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function validationNotRun(): SimplificationFinding["validation"] {
	return {
		status: "not_run",
		executor: null,
		commands: [],
		artifact_sha: null,
		notes: ["Static evidence only; no candidate patch was created or executed."],
	};
}

function findingFingerprint(draft: SimplificationCandidateDraft): string {
	return digest([
		"simplification-v1",
		draft.source,
		draft.remedy,
		draft.path,
		draft.key,
	].join("\0"));
}

function materializeFinding(
	draft: SimplificationCandidateDraft,
	repository: SimplificationRepositoryIdentity,
): SimplificationFinding {
	return {
		fingerprint: findingFingerprint(draft),
		lens: "simplification",
		source: draft.source,
		remedy: draft.remedy,
		evidence_state: draft.evidenceState,
		confidence: draft.confidence,
		location: {
			path: draft.path,
			start_line: draft.startLine,
			end_line: draft.endLine,
			tree_sha: repository.tree_sha,
			working_tree_sha256: repository.working_tree_sha256,
		},
		summary: draft.summary,
		replacement: draft.replacement,
		evidence: draft.evidence,
		impact: {
			estimated: {
				loc: draft.estimatedLoc,
				dependencies_removed: draft.estimatedDependenciesRemoved ?? [],
			},
			validated: null,
		},
		overlap_group: null,
		validation: validationNotRun(),
		advisory: true,
		auto_fix: false,
	};
}

function knownSpansOverlap(
	left: SimplificationFinding,
	right: SimplificationFinding,
): boolean {
	if (left.location.path !== right.location.path) return false;
	const leftStart = left.location.start_line;
	const leftEnd = left.location.end_line;
	const rightStart = right.location.start_line;
	const rightEnd = right.location.end_line;
	if (leftStart === null || leftEnd === null || rightStart === null || rightEnd === null) {
		return false;
	}
	return Math.max(leftStart, rightStart) <= Math.min(leftEnd, rightEnd);
}

function dependencyRemovalsOverlap(
	left: SimplificationFinding,
	right: SimplificationFinding,
): boolean {
	const rightDependencies = new Set(right.impact.estimated.dependencies_removed);
	return left.impact.estimated.dependencies_removed.some((dependency) =>
		rightDependencies.has(dependency));
}

function findingsOverlap(
	left: SimplificationFinding,
	right: SimplificationFinding,
): boolean {
	return knownSpansOverlap(left, right) || dependencyRemovalsOverlap(left, right);
}

/** Assign deterministic connected-component ids only to candidates with material overlap. */
export function groupOverlappingFindings(
	findings: readonly SimplificationFinding[],
): SimplificationFinding[] {
	const parents = findings.map((_, index) => index);
	const root = (index: number): number => {
		let current = index;
		while ((parents[current] ?? current) !== current) {
			current = parents[current] ?? current;
		}
		let cursor = index;
		while ((parents[cursor] ?? cursor) !== current) {
			const next = parents[cursor] ?? cursor;
			parents[cursor] = current;
			cursor = next;
		}
		return current;
	};
	const union = (left: number, right: number): void => {
		const leftRoot = root(left);
		const rightRoot = root(right);
		if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
	};
	for (let left = 0; left < findings.length; left++) {
		for (let right = left + 1; right < findings.length; right++) {
			const leftFinding = findings[left];
			const rightFinding = findings[right];
			if (leftFinding && rightFinding && findingsOverlap(leftFinding, rightFinding)) {
				union(left, right);
			}
		}
	}
	const components = new Map<number, number[]>();
	for (let index = 0; index < findings.length; index++) {
		const componentRoot = root(index);
		const members = components.get(componentRoot) ?? [];
		members.push(index);
		components.set(componentRoot, members);
	}
	const groupByIndex = new Map<number, string>();
	for (const members of components.values()) {
		if (members.length < 2) continue;
		const fingerprints = members
			.map((index) => findings[index]?.fingerprint ?? "")
			.sort((left, right) => left.localeCompare(right));
		const group = `overlap:${digest(fingerprints.join("\0")).slice(0, 16)}`;
		for (const index of members) groupByIndex.set(index, group);
	}
	return findings.map((finding, index) => ({
		...finding,
		overlap_group: groupByIndex.get(index) ?? null,
	}));
}

function reviewScope(options: SimplifyCommandOptions, cwd: string): SimplificationScopeReceipt {
	const requested = Number(options.changed === true)
		+ Number(options.staged === true)
		+ Number(options.range !== undefined);
	if (requested > 1) {
		throw new Error("choose exactly one review scope: --changed, --staged, or --range");
	}
	if (options.range !== undefined) {
		return resolveReviewScope({ cwd, kind: "range", range: options.range });
	}
	if (options.staged === true) return resolveReviewScope({ cwd, kind: "staged" });
	return resolveReviewScope({ cwd, kind: "changed" });
}

function draftInScope(
	draft: SimplificationCandidateDraft,
	scope: SimplificationScopeReceipt,
): boolean {
	if (scope.selected_paths === null) return true;
	const selected = new Set(scope.selected_paths);
	return selected.has(draft.path) || draft.relatedPaths.some((path) => selected.has(path));
}

function findingScore(finding: SimplificationFinding): number {
	return Math.abs(finding.impact.estimated.loc ?? 0) * finding.confidence;
}

function sortFindings(findings: SimplificationFinding[]): SimplificationFinding[] {
	return [...findings].sort((left, right) =>
		findingScore(right) - findingScore(left)
		|| right.confidence - left.confidence
		|| left.location.path.localeCompare(right.location.path)
		|| left.fingerprint.localeCompare(right.fingerprint));
}

function summarize(findings: SimplificationFinding[]): SimplificationSummary {
	const byRemedy: Record<SimplificationRemedy, number> = {
		delete: 0,
		stdlib: 0,
		native: 0,
		yagni: 0,
		shrink: 0,
	};
	const byEvidence: Record<SimplificationEvidenceState, number> = {
		candidate: 0,
		heuristic: 0,
		proven: 0,
		"sandbox-validated": 0,
	};
	for (const finding of findings) {
		byRemedy[finding.remedy] += 1;
		byEvidence[finding.evidence_state] += 1;
	}
	return { findings: findings.length, by_remedy: byRemedy, by_evidence_state: byEvidence };
}

function deepHandoff(
	repository: SimplificationRepositoryIdentity,
	scope: SimplificationScopeReceipt,
	findings: SimplificationFinding[],
): SimplificationDeepHandoffRequest {
	if (repository.head_sha === null || repository.tree_sha === null) {
		throw new Error("--deep-handoff requires a Git commit and tree identity");
	}
	return {
		schema_version: SIMPLIFICATION_HANDOFF_SCHEMA_VERSION,
		kind: "agent_ci.simplification_review",
		lens: "simplification",
		scope,
		repository: {
			...repository,
			head_sha: repository.head_sha,
			tree_sha: repository.tree_sha,
		},
		deterministic_finding_fingerprints: findings.map((finding) => finding.fingerprint),
		requested_remedies: [...SIMPLIFICATION_REMEDIES],
		requirements: [
			"Return structured advisory findings with exact evidence and coverage.",
			"Preserve security, trust-boundary, data-loss, accessibility, public API, and compatibility behavior.",
			"Keep estimated and independently validated impact separate; deduplicate overlapping candidates.",
			"Say no findings in covered scope when empty; do not claim the repository is globally lean.",
		],
		submission: {
			status: "not_submitted",
			reason: "The Interlinked CLI creates a portable request only; no network, model, or Agent CI job was invoked.",
		},
	};
}

export function buildSimplificationReport(
	command: SimplificationReport["command"],
	options: SimplifyCommandOptions = {},
): SimplificationReport {
	const cwd = resolve(options.cwd ?? process.cwd());
	const discovered = discoverFiles(cwd);
	const repository = repositoryIdentity({ cwd, files: discovered });
	const scope = command === "review"
		? reviewScope(options, cwd)
		: repositoryScope(repository.head_sha);
	if (scope.selected_paths?.length === 0) {
		const findings: SimplificationFinding[] = [];
		return {
			schema_version: SIMPLIFICATION_REPORT_SCHEMA_VERSION,
			lens: "simplification",
			command,
			repository,
			scope,
			findings,
			summary: summarize(findings),
			coverage: buildSimplificationCoverage({
				cwd,
				discovered,
				scope,
				sources: [],
				findings,
			}),
			deep_handoff: command === "review" && options.deepHandoff === true
				? deepHandoff(repository, scope, findings)
				: null,
			read_only: true,
		};
	}
	const deadCode = collectDeadCodeEvidence(cwd);
	const interfaces = collectSingleInterfaceEvidence(cwd, discovered);
	const opportunities = collectAdvisoryOpportunityEvidence(cwd, discovered);
    const diagnostics = collectDiagnosticSimplificationEvidence(cwd, options.diagnostics);
	const drafts = [...deadCode.drafts, ...interfaces.drafts, ...opportunities.drafts, ...diagnostics.drafts]
		.filter((draft) => draftInScope(draft, scope));
	const findings = sortFindings(groupOverlappingFindings(
		drafts.map((draft) => materializeFinding(draft, repository)),
	));
	const sources = [...deadCode.sources, ...interfaces.sources, ...opportunities.sources, ...diagnostics.sources];
	return {
		schema_version: SIMPLIFICATION_REPORT_SCHEMA_VERSION,
		lens: "simplification",
		command,
		repository,
		scope,
		findings,
		summary: summarize(findings),
		coverage: buildSimplificationCoverage({ cwd, discovered, scope, sources, findings }),
		deep_handoff: (command === "audit" || command === "review") && options.deepHandoff === true
			? deepHandoff(repository, scope, findings)
			: null,
		read_only: true,
	};
}

function formatLocation(finding: SimplificationFinding): string {
	const line = finding.location.start_line;
	return `${finding.location.path}${line === null ? "" : `:${line}`}`;
}

export function renderSimplificationText(
	report: SimplificationReport,
	recording?: SimplificationRecordResult,
): string {
	const lines = [
		`Simplify ${report.command} — ${report.summary.findings} advisory finding(s); coverage ${report.coverage.status} (${report.coverage.analyzed_files}/${report.coverage.selected_files} selected files analyzed)`,
	];
	if (report.findings.length === 0) {
		lines.push("No findings in covered scope.");
	} else {
		for (const finding of report.findings.slice(0, TEXT_FINDING_LIMIT)) {
			lines.push(
				`  ${formatLocation(finding)} [${finding.remedy}/${finding.evidence_state}] ${finding.summary}`,
			);
		}
		if (report.findings.length > TEXT_FINDING_LIMIT) {
			lines.push(`  … +${report.findings.length - TEXT_FINDING_LIMIT} more (use --json)`);
		}
	}
	if (report.deep_handoff !== null) {
		lines.push("Deep Agent CI handoff request prepared but not submitted (use --json for the request).");
	}
	if (recording) {
		lines.push(
			`Recorded run ${recording.receipt.run_fingerprint.slice(0, 12)} and upserted ${recording.findings_upserted} finding(s) into ${recording.corpus_path}.`,
		);
		lines.push("Advisory only; no source files or branches changed and no fixes applied.");
	} else {
		lines.push("Read-only advisory; no files changed and no fixes applied.");
	}
	return lines.join("\n");
}

export function renderSimplificationStatus(status: SimplificationRecordedStatus): string {
	const lines = [
		`Simplification records — ${status.run_count} local run(s); ${status.corpus_findings} common-corpus finding(s) from ${status.finding_observations} recorded observation(s)`,
	];
	if (status.runs.length === 0) {
		lines.push("No recorded simplification runs. Add --record to simplify scan, review, or audit.");
	} else {
		for (const receipt of status.runs.slice(0, TEXT_FINDING_LIMIT)) {
			const report = receipt.report;
			const tree = report.repository.tree_sha?.slice(0, 12) ?? "no-tree";
			lines.push(
				`  ${receipt.recorded_at} ${report.command} ${receipt.run_fingerprint.slice(0, 12)} — ${report.summary.findings} finding(s), coverage ${report.coverage.status}, tree ${tree}`,
			);
		}
		if (status.runs.length > TEXT_FINDING_LIMIT) {
			lines.push(`  … +${status.runs.length - TEXT_FINDING_LIMIT} older run(s) (use --json)`);
		}
	}
	lines.push(`Run receipts: ${status.runs_path}`);
	lines.push(`Common corpus: ${status.corpus_path}`);
	return lines.join("\n");
}

export async function simplifyCommand(
	command: SimplificationReport["command"],
	options: SimplifyCommandOptions = {},
): Promise<number> {
	try {
		const report = buildSimplificationReport(command, options);
		const recording = options.record === true
			? recordSimplificationReport(report, report.repository.root)
			: undefined;
		console.log(
			options.json === true
				? JSON.stringify(report, null, 2)
				: renderSimplificationText(report, recording),
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json === true) {
			console.log(JSON.stringify({
				schema_version: SIMPLIFICATION_REPORT_SCHEMA_VERSION,
				error: message,
			}, null, 2));
		} else {
			process.stderr.write(`Simplify ${command} unavailable: ${message}\n`);
		}
		return 1;
	}
}

export function simplifyStatusCommand(options: SimplifyStatusOptions = {}): number {
	try {
		const status = loadSimplificationRecordedStatus(resolve(options.cwd ?? process.cwd()));
		console.log(
			options.json === true ? JSON.stringify(status, null, 2) : renderSimplificationStatus(status),
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json === true) {
			console.log(JSON.stringify({
				schema_version: 1,
				kind: "simplification_recorded_status",
				error: message,
			}, null, 2));
		} else {
			process.stderr.write(`Simplify status unavailable: ${message}\n`);
		}
		return 1;
	}
}
