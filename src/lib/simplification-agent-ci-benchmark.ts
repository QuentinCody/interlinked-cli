// ===========================================
// Simplification Agent CI — positive benchmark canaries
// ===========================================
// Adversarial fixtures prove that attractive unsafe cuts are rejected. These
// paired fixtures prove the complementary property: an overbuilt variant must
// rank above its behaviorally equivalent minimal variant for every remedy.

import { createHash } from "node:crypto";
import { isJsonObject } from "./json-types.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationRemedy,
} from "./simplification-types.js";

/** Public wire-version constant for Agent CI benchmark producers. */
const SIMPLIFICATION_BENCHMARK_FIXTURE_VERSION =
	"simplification-benchmark-pair/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface SimplificationBenchmarkFile {
	path: string;
	language: string;
	content: string;
}

export interface SimplificationBenchmarkFixture {
	schema_version: typeof SIMPLIFICATION_BENCHMARK_FIXTURE_VERSION;
	fixture_id: string;
	remedy: SimplificationRemedy;
	contract: {
		description: string;
		required_behaviors: string[];
		scorer_sha256: string;
	};
	variants: {
		overbuilt: SimplificationBenchmarkFile[];
		minimal: SimplificationBenchmarkFile[];
	};
	expected: {
		overbuilt_matching_findings_min: number;
		minimal_total_findings_max: number;
		rank_margin_min: number;
		protected_false_positives_max: number;
	};
}

interface SimplificationBenchmarkFindingObservation {
	fingerprint: string;
	remedy: SimplificationRemedy;
	score: number;
	protected_behavior: boolean;
}

export interface SimplificationBenchmarkVariantObservation {
	variant: "overbuilt" | "minimal";
	scorer_passed: boolean;
	checks_passed: boolean;
	findings: SimplificationBenchmarkFindingObservation[];
}

interface SimplificationBenchmarkPairEvaluation {
	passed: boolean;
	failures: string[];
}

interface SimplificationBenchmarkSuiteReceipt {
	fixture_count: number;
	fixture_sha256: string;
	remedies_covered: SimplificationRemedy[];
	complete_remedy_coverage: boolean;
}

type SimplificationBenchmarkFixtureParseResult =
	| { ok: true; fixture: SimplificationBenchmarkFixture }
	| { ok: false; reason: string };

function exactKeys(value: object, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function isRepoPath(value: unknown): value is string {
	return nonempty(value)
		&& !value.startsWith("/")
		&& !value.includes("\\")
		&& value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function canonicalStrings(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every(nonempty)) return false;
	if (new Set(value).size !== value.length) return false;
	return value.every((entry, index) => index === 0 || entry >= (value[index - 1] ?? ""));
}

function remedy(value: unknown): value is SimplificationRemedy {
	return typeof value === "string"
		&& SIMPLIFICATION_REMEDIES.some((candidate) => candidate === value);
}

function nonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseFiles(value: unknown): SimplificationBenchmarkFile[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const files: SimplificationBenchmarkFile[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !exactKeys(entry, ["path", "language", "content"])) return null;
		if (!isRepoPath(entry.path) || !nonempty(entry.language) || typeof entry.content !== "string") {
			return null;
		}
		files.push({ path: entry.path, language: entry.language, content: entry.content });
	}
	const paths = files.map((file) => file.path);
	if (new Set(paths).size !== paths.length) return null;
	return paths.every((path, index) => index === 0 || path >= (paths[index - 1] ?? ""))
		? files
		: null;
}

function parseContract(value: unknown): SimplificationBenchmarkFixture["contract"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		["description", "required_behaviors", "scorer_sha256"],
	)) return null;
	if (!nonempty(value.description) || !canonicalStrings(value.required_behaviors)) return null;
	if (typeof value.scorer_sha256 !== "string" || !SHA256_PATTERN.test(value.scorer_sha256)) {
		return null;
	}
	return {
		description: value.description,
		required_behaviors: [...value.required_behaviors],
		scorer_sha256: value.scorer_sha256,
	};
}

function parseExpected(value: unknown): SimplificationBenchmarkFixture["expected"] | null {
	if (!isJsonObject(value) || !exactKeys(
		value,
		[
			"overbuilt_matching_findings_min",
			"minimal_total_findings_max",
			"rank_margin_min",
			"protected_false_positives_max",
		],
	)) return null;
	if (
		!nonNegativeInteger(value.overbuilt_matching_findings_min)
		|| value.overbuilt_matching_findings_min < 1
		|| !nonNegativeInteger(value.minimal_total_findings_max)
		|| typeof value.rank_margin_min !== "number"
		|| !Number.isFinite(value.rank_margin_min)
		|| value.rank_margin_min <= 0
		|| !nonNegativeInteger(value.protected_false_positives_max)
	) return null;
	return {
		overbuilt_matching_findings_min: value.overbuilt_matching_findings_min,
		minimal_total_findings_max: value.minimal_total_findings_max,
		rank_margin_min: value.rank_margin_min,
		protected_false_positives_max: value.protected_false_positives_max,
	};
}

export function parseSimplificationBenchmarkFixture(
	input: unknown,
): SimplificationBenchmarkFixtureParseResult {
	if (!isJsonObject(input) || !exactKeys(
		input,
		["schema_version", "fixture_id", "remedy", "contract", "variants", "expected"],
	)) return { ok: false, reason: "benchmark fixture has an unknown or missing field" };
	if (
		input.schema_version !== SIMPLIFICATION_BENCHMARK_FIXTURE_VERSION
		|| !nonempty(input.fixture_id)
		|| !remedy(input.remedy)
		|| !isJsonObject(input.variants)
		|| !exactKeys(input.variants, ["overbuilt", "minimal"])
	) return { ok: false, reason: "benchmark fixture identity or variants are invalid" };
	const contract = parseContract(input.contract);
	const overbuilt = parseFiles(input.variants.overbuilt);
	const minimal = parseFiles(input.variants.minimal);
	const expected = parseExpected(input.expected);
	if (!contract || !overbuilt || !minimal || !expected) {
		return { ok: false, reason: "benchmark fixture contract, files, or expectations are invalid" };
	}
	return {
		ok: true,
		fixture: {
			schema_version: SIMPLIFICATION_BENCHMARK_FIXTURE_VERSION,
			fixture_id: input.fixture_id,
			remedy: input.remedy,
			contract,
			variants: { overbuilt, minimal },
			expected,
		},
	};
}

function topScore(observation: SimplificationBenchmarkVariantObservation): number {
	return observation.findings.reduce((highest, finding) => Math.max(highest, finding.score), 0);
}

export function evaluateSimplificationBenchmarkPair(
	fixture: SimplificationBenchmarkFixture,
	overbuilt: SimplificationBenchmarkVariantObservation,
	minimal: SimplificationBenchmarkVariantObservation,
): SimplificationBenchmarkPairEvaluation {
	const failures: string[] = [];
	if (overbuilt.variant !== "overbuilt" || minimal.variant !== "minimal") {
		failures.push("variant_labels_mismatch");
	}
	if (!overbuilt.scorer_passed || !minimal.scorer_passed) failures.push("scorer_self_test_failed");
	if (!overbuilt.checks_passed || !minimal.checks_passed) failures.push("behavior_checks_failed");
	const matching = overbuilt.findings.filter((finding) => finding.remedy === fixture.remedy);
	if (matching.length < fixture.expected.overbuilt_matching_findings_min) {
		failures.push("overbuilt_true_positive_missing");
	}
	if (minimal.findings.length > fixture.expected.minimal_total_findings_max) {
		failures.push("minimal_variant_overcalled");
	}
	if (topScore(overbuilt) - topScore(minimal) < fixture.expected.rank_margin_min) {
		failures.push("overbuilt_rank_margin_not_met");
	}
	const protectedFalsePositives = [...overbuilt.findings, ...minimal.findings]
		.filter((finding) => finding.protected_behavior).length;
	if (protectedFalsePositives > fixture.expected.protected_false_positives_max) {
		failures.push("protected_behavior_false_positive");
	}
	return { passed: failures.length === 0, failures };
}

export function buildSimplificationBenchmarkSuiteReceipt(
	fixtures: readonly SimplificationBenchmarkFixture[],
): SimplificationBenchmarkSuiteReceipt {
	const ordered = [...fixtures].sort((left, right) => {
		if (left.fixture_id < right.fixture_id) return -1;
		if (left.fixture_id > right.fixture_id) return 1;
		return 0;
	});
	const covered = new Set(ordered.map((fixture) => fixture.remedy));
	const remedies_covered = SIMPLIFICATION_REMEDIES.filter((entry) => covered.has(entry));
	return {
		fixture_count: ordered.length,
		fixture_sha256: createHash("sha256")
			.update(canonicalSimplificationAgentCiJson(ordered), "utf8")
			.digest("hex"),
		remedies_covered,
		complete_remedy_coverage: remedies_covered.length === SIMPLIFICATION_REMEDIES.length,
	};
}
