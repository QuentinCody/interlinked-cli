import { describe, expect, it } from "vitest";
import type {
	ActivityEvidence,
	BaselineFoldEvidence,
	BuildImpactEvidenceOptions,
	CausalImpactEvidence,
	FindingsEvidence,
	ImpactAvailability,
	ImpactEvidenceReport,
	ManualDebtLifecycleEvidence,
	PotentialImpactEvidence,
	SandboxValidatedImpactEvidence,
	SimplificationImpactAggregate,
	SimplificationImpactRunScope,
	SimplificationReceiptEvidence,
} from "./impact-evidence-types.js";

describe("impact-evidence-types — shared evidence shapes", () => {
	it("admits the three availability states", () => {
		const states: ImpactAvailability[] = ["available", "not-recorded", "unavailable"];
		expect(states).toHaveLength(3);
	});

	it("pins the observed baseline-fold shape", () => {
		const fold: BaselineFoldEvidence = {
			availability: "available",
			evidence_class: "observed",
			events: 1,
			malformed_rows: 0,
			by_kind: { coverage: { events: 1, changed: 1, refused: 0 } },
			scope: "scope",
		};
		expect(fold.by_kind.coverage?.changed).toBe(1);
		expect(fold.evidence_class).toBe("observed");
	});

	it("pins the activity token sub-shape", () => {
		const activity: ActivityEvidence = {
			availability: "not-recorded",
			evidence_class: "observed",
			sessions: 0,
			ended_sessions: 0,
			tool_calls: 0,
			errors: 0,
			edit_events: 0,
			lines_added: 0,
			lines_removed: 0,
			tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 },
			scope: "scope",
		};
		expect(activity.tokens.cache_creation).toBe(4);
	});

	it("pins the findings lifecycle and reconciliation counters", () => {
		const findings: FindingsEvidence = {
			availability: "available",
			evidence_class: "observed",
			review_findings: 2,
			reconciliation: { open: 1, touched: 1, acked: 0 },
			lifecycle: { candidate: 2, approved: 0, distilled: 0, superseded: 0 },
			simplification: {
				findings: 0,
				reconciliation: { open: 0, touched: 0, acked: 0 },
				lifecycle: { candidate: 0, approved: 0, distilled: 0, superseded: 0 },
			},
			scope: "scope",
		};
		expect(findings.reconciliation.open + findings.reconciliation.touched).toBe(2);
	});

	it("allows a null latest scope on manual debt evidence", () => {
		const debt: ManualDebtLifecycleEvidence = {
			availability: "not-recorded",
			evidence_class: "observed",
			snapshot_count: 0,
			transitions: { opened: 0, changed: 0, closed: 0 },
			current_markers: 0,
			path: "/tmp/x.jsonl",
			latest_scope: null,
			scope: "scope",
			reason: "none",
		};
		expect(debt.latest_scope).toBeNull();
	});

	it("carries run scopes on receipt evidence", () => {
		const runScope: SimplificationImpactRunScope = {
			run_fingerprint: "fp",
			recorded_at: "2026-01-01T00:00:00Z",
			command: "scan",
			tree_sha: null,
			scope: {
				kind: "repository",
				range: null,
				base_sha: null,
				head_sha: null,
				selected_paths: null,
			},
			coverage_status: "complete",
			finding_observations: 0,
		};
		const receipts: SimplificationReceiptEvidence = {
			availability: "available",
			path: "/tmp/runs.jsonl",
			receipt_rows: 1,
			valid_receipts: 1,
			malformed_receipts: 0,
			run_count: 1,
			finding_observations: 0,
			latest_finding_count: 0,
			scopes: [runScope],
		};
		expect(receipts.scopes[0]?.command).toBe("scan");
	});

	it("narrows the aggregate into potential and sandbox-validated classes", () => {
		const aggregate: SimplificationImpactAggregate = {
			available: true,
			availability: "available",
			representative_findings: 1,
			overlap_groups_represented: 0,
			representative_fingerprints: ["fp"],
			loc_delta: -10,
			loc_known_findings: 1,
			loc_unknown_findings: 0,
			dependencies_removed: [],
			scope: "scope",
			note: "note",
		};
		const potential: PotentialImpactEvidence = { ...aggregate, evidence_class: "potential" };
		const sandbox: SandboxValidatedImpactEvidence = {
			...aggregate,
			evidence_class: "sandbox-validated",
			eligible_validated_findings: 1,
		};
		expect(potential.evidence_class).toBe("potential");
		expect(sandbox.eligible_validated_findings).toBe(1);
	});

	it("keeps causal evidence unavailable without a manifest", () => {
		const causal: CausalImpactEvidence = {
			evidence_class: "causal",
			available: false,
			availability: "not-recorded",
			manifest_path: null,
			manifest_sha256: null,
			artifacts_verified: false,
			experiment_id: null,
			claim_statement: null,
			safety: null,
			completeness: null,
			scope: "scope",
			note: "note",
		};
		expect(causal.available).toBe(false);
	});

	it("pins the report schema version and build options", () => {
		const version: ImpactEvidenceReport["schema_version"] = 1;
		const options: BuildImpactEvidenceOptions = { base: "HEAD", experimentManifest: undefined };
		expect(version).toBe(1);
		expect(options.base).toBe("HEAD");
	});
});
