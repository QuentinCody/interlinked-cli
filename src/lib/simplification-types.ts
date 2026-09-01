// ===========================================
// Simplification review — shared evidence contract
// ===========================================
// This schema is shared by the read-only local CLI and the deeper Agent CI
// lane. A local detector may suggest work, but it must not imply semantic
// certainty or validation that did not occur.

export const SIMPLIFICATION_REPORT_SCHEMA_VERSION = 1 as const;
export const SIMPLIFICATION_HANDOFF_SCHEMA_VERSION = 1 as const;

export const SIMPLIFICATION_REMEDIES = [
	"delete",
	"stdlib",
	"native",
	"yagni",
	"shrink",
] as const;

export type SimplificationRemedy = (typeof SIMPLIFICATION_REMEDIES)[number];

export type SimplificationEvidenceState =
	| "candidate"
	| "heuristic"
	| "proven"
	| "sandbox-validated";

export interface SimplificationRepositoryIdentity {
	repository_id: string;
	root: string;
	head_sha: string | null;
	tree_sha: string | null;
	working_tree_sha256: string;
}

interface SimplificationPinnedRepositoryIdentity
	extends SimplificationRepositoryIdentity {
	head_sha: string;
	tree_sha: string;
}

export type SimplificationScopeKind = "repository" | "changed" | "staged" | "range";

export interface SimplificationScopeReceipt {
	kind: SimplificationScopeKind;
	range: string | null;
	base_sha: string | null;
	head_sha: string | null;
	/** Null for repository scope so a large tree is not duplicated in output. */
	selected_paths: string[] | null;
}

interface SimplificationLocation {
	path: string;
	start_line: number | null;
	end_line: number | null;
	tree_sha: string | null;
	working_tree_sha256: string;
}

export interface SimplificationEvidence {
	kind: string;
	state: SimplificationEvidenceState;
	detail: string;
	path: string | null;
}

export interface SimplificationDelta {
	loc: number | null;
	dependencies_removed: string[];
}

interface SimplificationImpact {
	estimated: SimplificationDelta;
	validated: SimplificationDelta | null;
}

export type SimplificationValidationStatus =
	| "not_run"
	| "passed"
	| "failed"
	| "inconclusive";

interface SimplificationValidationNotRunReceipt {
	status: "not_run";
	executor: null;
	commands: [];
	artifact_sha: null;
	notes: string[];
}

interface SimplificationValidationPassedReceipt {
	status: "passed";
	executor: "local" | "sandbox";
	commands: [string, ...string[]];
	artifact_sha: string;
	notes: string[];
}

interface SimplificationValidationUnsuccessfulReceipt {
	status: "failed" | "inconclusive";
	executor: "local" | "sandbox" | null;
	commands: string[];
	artifact_sha: string | null;
	notes: string[];
}

export type SimplificationValidationReceipt =
	| SimplificationValidationNotRunReceipt
	| SimplificationValidationPassedReceipt
	| SimplificationValidationUnsuccessfulReceipt;

export interface SimplificationFinding {
	fingerprint: string;
	lens: "simplification";
	source: string;
	remedy: SimplificationRemedy;
	evidence_state: SimplificationEvidenceState;
	confidence: number;
	location: SimplificationLocation;
	summary: string;
	replacement: string | null;
	evidence: SimplificationEvidence[];
	impact: SimplificationImpact;
	overlap_group: string | null;
	validation: SimplificationValidationReceipt;
	advisory: true;
	auto_fix: false;
}

type SimplificationCoverageStatus = "complete" | "partial" | "unavailable";
type SimplificationSourceStatus = "checked" | "partial" | "skipped" | "unavailable";

export interface SimplificationCoverageExclusion {
	rule: string;
	count: number;
	sample: string[];
}

export interface SimplificationLanguageCoverage {
	language: string;
	extensions: string[];
	status: SimplificationSourceStatus;
	files: number;
	reason: string | null;
}

export interface SimplificationSourceCoverage {
	source: string;
	status: SimplificationSourceStatus;
	files_considered: number;
	/** Exact repository-relative paths successfully inspected by this source. */
	analyzed_paths: string[];
	findings_emitted: number;
	notes: string[];
}

export interface SimplificationCoverageReceipt {
	status: SimplificationCoverageStatus;
	discovered_files: number;
	selected_files: number;
	analyzed_files: number;
	excluded_files: number;
	missing_paths: string[];
	included_paths: string[];
	excluded_paths: SimplificationCoverageExclusion[];
	languages: SimplificationLanguageCoverage[];
	sources: SimplificationSourceCoverage[];
	limitations: string[];
}

export interface SimplificationSummary {
	findings: number;
	by_remedy: Record<SimplificationRemedy, number>;
	by_evidence_state: Record<SimplificationEvidenceState, number>;
}

export interface SimplificationDeepHandoffRequest {
	schema_version: typeof SIMPLIFICATION_HANDOFF_SCHEMA_VERSION;
	kind: "agent_ci.simplification_review";
	lens: "simplification";
	scope: SimplificationScopeReceipt;
	repository: SimplificationPinnedRepositoryIdentity;
	deterministic_finding_fingerprints: string[];
	requested_remedies: SimplificationRemedy[];
	requirements: string[];
	submission: {
		status: "not_submitted";
		reason: string;
	};
}

export interface SimplificationReport {
	schema_version: typeof SIMPLIFICATION_REPORT_SCHEMA_VERSION;
	lens: "simplification";
	command: "scan" | "review" | "audit";
	repository: SimplificationRepositoryIdentity;
	scope: SimplificationScopeReceipt;
	findings: SimplificationFinding[];
	summary: SimplificationSummary;
	coverage: SimplificationCoverageReceipt;
	deep_handoff: SimplificationDeepHandoffRequest | null;
	read_only: true;
}
