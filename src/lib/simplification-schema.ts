// ===========================================
// Simplification review — JSON boundary parsers
// ===========================================
// Local command code constructs these records directly, but Agent CI responses
// and findings-corpus rows cross an untrusted JSON boundary. Keep one parser
// here so every consumer enforces the same advisory/read-only contract.

import { isJsonObject } from "./json-types.js";
import {
	SIMPLIFICATION_HANDOFF_SCHEMA_VERSION,
	SIMPLIFICATION_REMEDIES,
	SIMPLIFICATION_REPORT_SCHEMA_VERSION,
	type SimplificationCoverageExclusion,
	type SimplificationCoverageReceipt,
	type SimplificationDeepHandoffRequest,
	type SimplificationDelta,
	type SimplificationEvidence,
	type SimplificationEvidenceState,
	type SimplificationFinding,
	type SimplificationLanguageCoverage,
	type SimplificationRemedy,
	type SimplificationReport,
	type SimplificationRepositoryIdentity,
	type SimplificationScopeReceipt,
	type SimplificationSourceCoverage,
	type SimplificationSummary,
	type SimplificationValidationReceipt,
	type SimplificationValidationStatus,
} from "./simplification-types.js";

const EVIDENCE_STATES = ["candidate", "heuristic", "proven", "sandbox-validated"] as const;
const SCOPE_KINDS = ["repository", "changed", "staged", "range"] as const;
const VALIDATION_STATUSES = ["not_run", "passed", "failed", "inconclusive"] as const;
const COVERAGE_STATUSES = ["complete", "partial", "unavailable"] as const;
const SOURCE_STATUSES = ["checked", "partial", "skipped", "unavailable"] as const;

function isMember<T extends string>(value: unknown, choices: readonly T[]): value is T {
	return typeof value === "string" && choices.some((choice) => choice === value);
}

function requiredString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return requiredString(value) ?? undefined;
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((entry): entry is string => typeof entry === "string") ? [...value] : null;
}

function isSimplificationRepositoryPath(value: string): boolean {
	if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
	if (/^[A-Za-z]:/.test(value)) return false;
	return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function pathList(value: unknown): string[] | null {
	const values = stringList(value);
	return values?.every(isSimplificationRepositoryPath) ? values : null;
}

function uniqueCanonicalStrings(values: readonly string[]): boolean {
	return new Set(values).size === values.length
		&& values.every((entry, index) => index === 0 || entry >= (values[index - 1] ?? ""));
}

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseSimplificationRepository(
	value: unknown,
): SimplificationRepositoryIdentity | null {
	if (!isJsonObject(value)) return null;
	const repository_id = requiredString(value.repository_id);
	const root = requiredString(value.root);
	const head_sha = nullableString(value.head_sha);
	const tree_sha = nullableString(value.tree_sha);
	const working_tree_sha256 = requiredString(value.working_tree_sha256);
	if (!repository_id || !/^repo-[a-f0-9]{24}$/.test(repository_id)) return null;
	if (!root || head_sha === undefined || tree_sha === undefined || !working_tree_sha256) return null;
	return { repository_id, root, head_sha, tree_sha, working_tree_sha256 };
}

export function parseSimplificationScope(value: unknown): SimplificationScopeReceipt | null {
	if (!isJsonObject(value) || !isMember(value.kind, SCOPE_KINDS)) return null;
	const range = nullableString(value.range);
	const base_sha = nullableString(value.base_sha);
	const head_sha = nullableString(value.head_sha);
	if (range === undefined || base_sha === undefined || head_sha === undefined) return null;
	if (value.selected_paths === null) {
		return { kind: value.kind, range, base_sha, head_sha, selected_paths: null };
	}
	const selected_paths = pathList(value.selected_paths);
	return selected_paths === null || !uniqueCanonicalStrings(selected_paths)
		? null
		: { kind: value.kind, range, base_sha, head_sha, selected_paths };
}

function parseEvidence(value: unknown): SimplificationEvidence | null {
	if (!isJsonObject(value) || !isMember(value.state, EVIDENCE_STATES)) return null;
	const kind = requiredString(value.kind);
	const detail = requiredString(value.detail);
	const path = nullableString(value.path);
	return kind && detail && path !== undefined
		&& (path === null || isSimplificationRepositoryPath(path))
		? { kind, state: value.state, detail, path }
		: null;
}

function parseDelta(value: unknown): SimplificationDelta | null {
	if (!isJsonObject(value)) return null;
	const loc = finiteNumberOrNull(value.loc);
	const dependencies_removed = stringList(value.dependencies_removed);
	return loc !== undefined && dependencies_removed !== null ? { loc, dependencies_removed } : null;
}

interface ParsedValidationFields {
	executor: "local" | "sandbox" | null;
	commands: string[];
	artifact_sha: string | null;
	notes: string[];
}

function parseValidationFields(value: Record<string, unknown>): ParsedValidationFields | null {
	if (value.executor !== null && value.executor !== "local" && value.executor !== "sandbox") {
		return null;
	}
	const commands = stringList(value.commands);
	const artifact_sha = nullableString(value.artifact_sha);
	const notes = stringList(value.notes);
	if (commands === null || artifact_sha === undefined || notes === null) return null;
	return { executor: value.executor, commands, artifact_sha, notes };
}

function constructValidation(
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

function parseValidation(value: unknown): SimplificationValidationReceipt | null {
	if (!isJsonObject(value) || !isMember(value.status, VALIDATION_STATUSES)) return null;
	const fields = parseValidationFields(value);
	return fields ? constructValidation(value.status, fields) : null;
}

function parseLocation(value: unknown): SimplificationFinding["location"] | null {
	if (!isJsonObject(value)) return null;
	const path = requiredString(value.path);
	const tree_sha = nullableString(value.tree_sha);
	const working_tree_sha256 = requiredString(value.working_tree_sha256);
	const start_line = finiteNumberOrNull(value.start_line);
	const end_line = finiteNumberOrNull(value.end_line);
	if (!path || !isSimplificationRepositoryPath(path) || tree_sha === undefined || !working_tree_sha256) {
		return null;
	}
	if (start_line === undefined || end_line === undefined) return null;
	if (start_line !== null && (!Number.isInteger(start_line) || start_line < 1)) return null;
	if (end_line !== null && (!Number.isInteger(end_line) || end_line < 1)) return null;
	if (start_line !== null && end_line !== null && end_line < start_line) return null;
	return { path, start_line, end_line, tree_sha, working_tree_sha256 };
}

interface FindingScalars {
	fingerprint: string;
	source: string;
	remedy: SimplificationRemedy;
	evidence_state: SimplificationEvidenceState;
	confidence: number;
	summary: string;
	replacement: string | null;
	overlap_group: string | null;
}

function parseFindingScalars(value: unknown): FindingScalars | null {
	if (!isJsonObject(value)) return null;
	if (value.lens !== "simplification" || value.advisory !== true || value.auto_fix !== false) {
		return null;
	}
	if (!isMember(value.remedy, SIMPLIFICATION_REMEDIES)) return null;
	if (!isMember(value.evidence_state, EVIDENCE_STATES)) return null;
	if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
		return null;
	}
	const fingerprint = requiredString(value.fingerprint);
	const source = requiredString(value.source);
	const summary = requiredString(value.summary);
	const replacement = nullableString(value.replacement);
	const overlap_group = nullableString(value.overlap_group);
	if (!fingerprint || !source || !summary) return null;
	if (replacement === undefined || overlap_group === undefined) return null;
	return {
		fingerprint,
		source,
		remedy: value.remedy,
		evidence_state: value.evidence_state,
		confidence: value.confidence,
		summary,
		replacement,
		overlap_group,
	};
}

function parseEvidenceList(value: unknown): SimplificationEvidence[] | null {
	if (!Array.isArray(value)) return null;
	const out: SimplificationEvidence[] = [];
	for (const entry of value) {
		const parsed = parseEvidence(entry);
		if (!parsed) return null;
		out.push(parsed);
	}
	return out;
}

interface FindingObjects {
	location: SimplificationFinding["location"];
	evidence: SimplificationEvidence[];
	impact: SimplificationFinding["impact"];
	validation: SimplificationValidationReceipt;
}

function parseFindingObjects(value: unknown): FindingObjects | null {
	if (!isJsonObject(value) || !isJsonObject(value.impact)) return null;
	const location = parseLocation(value.location);
	const evidence = parseEvidenceList(value.evidence);
	const estimated = parseDelta(value.impact.estimated);
	const validated = value.impact.validated === null ? null : parseDelta(value.impact.validated);
	const validation = parseValidation(value.validation);
	if (!location || !evidence || !estimated || !validation) return null;
	if (value.impact.validated !== null && !validated) return null;
	return { location, evidence, impact: { estimated, validated }, validation };
}

function findingValidationIsConsistent(
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

export function parseSimplificationFinding(value: unknown): SimplificationFinding | null {
	const scalars = parseFindingScalars(value);
	const objects = parseFindingObjects(value);
	if (!scalars || !objects) return null;
	if (!findingValidationIsConsistent(scalars, objects)) return null;
	return {
		...scalars,
		lens: "simplification",
		...objects,
		advisory: true,
		auto_fix: false,
	};
}

function parseCoverageExclusion(value: unknown): SimplificationCoverageExclusion | null {
	if (!isJsonObject(value)) return null;
	const rule = requiredString(value.rule);
	const count = nonNegativeInteger(value.count);
	const sample = stringList(value.sample);
	return rule && count !== null && sample !== null ? { rule, count, sample } : null;
}

function parseLanguageCoverage(value: unknown): SimplificationLanguageCoverage | null {
	if (!isJsonObject(value) || !isMember(value.status, SOURCE_STATUSES)) return null;
	const language = requiredString(value.language);
	const extensions = stringList(value.extensions);
	const files = nonNegativeInteger(value.files);
	const reason = nullableString(value.reason);
	if (!language || extensions === null || files === null || reason === undefined) return null;
	return { language, extensions, status: value.status, files, reason };
}

function parseSourceCoverage(value: unknown): SimplificationSourceCoverage | null {
	if (!isJsonObject(value) || !isMember(value.status, SOURCE_STATUSES)) return null;
	const source = requiredString(value.source);
	const files_considered = nonNegativeInteger(value.files_considered);
	const analyzed_paths = stringList(value.analyzed_paths);
	const findings_emitted = nonNegativeInteger(value.findings_emitted);
	const notes = stringList(value.notes);
	if (
		!source
		|| files_considered === null
		|| analyzed_paths === null
		|| findings_emitted === null
		|| notes === null
		|| analyzed_paths.length !== files_considered
		|| analyzed_paths.some((path) => !isSimplificationRepositoryPath(path))
		|| new Set(analyzed_paths).size !== analyzed_paths.length
		|| analyzed_paths.some((path, index) => index > 0 && path.localeCompare(analyzed_paths[index - 1] ?? "") < 0)
	) return null;
	return { source, status: value.status, files_considered, analyzed_paths, findings_emitted, notes };
}

function parsedList<T>(value: unknown, parser: (entry: unknown) => T | null): T[] | null {
	if (!Array.isArray(value)) return null;
	const out: T[] = [];
	for (const entry of value) {
		const parsed = parser(entry);
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}

export function parseSimplificationCoverage(value: unknown): SimplificationCoverageReceipt | null {
	if (!isJsonObject(value) || !isMember(value.status, COVERAGE_STATUSES)) return null;
	const discovered_files = nonNegativeInteger(value.discovered_files);
	const selected_files = nonNegativeInteger(value.selected_files);
	const analyzed_files = nonNegativeInteger(value.analyzed_files);
	const excluded_files = nonNegativeInteger(value.excluded_files);
	if (
		discovered_files === null ||
		selected_files === null ||
		analyzed_files === null ||
		excluded_files === null ||
		analyzed_files > selected_files ||
		analyzed_files + excluded_files !== selected_files
	) return null;
	const missing_paths = stringList(value.missing_paths);
	const included_paths = stringList(value.included_paths);
	const limitations = stringList(value.limitations);
	const excluded_paths = parsedList(value.excluded_paths, parseCoverageExclusion);
	const languages = parsedList(value.languages, parseLanguageCoverage);
	const sources = parsedList(value.sources, parseSourceCoverage);
	if (!missing_paths || !included_paths || !limitations || !excluded_paths || !languages || !sources) {
		return null;
	}
	const analyzedPaths = new Set(sources.flatMap((source) => source.analyzed_paths));
	if (analyzedPaths.size !== analyzed_files) return null;
	return {
		status: value.status,
		discovered_files,
		selected_files,
		analyzed_files,
		excluded_files,
		missing_paths,
		included_paths,
		excluded_paths,
		languages,
		sources,
		limitations,
	};
}

function parseSummary(value: unknown): SimplificationSummary | null {
	if (!isJsonObject(value) || !isJsonObject(value.by_remedy)) return null;
	if (!isJsonObject(value.by_evidence_state)) return null;
	const findings = nonNegativeInteger(value.findings);
	const deleteCount = nonNegativeInteger(value.by_remedy.delete);
	const stdlib = nonNegativeInteger(value.by_remedy.stdlib);
	const native = nonNegativeInteger(value.by_remedy.native);
	const yagni = nonNegativeInteger(value.by_remedy.yagni);
	const shrink = nonNegativeInteger(value.by_remedy.shrink);
	const candidate = nonNegativeInteger(value.by_evidence_state.candidate);
	const heuristic = nonNegativeInteger(value.by_evidence_state.heuristic);
	const proven = nonNegativeInteger(value.by_evidence_state.proven);
	const sandbox = nonNegativeInteger(value.by_evidence_state["sandbox-validated"]);
	if (
		findings === null || deleteCount === null || stdlib === null || native === null ||
		yagni === null || shrink === null || candidate === null || heuristic === null ||
		proven === null || sandbox === null
	) return null;
	const remedyTotal = deleteCount + stdlib + native + yagni + shrink;
	const stateTotal = candidate + heuristic + proven + sandbox;
	if (remedyTotal !== findings || stateTotal !== findings) return null;
	return {
		findings,
		by_remedy: { delete: deleteCount, stdlib, native, yagni, shrink },
		by_evidence_state: {
			candidate,
			heuristic,
			proven,
			"sandbox-validated": sandbox,
		},
	};
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

interface ReportRelations {
	command: SimplificationReport["command"];
	repository: SimplificationRepositoryIdentity;
	scope: SimplificationScopeReceipt;
	findings: SimplificationFinding[];
	summary: SimplificationSummary;
	handoff: SimplificationDeepHandoffRequest | null;
}

function reportRelationsMatch(relations: ReportRelations): boolean {
	return summaryMatchesFindings(relations.summary, relations.findings)
		&& findingLocationsMatchRepository(relations.repository, relations.findings)
		&& handoffMatchesReport(relations)
		&& (relations.command !== "scan" || relations.handoff === null);
}

export function parseSimplificationHandoff(value: unknown): SimplificationDeepHandoffRequest | null {
	if (!isJsonObject(value)) return null;
	if (value.schema_version !== SIMPLIFICATION_HANDOFF_SCHEMA_VERSION) return null;
	if (value.kind !== "agent_ci.simplification_review" || value.lens !== "simplification") return null;
	const scope = parseSimplificationScope(value.scope);
	const repository = parseSimplificationRepository(value.repository);
	const deterministic_finding_fingerprints = stringList(
		value.deterministic_finding_fingerprints,
	);
	const requested_remedies = stringList(value.requested_remedies);
	const requirements = stringList(value.requirements);
	if (
		!scope
		|| !repository
		|| repository.head_sha === null
		|| repository.tree_sha === null
		|| !deterministic_finding_fingerprints
		|| !requested_remedies
	) {
		return null;
	}
	if (!requirements) return null;
	const parsedRemedies: SimplificationRemedy[] = [];
	for (const remedy of requested_remedies) {
		if (!isMember(remedy, SIMPLIFICATION_REMEDIES)) return null;
		parsedRemedies.push(remedy);
	}
	if (!isJsonObject(value.submission) || value.submission.status !== "not_submitted") return null;
	const reason = requiredString(value.submission.reason);
	if (!reason) return null;
	const pinnedRepository = {
		...repository,
		head_sha: repository.head_sha,
		tree_sha: repository.tree_sha,
	};
	return {
		schema_version: SIMPLIFICATION_HANDOFF_SCHEMA_VERSION,
		kind: "agent_ci.simplification_review",
		lens: "simplification",
		scope,
		repository: pinnedRepository,
		deterministic_finding_fingerprints,
		requested_remedies: parsedRemedies,
		requirements,
		submission: { status: "not_submitted", reason },
	};
}

export function parseSimplificationReport(value: unknown): SimplificationReport | null {
	if (!isJsonObject(value) || value.schema_version !== SIMPLIFICATION_REPORT_SCHEMA_VERSION) {
		return null;
	}
	if (value.lens !== "simplification" || value.read_only !== true) return null;
	if (value.command !== "scan" && value.command !== "review" && value.command !== "audit") {
		return null;
	}
	const repository = parseSimplificationRepository(value.repository);
	const scope = parseSimplificationScope(value.scope);
	const findings = parsedList(value.findings, parseSimplificationFinding);
	const summary = parseSummary(value.summary);
	const coverage = parseSimplificationCoverage(value.coverage);
	const deep_handoff = value.deep_handoff === null ? null : parseSimplificationHandoff(value.deep_handoff);
	if (!repository || !scope || !findings || !summary || !coverage) return null;
	if (value.deep_handoff !== null && !deep_handoff) return null;
	if (!reportRelationsMatch({
		command: value.command,
		repository,
		scope,
		findings,
		summary,
		handoff: deep_handoff,
	})) return null;
	return {
		schema_version: SIMPLIFICATION_REPORT_SCHEMA_VERSION,
		lens: "simplification",
		command: value.command,
		repository,
		scope,
		findings,
		summary,
		coverage,
		deep_handoff,
		read_only: true,
	};
}
