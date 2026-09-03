// ===========================================
// Evidence-classed local impact report — shared shapes
// ===========================================
// Type-only surface shared by the impact-evidence readers and the report
// builder. It records evidence classes; it never turns an estimate or an
// observed worktree delta into a causal claim.

import type {
	SimplificationExperimentCompletenessOutcome,
	SimplificationExperimentSafetyOutcome,
} from "./simplification-agent-ci-experiment.js";
import type {
	DependencyDeltaEvidence,
	GitWorktreeEvidence,
} from "./impact-git-evidence.js";
import type { SimplificationScopeReceipt } from "./simplification-types.js";

export type ImpactAvailability = "available" | "not-recorded" | "unavailable";

interface BaselineFoldKindEvidence {
	events: number;
	changed: number;
	refused: number;
}

export interface BaselineFoldEvidence {
	availability: ImpactAvailability;
	evidence_class: "observed";
	events: number;
	malformed_rows: number;
	by_kind: Record<string, BaselineFoldKindEvidence>;
	scope: string;
	reason?: string | undefined;
}

export interface ActivityEvidence {
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

export interface FindingsEvidence {
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

export interface ManualDebtLifecycleEvidence {
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

export interface SimplificationImpactRunScope {
	run_fingerprint: string;
	recorded_at: string;
	command: "scan" | "review" | "audit";
	tree_sha: string | null;
	scope: SimplificationScopeReceipt;
	coverage_status: "complete" | "partial" | "unavailable";
	finding_observations: number;
}

export interface SimplificationReceiptEvidence {
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

export interface PotentialImpactEvidence extends SimplificationImpactAggregate {
	evidence_class: "potential";
}

export interface SandboxValidatedImpactEvidence extends SimplificationImpactAggregate {
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
