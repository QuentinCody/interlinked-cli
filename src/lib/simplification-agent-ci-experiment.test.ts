// ===========================================
// Simplification Agent CI — experiment manifest parser tests
// ===========================================
// Exercises the malformed-shape branches of parseSimplificationExperimentManifest
// that the request-artifact test file's happy-path fixtures never reach: a
// missing/unexpected key in each nested section, an empty scalar field, a
// malformed causal_design, the causal/observational relationship check, and
// the top-level schema_version guard. Pure JSON-shape parsing — no mocks, no
// filesystem, no network; every fixture is a plain object literal built here.

import { describe, expect, it } from "vitest";
import { parseSimplificationExperimentManifest } from "./simplification-agent-ci-experiment.js";

function hex(seed: string): string {
	return seed.repeat(64 / seed.length);
}

const SHA_TREE = hex("1a2b");
const SHA_SOURCE = hex("3c4d");
const SHA_TASKSET = hex("5e6f");
const SHA_EVALUATOR = hex("7890");
const SHA_PARAMS = hex("aabb");
const SHA_DEPLOCK = hex("ccdd");
const SHA_RECEIPT = hex("eeff");
const SHA_COVERAGE = hex("0011");
const SHA_RAW = hex("2233");
const SHA_ANALYSIS = hex("4455");
const SHA_CONTROL = hex("6677");
const SHA_TREATMENT = hex("8899");
const SHA_PLAN = hex("aa11");
const SHA_PREREG = hex("bb22");

/** A complete, independently valid causal manifest as a loose record so
 * individual tests can delete or blank a key without fighting the exported
 * (strictly-shaped) manifest type. */
function baseManifest(): Record<string, unknown> {
	return {
		schema_version: "simplification-experiment/v1",
		experiment_id: "experiment-u017",
		claim: {
			kind: "causal",
			statement: "The treatment reduced accepted implementation LOC in this pinned task suite.",
		},
		repository: {
			repository_id: "fixtures/simplification-u017",
			tree_sha: SHA_TREE,
			source_artifact_sha256: SHA_SOURCE,
			dirty: false,
		},
		task_suite: {
			name: "simplification-adversarial",
			version: "1.0.0",
			task_set_sha256: SHA_TASKSET,
			evaluator_sha256: SHA_EVALUATOR,
		},
		model: {
			provider: "provider",
			family: "family",
			model: "model",
			version: "2026-09-01",
			parameters_sha256: SHA_PARAMS,
		},
		environment: {
			container_image_digest: `sha256:${SHA_DEPLOCK}`,
			dependency_lock_sha256: SHA_DEPLOCK,
			harness_version: "0.1.0",
			runtime_versions: [{ name: "node", version: "22.18.0" }],
		},
		runs: {
			started_at: "2026-09-01T00:00:00.000Z",
			completed_at: "2026-09-01T01:00:00.000Z",
			sample_size: 20,
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
				receipt_sha256: SHA_RECEIPT,
			},
			completeness: {
				planned_runs: 20,
				completed_runs: 20,
				scored_runs: 20,
				coverage_path: "artifacts/coverage.json",
				coverage_sha256: SHA_COVERAGE,
			},
			raw_results_path: "artifacts/raw-results.jsonl",
			raw_results_sha256: SHA_RAW,
			analysis_output_path: "artifacts/analysis.json",
			analysis_output_sha256: SHA_ANALYSIS,
		},
		causal_design: {
			design: "randomized_paired",
			experimental_unit: "task-model-seed",
			assignment_seed: "seed-u017",
			assignment_algorithm: "sha256 parity counterbalance",
			control: { name: "baseline", instructions_sha256: SHA_CONTROL },
			treatment: { name: "simplification", instructions_sha256: SHA_TREATMENT },
			analysis_plan_sha256: SHA_PLAN,
			preregistration_sha256: SHA_PREREG,
			missing_data_policy: "Count missing terminal runs as failures.",
			blinded_evaluator: true,
		},
	};
}

/** Deep-clones the base manifest so a test can mutate a nested section without
 * affecting other tests (structuredClone: no functions/symbols in the fixture). */
function cloned(): Record<string, any> {
	return structuredClone(baseManifest());
}

describe("parseSimplificationExperimentManifest — base fixture", () => {
	it("parses the base fixture as a valid causal manifest", () => {
		const result = parseSimplificationExperimentManifest(cloned());
		expect(result.ok).toBe(true);
	});
});

describe("parseSimplificationExperimentManifest — malformed nested sections", () => {
	it("rejects a repository object missing a required key or carrying an unexpected key", () => {
		const missingKey = cloned();
		delete missingKey.repository.dirty;
		expect(parseSimplificationExperimentManifest(missingKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});

		// An extra field is rejected only by parseRepository's exactKeys check —
		// every other repository field stays valid, so this input is the one
		// that isolates the exactKeys branch from the per-field checks below it.
		const unexpectedKey = cloned();
		unexpectedKey.repository.unexpected = "x";
		expect(parseSimplificationExperimentManifest(unexpectedKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});
	});

	it("rejects a model object with a missing key, an unexpected key, or an empty scalar field", () => {
		const missingKey = cloned();
		delete missingKey.model.family;
		expect(parseSimplificationExperimentManifest(missingKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});

		// An extra field: every model field stays valid, so only exactKeys rejects it.
		const unexpectedKey = cloned();
		unexpectedKey.model.unexpected = "x";
		expect(parseSimplificationExperimentManifest(unexpectedKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});

		const emptyProvider = cloned();
		emptyProvider.model.provider = "";
		expect(parseSimplificationExperimentManifest(emptyProvider)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});
	});

	it("rejects an environment object missing a required key or carrying an unexpected key", () => {
		const missingKey = cloned();
		delete missingKey.environment.harness_version;
		expect(parseSimplificationExperimentManifest(missingKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});

		// An extra field: every environment field stays valid, so only exactKeys rejects it.
		const unexpectedKey = cloned();
		unexpectedKey.environment.unexpected = "x";
		expect(parseSimplificationExperimentManifest(unexpectedKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});
	});

	it("rejects a runs object missing a required key or carrying an unexpected key", () => {
		const missingKey = cloned();
		delete missingKey.runs.exclusions;
		expect(parseSimplificationExperimentManifest(missingKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});

		// An extra field: every runs field stays valid, so only exactKeys rejects it.
		const unexpectedKey = cloned();
		unexpectedKey.runs.unexpected = "x";
		expect(parseSimplificationExperimentManifest(unexpectedKey)).toEqual({
			ok: false,
			reason: "experiment manifest has incomplete or unpinned evidence metadata",
		});
	});
});

describe("parseSimplificationExperimentManifest — malformed causal design", () => {
	it("rejects a causal_design object missing a required key or carrying an unexpected key", () => {
		const missingKey = cloned();
		delete missingKey.causal_design.blinded_evaluator;
		expect(parseSimplificationExperimentManifest(missingKey)).toEqual({
			ok: false,
			reason: "experiment causal_design is incomplete",
		});

		// An extra field: every causal_design field stays valid, so only exactKeys rejects it.
		const unexpectedKey = cloned();
		unexpectedKey.causal_design.unexpected = "x";
		expect(parseSimplificationExperimentManifest(unexpectedKey)).toEqual({
			ok: false,
			reason: "experiment causal_design is incomplete",
		});
	});

	it("rejects a causal_design object with an empty required field", () => {
		const manifest = cloned();
		manifest.causal_design.experimental_unit = "";
		expect(parseSimplificationExperimentManifest(manifest)).toEqual({
			ok: false,
			reason: "experiment causal_design is incomplete",
		});
	});
});

describe("parseSimplificationExperimentManifest — causal/observational relationship", () => {
	it("rejects a causal claim with fewer than two experimental units", () => {
		const manifest = cloned();
		manifest.runs.sample_size = 1;
		manifest.runs.failed_runs = 0;
		manifest.outcomes.completeness.planned_runs = 1;
		manifest.outcomes.completeness.completed_runs = 1;
		manifest.outcomes.completeness.scored_runs = 1;
		expect(parseSimplificationExperimentManifest(manifest)).toEqual({
			ok: false,
			reason: "causal claims require at least two experimental units",
		});
	});

	it("rejects an observational claim that still carries a causal design", () => {
		const manifest = cloned();
		manifest.claim = {
			kind: "observational",
			statement: "The accepted commit removed lines with no controlled comparison.",
		};
		// causal_design is left populated (from baseManifest) on purpose — the
		// claim was downgraded to observational but the design was not cleared.
		expect(parseSimplificationExperimentManifest(manifest)).toEqual({
			ok: false,
			reason: "observational claims must not carry an unused causal design",
		});
	});
});

describe("parseSimplificationExperimentManifest — schema identity", () => {
	it("rejects a manifest with the wrong schema_version or an empty experiment_id", () => {
		const wrongVersion = cloned();
		wrongVersion.schema_version = "simplification-experiment/v0";
		expect(parseSimplificationExperimentManifest(wrongVersion)).toEqual({
			ok: false,
			reason: "experiment manifest version or id is invalid",
		});

		const emptyId = cloned();
		emptyId.experiment_id = "";
		expect(parseSimplificationExperimentManifest(emptyId)).toEqual({
			ok: false,
			reason: "experiment manifest version or id is invalid",
		});
	});
});
