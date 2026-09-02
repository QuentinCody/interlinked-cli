// ===========================================
// Simplification Agent CI — experiment evidence manifest
// ===========================================
// Impact reporting may describe observations freely, but the word "causal"
// is earned only by a fully pinned controlled-experiment manifest.

import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject } from "./json-types.js";
import {
	exactKeys,
	gitObject,
	isoTimestamp,
	nonempty,
	parseOutcomes,
	sha256,
	type SimplificationExperimentOutcomes,
	sortedUniqueStrings,
} from "./simplification-agent-ci-experiment-outcomes.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import { isPinnedExactVersion } from "./simplification-version.js";

export type {
	SimplificationExperimentCompletenessOutcome,
	SimplificationExperimentSafetyOutcome,
} from "./simplification-agent-ci-experiment-outcomes.js";

const SIMPLIFICATION_EXPERIMENT_VERSION = "simplification-experiment/v1" as const;

const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CLAIM_KINDS = ["observational", "causal"] as const;
const DESIGNS = ["randomized_paired", "randomized_parallel"] as const;

type SimplificationExperimentClaimKind = (typeof CLAIM_KINDS)[number];
type SimplificationExperimentDesignKind = (typeof DESIGNS)[number];

interface SimplificationExperimentArm {
	name: string;
	instructions_sha256: string;
}

interface SimplificationCausalDesign {
	design: SimplificationExperimentDesignKind;
	experimental_unit: string;
	assignment_seed: string;
	assignment_algorithm: string;
	control: SimplificationExperimentArm;
	treatment: SimplificationExperimentArm;
	analysis_plan_sha256: string;
	preregistration_sha256: string;
	missing_data_policy: string;
	blinded_evaluator: boolean;
}

export interface SimplificationExperimentManifest {
	schema_version: typeof SIMPLIFICATION_EXPERIMENT_VERSION;
	experiment_id: string;
	claim: {
		kind: SimplificationExperimentClaimKind;
		statement: string;
	};
	repository: {
		repository_id: string;
		tree_sha: string;
		source_artifact_sha256: string;
		dirty: false;
	};
	task_suite: {
		name: string;
		version: string;
		task_set_sha256: string;
		evaluator_sha256: string;
	};
	model: {
		provider: string;
		family: string;
		model: string;
		version: string;
		parameters_sha256: string;
	};
	environment: {
		container_image_digest: string;
		dependency_lock_sha256: string;
		harness_version: string;
		runtime_versions: Array<{ name: string; version: string }>;
	};
	runs: {
		started_at: string;
		completed_at: string;
		sample_size: number;
		failed_runs: number;
		exclusions: string[];
	};
	outcomes: SimplificationExperimentOutcomes;
	causal_design: SimplificationCausalDesign | null;
}

declare const VALID_EXPERIMENT: unique symbol;
type ValidSimplificationExperimentManifest = Readonly<SimplificationExperimentManifest> & {
	readonly [VALID_EXPERIMENT]: true;
};

type SimplificationExperimentParseResult =
	| { ok: true; manifest: ValidSimplificationExperimentManifest }
	| { ok: false; reason: string };

function isClaimKind(value: unknown): value is SimplificationExperimentClaimKind {
	return typeof value === "string" && CLAIM_KINDS.some((kind) => kind === value);
}

function isDesignKind(value: unknown): value is SimplificationExperimentDesignKind {
	return typeof value === "string" && DESIGNS.some((design) => design === value);
}

function parseClaim(value: unknown): SimplificationExperimentManifest["claim"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["kind", "statement"])) return null;
	const kind = value.kind;
	if (!isClaimKind(kind) || !nonempty(value.statement)) return null;
	return { kind, statement: value.statement };
}

function parseRepository(value: unknown): SimplificationExperimentManifest["repository"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["repository_id", "tree_sha", "source_artifact_sha256", "dirty"],
	)) return null;
	if (!nonempty(value.repository_id) || !gitObject(value.tree_sha) || !sha256(value.source_artifact_sha256)) return null;
	if (value.dirty !== false) return null;
	return {
		repository_id: value.repository_id,
		tree_sha: value.tree_sha,
		source_artifact_sha256: value.source_artifact_sha256,
		dirty: false,
	};
}

function parseTaskSuite(value: unknown): SimplificationExperimentManifest["task_suite"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "version", "task_set_sha256", "evaluator_sha256"])) return null;
	if (!nonempty(value.name) || !nonempty(value.version) || !sha256(value.task_set_sha256) || !sha256(value.evaluator_sha256)) return null;
	if (!isPinnedExactVersion(value.version)) return null;
	return {
		name: value.name,
		version: value.version,
		task_set_sha256: value.task_set_sha256,
		evaluator_sha256: value.evaluator_sha256,
	};
}

function parseModel(value: unknown): SimplificationExperimentManifest["model"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["provider", "family", "model", "version", "parameters_sha256"],
	)) return null;
	if (
		!nonempty(value.provider) || !nonempty(value.family) || !nonempty(value.model) ||
		!nonempty(value.version) || !sha256(value.parameters_sha256)
	) return null;
	if (!isPinnedExactVersion(value.version)) return null;
	return {
		provider: value.provider,
		family: value.family,
		model: value.model,
		version: value.version,
		parameters_sha256: value.parameters_sha256,
	};
}

function parseRuntimeVersions(value: unknown): Array<{ name: string; version: string }> | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const result: Array<{ name: string; version: string }> = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !exactKeys(entry, ["name", "version"])) return null;
		if (!nonempty(entry.name) || !nonempty(entry.version)) return null;
		if (!isPinnedExactVersion(entry.version)) return null;
		result.push({ name: entry.name, version: entry.version });
	}
	const names = result.map((entry) => entry.name);
	if (new Set(names).size !== names.length) return null;
	if (!names.every((name, index) => index === 0 || name >= (names[index - 1] ?? ""))) return null;
	return result;
}

function parseEnvironment(value: unknown): SimplificationExperimentManifest["environment"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["container_image_digest", "dependency_lock_sha256", "harness_version", "runtime_versions"],
	)) return null;
	const runtime_versions = parseRuntimeVersions(value.runtime_versions);
	if (
		typeof value.container_image_digest !== "string" ||
		!IMAGE_DIGEST_PATTERN.test(value.container_image_digest) ||
		!sha256(value.dependency_lock_sha256) || !nonempty(value.harness_version) || !runtime_versions
	) return null;
	if (!isPinnedExactVersion(value.harness_version)) return null;
	return {
		container_image_digest: value.container_image_digest,
		dependency_lock_sha256: value.dependency_lock_sha256,
		harness_version: value.harness_version,
		runtime_versions,
	};
}

function parseRuns(value: unknown): SimplificationExperimentManifest["runs"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["started_at", "completed_at", "sample_size", "failed_runs", "exclusions"],
	)) return null;
	if (!isoTimestamp(value.started_at) || !isoTimestamp(value.completed_at)) return null;
	if (Date.parse(value.completed_at) < Date.parse(value.started_at)) return null;
	if (!Number.isInteger(value.sample_size) || typeof value.sample_size !== "number" || value.sample_size < 1) return null;
	if (!Number.isInteger(value.failed_runs) || typeof value.failed_runs !== "number" || value.failed_runs < 0) return null;
	if (value.failed_runs > value.sample_size || !sortedUniqueStrings(value.exclusions)) return null;
	return {
		started_at: value.started_at,
		completed_at: value.completed_at,
		sample_size: value.sample_size,
		failed_runs: value.failed_runs,
		exclusions: [...value.exclusions],
	};
}

function completenessMatchesRuns(
	outcomes: SimplificationExperimentManifest["outcomes"],
	runs: SimplificationExperimentManifest["runs"],
): boolean {
	return outcomes.completeness.planned_runs === runs.sample_size
		&& outcomes.completeness.completed_runs === runs.sample_size - runs.failed_runs;
}

function parseArm(value: unknown): SimplificationExperimentArm | null {
	if (!isJsonObject(value) || !exactKeys(value, ["name", "instructions_sha256"])) return null;
	if (!nonempty(value.name) || !sha256(value.instructions_sha256)) return null;
	return { name: value.name, instructions_sha256: value.instructions_sha256 };
}

function parseCausalDesign(value: unknown): SimplificationCausalDesign | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"design",
			"experimental_unit",
			"assignment_seed",
			"assignment_algorithm",
			"control",
			"treatment",
			"analysis_plan_sha256",
			"preregistration_sha256",
			"missing_data_policy",
			"blinded_evaluator",
		],
	)) return null;
	const design = value.design;
	if (!isDesignKind(design)) return null;
	if (
		!nonempty(value.experimental_unit) || !nonempty(value.assignment_seed) ||
		!nonempty(value.assignment_algorithm) || !nonempty(value.missing_data_policy)
	) return null;
	const control = parseArm(value.control);
	const treatment = parseArm(value.treatment);
	if (!control || !treatment || control.name === treatment.name) return null;
	if (control.instructions_sha256 === treatment.instructions_sha256) return null;
	if (!sha256(value.analysis_plan_sha256) || !sha256(value.preregistration_sha256)) return null;
	if (typeof value.blinded_evaluator !== "boolean") return null;
	return {
		design,
		experimental_unit: value.experimental_unit,
		assignment_seed: value.assignment_seed,
		assignment_algorithm: value.assignment_algorithm,
		control,
		treatment,
		analysis_plan_sha256: value.analysis_plan_sha256,
		preregistration_sha256: value.preregistration_sha256,
		missing_data_policy: value.missing_data_policy,
		blinded_evaluator: value.blinded_evaluator,
	};
}

function freezeRecursively<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const member of Object.values(value)) freezeRecursively(member);
	}
	return value;
}

function causalRelationshipError(
	claim: SimplificationExperimentManifest["claim"],
	runs: SimplificationExperimentManifest["runs"],
	causalDesign: SimplificationCausalDesign | null,
): string | null {
	if (claim.kind === "causal" && causalDesign === null) {
		return "causal claims require a complete controlled-experiment design";
	}
	if (claim.kind === "causal" && runs.sample_size < 2) {
		return "causal claims require at least two experimental units";
	}
	if (claim.kind === "observational" && causalDesign !== null) {
		return "observational claims must not carry an unused causal design";
	}
	return null;
}

/** The seven evidence sections, all present and individually well-formed, or null. */
type SimplificationExperimentSections = Pick<
	SimplificationExperimentManifest,
	"claim" | "repository" | "task_suite" | "model" | "environment" | "runs" | "outcomes"
>;

function parseManifestSections(input: JsonObject): SimplificationExperimentSections | null {
	const claim = parseClaim(input.claim);
	const repository = parseRepository(input.repository);
	const task_suite = parseTaskSuite(input.task_suite);
	const model = parseModel(input.model);
	const environment = parseEnvironment(input.environment);
	const runs = parseRuns(input.runs);
	const outcomes = parseOutcomes(input.outcomes);
	if (!claim || !repository || !task_suite || !model || !environment || !runs || !outcomes) {
		return null;
	}
	return { claim, repository, task_suite, model, environment, runs, outcomes };
}

export function parseSimplificationExperimentManifest(
	input: unknown,
): SimplificationExperimentParseResult {
	if (!isJsonObject(input) || !exactKeys(
		input,
		[
			"schema_version",
			"experiment_id",
			"claim",
			"repository",
			"task_suite",
			"model",
			"environment",
			"runs",
			"outcomes",
			"causal_design",
		],
	)) return { ok: false, reason: "experiment manifest has an unknown or missing top-level field" };
	if (input.schema_version !== SIMPLIFICATION_EXPERIMENT_VERSION || !nonempty(input.experiment_id)) {
		return { ok: false, reason: "experiment manifest version or id is invalid" };
	}
	const sections = parseManifestSections(input);
	if (!sections) {
		return { ok: false, reason: "experiment manifest has incomplete or unpinned evidence metadata" };
	}
	if (!completenessMatchesRuns(sections.outcomes, sections.runs)) {
		return { ok: false, reason: "experiment completeness counts do not match run receipts" };
	}
	const causal_design = input.causal_design === null ? null : parseCausalDesign(input.causal_design);
	if (input.causal_design !== null && !causal_design) {
		return { ok: false, reason: "experiment causal_design is incomplete" };
	}
	const causalError = causalRelationshipError(sections.claim, sections.runs, causal_design);
	if (causalError) return { ok: false, reason: causalError };
	const manifest: SimplificationExperimentManifest = {
		schema_version: SIMPLIFICATION_EXPERIMENT_VERSION,
		experiment_id: input.experiment_id,
		claim: sections.claim,
		repository: sections.repository,
		task_suite: sections.task_suite,
		model: sections.model,
		environment: sections.environment,
		runs: sections.runs,
		outcomes: sections.outcomes,
		causal_design,
	};
	freezeRecursively(manifest);
	// SAFETY: exact-shape parsers constructed every nested field, causal
	// metadata was checked against claim kind, and the result is frozen.
	return { ok: true, manifest: manifest as ValidSimplificationExperimentManifest };
}

export function simplificationExperimentManifestSha256(
	manifest: ValidSimplificationExperimentManifest,
): string {
	return createHash("sha256")
		.update(canonicalSimplificationAgentCiJson(manifest), "utf8")
		.digest("hex");
}
