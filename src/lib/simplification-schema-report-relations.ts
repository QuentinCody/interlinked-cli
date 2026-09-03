// ===========================================
// Simplification review — cross-field report relation checks
// ===========================================
// Validates internal consistency between a report's summary, findings, and
// handoff once each has been individually parsed, plus the evidence/validation
// parsing those checks depend on. Imports only from the import-free scope-kinds
// module (never from simplification-schema.ts) so the parser that constructs
// these objects can import back from here without a module cycle.

import { isJsonObject } from "./json-types.js";
import {
	EVIDENCE_STATES,
	isMember,
	isSimplificationRepositoryPath,
	nullableString,
	requiredString,
} from "./simplification-schema-scope-kinds.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationDeepHandoffRequest,
	type SimplificationEvidence,
	type SimplificationEvidenceState,
	type SimplificationFinding,
	type SimplificationRemedy,
	type SimplificationReport,
	type SimplificationRepositoryIdentity,
	type SimplificationScopeReceipt,
	type SimplificationSummary,
	type SimplificationValidationReceipt,
	type SimplificationValidationStatus,
} from "./simplification-types.js";

export function parseEvidence(value: unknown): SimplificationEvidence | null {
	if (!isJsonObject(value) || !isMember(value.state, EVIDENCE_STATES)) return null;
	const kind = requiredString(value.kind);
	const detail = requiredString(value.detail);
	const path = nullableString(value.path);
	return kind && detail && path !== undefined
		&& (path === null || isSimplificationRepositoryPath(path))
		? { kind, state: value.state, detail, path }
		: null;
}

export function parseEvidenceList(value: unknown): SimplificationEvidence[] | null {
	if (!Array.isArray(value)) return null;
	const out: SimplificationEvidence[] = [];
	for (const entry of value) {
		const parsed = parseEvidence(entry);
		if (!parsed) return null;
		out.push(parsed);
	}
	return out;
}

export interface ParsedValidationFields {
	executor: "local" | "sandbox" | null;
	commands: string[];
	artifact_sha: string | null;
	notes: string[];
}

export function constructValidation(
	status: SimplificationValidationStatus,
	fields: ParsedValidationFields,
): SimplificationValidationReceipt | null {
	if (status === "not_run") {
		return fields.executor === null && fields.commands.length === 0 && fields.artifact_sha === null
			? { status, executor: null, commands: [], artifact_sha: null, notes: fields.notes }
			: null;
	}
	if (status === "passed") {
		const firstCommand = fields.commands[0];
		if (
			fields.executor === null || firstCommand === undefined || fields.artifact_sha === null
		) return null;
		if (fields.commands.some((command) => command.length === 0)) return null;
		return {
			status,
			executor: fields.executor,
			commands: [firstCommand, ...fields.commands.slice(1)],
			artifact_sha: fields.artifact_sha,
			notes: fields.notes,
		};
	}
	return { status, ...fields };
}

export interface FindingScalars {
	fingerprint: string;
	source: string;
	remedy: SimplificationRemedy;
	evidence_state: SimplificationEvidenceState;
	confidence: number;
	summary: string;
	replacement: string | null;
	overlap_group: string | null;
}

export interface FindingObjects {
	location: SimplificationFinding["location"];
	evidence: SimplificationEvidence[];
	impact: SimplificationFinding["impact"];
	validation: SimplificationValidationReceipt;
}

export function findingValidationIsConsistent(
	scalars: FindingScalars,
	objects: FindingObjects,
): boolean {
	const notRunIsConsistent = objects.validation.status !== "not_run" ||
		objects.impact.validated === null;
	const hasSandboxValidatedReceipt = objects.validation.status === "passed" &&
		objects.validation.executor === "sandbox" && objects.impact.validated !== null;
	return notRunIsConsistent &&
		(scalars.evidence_state === "sandbox-validated") === hasSandboxValidatedReceipt;
}

function summaryMatchesFindings(
	summary: SimplificationSummary,
	findings: readonly SimplificationFinding[],
): boolean {
	const remedies: SimplificationSummary["by_remedy"] = {
		delete: 0,
		stdlib: 0,
		native: 0,
		yagni: 0,
		shrink: 0,
	};
	const states: SimplificationSummary["by_evidence_state"] = {
		candidate: 0,
		heuristic: 0,
		proven: 0,
		"sandbox-validated": 0,
	};
	for (const finding of findings) {
		remedies[finding.remedy]++;
		states[finding.evidence_state]++;
	}
	return summary.findings === findings.length
		&& SIMPLIFICATION_REMEDIES.every((remedy) => summary.by_remedy[remedy] === remedies[remedy])
		&& EVIDENCE_STATES.every((state) =>
			summary.by_evidence_state[state] === states[state]);
}

function findingLocationsMatchRepository(
	repository: SimplificationRepositoryIdentity,
	findings: readonly SimplificationFinding[],
): boolean {
	return findings.every((finding) =>
		finding.location.tree_sha === repository.tree_sha
		&& finding.location.working_tree_sha256 === repository.working_tree_sha256);
}

function handoffMatchesReport(
	relations: Pick<ReportRelations, "handoff" | "repository" | "scope" | "findings">,
): boolean {
	const { handoff, repository, scope, findings } = relations;
	if (handoff === null) return true;
	return JSON.stringify(handoff.repository) === JSON.stringify(repository)
		&& JSON.stringify(handoff.scope) === JSON.stringify(scope)
		&& JSON.stringify(handoff.deterministic_finding_fingerprints)
			=== JSON.stringify(findings.map((finding) => finding.fingerprint));
}

export interface ReportRelations {
	command: SimplificationReport["command"];
	repository: SimplificationRepositoryIdentity;
	scope: SimplificationScopeReceipt;
	findings: SimplificationFinding[];
	summary: SimplificationSummary;
	handoff: SimplificationDeepHandoffRequest | null;
}

export function reportRelationsMatch(relations: ReportRelations): boolean {
	return summaryMatchesFindings(relations.summary, relations.findings)
		&& findingLocationsMatchRepository(relations.repository, relations.findings)
		&& handoffMatchesReport(relations)
		&& (relations.command !== "scan" || relations.handoff === null);
}
