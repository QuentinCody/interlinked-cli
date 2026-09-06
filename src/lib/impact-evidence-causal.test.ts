import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCausalEvidence } from "./impact-evidence-causal.js";

function hex(seed: string): string {
	return seed.repeat(64 / seed.length);
}

/** A schema-valid, independently pinned causal manifest whose declared
 * artifact paths are never written to disk — used to reach the
 * artifact-verification failure branch without touching the JSON-shape
 * or claim-kind rejections the other tests already cover. */
function validCausalManifest(): Record<string, unknown> {
	// Each label maps to a distinct 4-hex-digit seed so every sha256 field
	// differs (parseArm rejects control/treatment sharing one hash) while
	// staying valid against the /^[a-f0-9]{64}$/ pattern.
	const seeds: Record<string, string> = {
		tree: "1a2b", srca: "3c4d", task: "5e6f", eval: "7890",
		parm: "aabb", depl: "ccdd", recp: "eeff", cova: "0011",
		rawr: "2233", anal: "4455", ctrl: "6677", trmt: "8899",
		plan: "aa11", preg: "bb22",
	};
	const sha = (label: string) => {
		const seed = seeds[label];
		if (!seed) throw new Error(`no seed for ${label}`);
		return hex(seed);
	};
	return {
		schema_version: "simplification-experiment/v1",
		experiment_id: "experiment-p2u103",
		claim: { kind: "causal", statement: "The treatment reduced review time." },
		repository: {
			repository_id: "fixtures/p2u103",
			tree_sha: sha("tree"),
			source_artifact_sha256: sha("srca"),
			dirty: false,
		},
		task_suite: {
			name: "p2u103-suite",
			version: "1.0.0",
			task_set_sha256: sha("task"),
			evaluator_sha256: sha("eval"),
		},
		model: {
			provider: "provider",
			family: "family",
			model: "model",
			version: "2026-09-01",
			parameters_sha256: sha("parm"),
		},
		environment: {
			container_image_digest: `sha256:${sha("depl")}`,
			dependency_lock_sha256: sha("depl"),
			harness_version: "0.1.0",
			runtime_versions: [{ name: "node", version: "22.18.0" }],
		},
		runs: {
			started_at: "2026-09-01T00:00:00.000Z",
			completed_at: "2026-09-01T01:00:00.000Z",
			sample_size: 2,
			failed_runs: 0,
			exclusions: [],
		},
		outcomes: {
			primary_metric: "accepted_loc_removed",
			metrics: [{ name: "accepted_loc_removed", unit: "lines", direction: "higher_is_better" }],
			safety: {
				protected_behavior_regressions: 0,
				required_checks_passed: true,
				receipt_path: "artifacts/safety.json",
				receipt_sha256: sha("recp"),
			},
			completeness: {
				planned_runs: 2,
				completed_runs: 2,
				scored_runs: 2,
				coverage_path: "artifacts/coverage.json",
				coverage_sha256: sha("cova"),
			},
			raw_results_path: "artifacts/raw-results.jsonl",
			raw_results_sha256: sha("rawr"),
			analysis_output_path: "artifacts/analysis.json",
			analysis_output_sha256: sha("anal"),
		},
		causal_design: {
			design: "randomized_paired",
			experimental_unit: "task-model-seed",
			assignment_seed: "seed-p2u103",
			assignment_algorithm: "sha256 parity counterbalance",
			control: { name: "baseline", instructions_sha256: sha("ctrl") },
			treatment: { name: "simplification", instructions_sha256: sha("trmt") },
			analysis_plan_sha256: sha("plan"),
			preregistration_sha256: sha("preg"),
			missing_data_policy: "Count missing terminal runs as failures.",
			blinded_evaluator: true,
		},
	};
}

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "impact-causal-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("readCausalEvidence", () => {
	it("reports not-recorded when no manifest is supplied", () => {
		const causal = readCausalEvidence(cwd, undefined);
		expect(causal.evidence_class).toBe("causal");
		expect(causal.available).toBe(false);
		expect(causal.availability).toBe("not-recorded");
		expect(causal.manifest_path).toBeNull();
		expect(causal.note).toBe("No controlled-experiment manifest was supplied.");
		expect(causal.artifacts_verified).toBe(false);
	});

	it("throws for an explicitly supplied unreadable manifest", () => {
		expect(() => readCausalEvidence(cwd, "missing.json")).toThrow(
			/Explicit experiment manifest is unreadable/,
		);
	});

	it("reports unavailable for a manifest that is not valid JSON", () => {
		writeFileSync(join(cwd, "bad.json"), "{not json", "utf8");
		const causal = readCausalEvidence(cwd, "bad.json");
		expect(causal.availability).toBe("unavailable");
		expect(causal.manifest_path).toBe(join(cwd, "bad.json"));
		expect(causal.note).toMatch(/^Experiment manifest is not valid JSON: /);
	});

	it("reports unavailable for a schema-invalid manifest", () => {
		writeFileSync(join(cwd, "wrong.json"), JSON.stringify({ schema_version: 1 }), "utf8");
		const causal = readCausalEvidence(cwd, "wrong.json");
		expect(causal.availability).toBe("unavailable");
		expect(causal.note).toMatch(/^Experiment manifest rejected: /);
		expect(causal.experiment_id).toBeNull();
	});

	it("resolves an absolute manifest path without joining the cwd", () => {
		const absolute = join(cwd, "abs.json");
		writeFileSync(absolute, "[]", "utf8");
		const causal = readCausalEvidence(cwd, absolute);
		expect(causal.manifest_path).toBe(absolute);
		expect(causal.availability).toBe("unavailable");
	});

	it("reports unavailable with the artifact label and path when a declared artifact is missing on disk", () => {
		writeFileSync(join(cwd, "manifest.json"), JSON.stringify(validCausalManifest()), "utf8");
		// The manifest never writes artifacts/raw-results.jsonl, so the very
		// first artifact check in verifyCausalArtifacts fails to read it.
		const causal = readCausalEvidence(cwd, "manifest.json");
		expect(causal.available).toBe(false);
		expect(causal.availability).toBe("unavailable");
		expect(causal.note).toBe(
			"raw results artifact is unreadable: artifacts/raw-results.jsonl",
		);
		expect(causal.experiment_id).toBe("experiment-p2u103");
	});
});
