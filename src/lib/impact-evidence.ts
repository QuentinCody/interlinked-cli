// ===========================================
// Evidence-classed local impact report
// ===========================================
// This report describes recorded facts. It never turns an estimate or an
// observed worktree delta into a causal claim.

import { readCausalEvidence } from "./impact-evidence-causal.js";
import {
	readActivityEvidence,
	readBaselineFoldEvidence,
	readFindingsEvidence,
	readManualDebtLifecycleEvidence,
} from "./impact-evidence-observed.js";
import {
	potentialEvidence,
	readSimplificationReceipts,
	sandboxValidatedEvidence,
	type ParsedSimplificationReceipts,
} from "./impact-evidence-simplification.js";
import type {
	BuildImpactEvidenceOptions,
	ImpactEvidenceReport,
} from "./impact-evidence-types.js";
import {
	readDependencyDeltaEvidence,
	readGitWorktreeEvidence,
} from "./impact-git-evidence.js";

export type {
	ImpactEvidenceReport,
	SimplificationImpactAggregate,
} from "./impact-evidence-types.js";

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
	const simplificationReceipts: ParsedSimplificationReceipts = readSimplificationReceipts(cwd);
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
