// ===========================================
// Evidence-classed local impact report — causal class
// ===========================================
// Causal attribution is available only for the claim and pinned scope a
// schema-valid controlled-experiment manifest declares, and only when every
// declared artifact matches its recorded SHA-256 digest.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { CausalImpactEvidence, ImpactAvailability } from "./impact-evidence-types.js";
import {
	parseSimplificationExperimentManifest,
	simplificationExperimentManifestSha256,
	type SimplificationExperimentManifest,
} from "./simplification-agent-ci-experiment.js";

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

export function readCausalEvidence(
	cwd: string,
	manifestPath: string | undefined,
): CausalImpactEvidence {
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
