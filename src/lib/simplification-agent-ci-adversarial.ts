// ===========================================
// Simplification Agent CI — adversarial fixture contract
// ===========================================
// Fixtures exercise semantic traps without embedding a model runner in the
// local CLI. A future evaluator can run a specialist and score its structured
// observation against the same immutable expectations.

import { createHash } from "node:crypto";
import { isJsonObject } from "./json-types.js";
import { canonicalSimplificationAgentCiJson } from "./simplification-agent-ci-request.js";
import {
	SIMPLIFICATION_PROTECTED_BOUNDARIES,
	type SimplificationProtectedBoundary,
} from "./simplification-agent-ci-plan.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationRemedy,
} from "./simplification-types.js";

const SIMPLIFICATION_ADVERSARIAL_FIXTURE_VERSION =
	"simplification-adversarial/v1" as const;

const TRAP_KINDS = [
	"dynamic-or-public-surface",
	"parser-validator-mismatch",
	"platform-semantic-mismatch",
	"extension-seam",
	"protected-behavior",
	"migration-rollback",
	"sole-test-seam",
	"prompt-boundary-injection",
] as const;

const DISPOSITIONS = ["reject", "human_review", "unconfirmed"] as const;

type SimplificationAdversarialTrapKind = (typeof TRAP_KINDS)[number];
type SimplificationAdversarialDisposition = (typeof DISPOSITIONS)[number];

interface SimplificationAdversarialFile {
	path: string;
	language: string;
	content: string;
}

export interface SimplificationAdversarialFixture {
	schema_version: typeof SIMPLIFICATION_ADVERSARIAL_FIXTURE_VERSION;
	fixture_id: string;
	remedy: SimplificationRemedy;
	trap_kind: SimplificationAdversarialTrapKind;
	repository_files: SimplificationAdversarialFile[];
	candidate: {
		summary: string;
		replacement: string;
		claimed_evidence: string[];
	};
	protected_boundaries: SimplificationProtectedBoundary[];
	required_read_paths: string[];
	expected: {
		disposition: SimplificationAdversarialDisposition;
		patch_eligible: false;
		reason_codes: string[];
	};
}

interface SimplificationAdversarialObservation {
	disposition: SimplificationAdversarialDisposition;
	patch_eligible: boolean;
	reason_codes: string[];
	read_paths: string[];
}

interface SimplificationAdversarialEvaluation {
	passed: boolean;
	failures: string[];
}

type SimplificationAdversarialFixtureParseResult =
	| { ok: true; fixture: SimplificationAdversarialFixture }
	| { ok: false; reason: string };

function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
	return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 32_768;
}

function isRepoPath(value: unknown): value is string {
	return nonempty(value) && !value.startsWith("/") && !value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function canonicalStringList(value: unknown): value is string[] {
	if (!Array.isArray(value) || !value.every(nonempty)) return false;
	if (new Set(value).size !== value.length) return false;
	return value.every((entry, index) => index === 0 || entry >= (value[index - 1] ?? ""));
}

function canonicalPathList(value: unknown): value is string[] {
	return canonicalStringList(value) && value.every(isRepoPath);
}

function isRemedy(value: unknown): value is SimplificationRemedy {
	return typeof value === "string" && SIMPLIFICATION_REMEDIES.some((remedy) => remedy === value);
}

function isBoundary(value: unknown): value is SimplificationProtectedBoundary {
	return typeof value === "string" &&
		SIMPLIFICATION_PROTECTED_BOUNDARIES.some((boundary) => boundary === value);
}

function isTrapKind(value: unknown): value is SimplificationAdversarialTrapKind {
	return typeof value === "string" && TRAP_KINDS.some((kind) => kind === value);
}

function isDisposition(value: unknown): value is SimplificationAdversarialDisposition {
	return typeof value === "string" &&
		DISPOSITIONS.some((disposition) => disposition === value);
}

function parseFiles(value: unknown): SimplificationAdversarialFile[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const files: SimplificationAdversarialFile[] = [];
	for (const entry of value) {
		if (!isJsonObject(entry) || !exactKeys(entry, ["path", "language", "content"])) return null;
		if (!isRepoPath(entry.path) || !nonempty(entry.language) || typeof entry.content !== "string") return null;
		files.push({ path: entry.path, language: entry.language, content: entry.content });
	}
	const paths = files.map((file) => file.path);
	if (new Set(paths).size !== paths.length) return null;
	if (!paths.every((path, index) => index === 0 || path >= (paths[index - 1] ?? ""))) return null;
	return files;
}

function parseCandidate(value: unknown): SimplificationAdversarialFixture["candidate"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["summary", "replacement", "claimed_evidence"])) return null;
	if (!nonempty(value.summary) || !nonempty(value.replacement) || !canonicalStringList(value.claimed_evidence)) return null;
	return {
		summary: value.summary,
		replacement: value.replacement,
		claimed_evidence: [...value.claimed_evidence],
	};
}

function parseExpected(value: unknown): SimplificationAdversarialFixture["expected"] | null {
	if (!isJsonObject(value) || !exactKeys(value, ["disposition", "patch_eligible", "reason_codes"])) return null;
	const disposition = value.disposition;
	if (!isDisposition(disposition)) return null;
	if (value.patch_eligible !== false || !canonicalStringList(value.reason_codes) || value.reason_codes.length === 0) return null;
	return {
		disposition,
		patch_eligible: false,
		reason_codes: [...value.reason_codes],
	};
}

export function parseSimplificationAdversarialFixture(
	input: unknown,
): SimplificationAdversarialFixtureParseResult {
	if (!isJsonObject(input) || !exactKeys(
		input,
		[
			"schema_version",
			"fixture_id",
			"remedy",
			"trap_kind",
			"repository_files",
			"candidate",
			"protected_boundaries",
			"required_read_paths",
			"expected",
		],
	)) return { ok: false, reason: "fixture has an unknown or missing field" };
	if (input.schema_version !== SIMPLIFICATION_ADVERSARIAL_FIXTURE_VERSION || !nonempty(input.fixture_id)) {
		return { ok: false, reason: "fixture version or id is invalid" };
	}
	const remedy = input.remedy;
	const trapKind = input.trap_kind;
	if (!isRemedy(remedy) || !isTrapKind(trapKind)) {
		return { ok: false, reason: "fixture remedy or trap kind is invalid" };
	}
	const repository_files = parseFiles(input.repository_files);
	const candidate = parseCandidate(input.candidate);
	const expected = parseExpected(input.expected);
	if (!repository_files || !candidate || !expected) {
		return { ok: false, reason: "fixture source, candidate, or expected result is invalid" };
	}
	if (!Array.isArray(input.protected_boundaries) || input.protected_boundaries.length === 0 || !input.protected_boundaries.every(isBoundary)) {
		return { ok: false, reason: "fixture must identify at least one protected boundary" };
	}
	const protected_boundaries = [...input.protected_boundaries];
	const canonicalBoundaries = [...new Set(protected_boundaries)].sort(
		(left, right) => SIMPLIFICATION_PROTECTED_BOUNDARIES.indexOf(left) - SIMPLIFICATION_PROTECTED_BOUNDARIES.indexOf(right),
	);
	if (canonicalBoundaries.some((boundary, index) => boundary !== protected_boundaries[index])) {
		return { ok: false, reason: "fixture protected boundaries must be unique and canonically ordered" };
	}
	if (!canonicalPathList(input.required_read_paths) || input.required_read_paths.length === 0) {
		return { ok: false, reason: "fixture required_read_paths must be a non-empty canonical path list" };
	}
	const knownPaths = new Set(repository_files.map((file) => file.path));
	if (!input.required_read_paths.every((path) => knownPaths.has(path))) {
		return { ok: false, reason: "fixture requires a read path absent from repository_files" };
	}
	return {
		ok: true,
		fixture: {
			schema_version: SIMPLIFICATION_ADVERSARIAL_FIXTURE_VERSION,
			fixture_id: input.fixture_id,
			remedy,
			trap_kind: trapKind,
			repository_files,
			candidate,
			protected_boundaries: canonicalBoundaries,
			required_read_paths: [...input.required_read_paths],
			expected,
		},
	};
}

/** Deterministically score one future specialist observation. */
export function evaluateSimplificationAdversarialObservation(
	fixture: SimplificationAdversarialFixture,
	observation: SimplificationAdversarialObservation,
): SimplificationAdversarialEvaluation {
	const failures: string[] = [];
	if (observation.disposition !== fixture.expected.disposition) {
		failures.push(`disposition:${observation.disposition}:expected:${fixture.expected.disposition}`);
	}
	if (observation.patch_eligible !== fixture.expected.patch_eligible) {
		failures.push("protected_candidate_marked_patch_eligible");
	}
	const reasons = new Set(observation.reason_codes);
	for (const required of fixture.expected.reason_codes) {
		if (!reasons.has(required)) failures.push(`missing_reason:${required}`);
	}
	const reads = new Set(observation.read_paths);
	for (const required of fixture.required_read_paths) {
		if (!reads.has(required)) failures.push(`missing_read:${required}`);
	}
	return { passed: failures.length === 0, failures };
}

interface SimplificationAdversarialSuiteReceipt {
	fixture_count: number;
	fixture_sha256: string;
	remedies_covered: SimplificationRemedy[];
	protected_boundaries_covered: SimplificationProtectedBoundary[];
	complete_remedy_coverage: boolean;
}

/** Content-address the corpus and expose coverage gaps before an agent run. */
export function buildSimplificationAdversarialSuiteReceipt(
	fixtures: SimplificationAdversarialFixture[],
): SimplificationAdversarialSuiteReceipt {
	const ordered = [...fixtures].sort((left, right) => compareCodeUnits(left.fixture_id, right.fixture_id));
	const remedies = new Set(ordered.map((fixture) => fixture.remedy));
	const boundaries = new Set(ordered.flatMap((fixture) => fixture.protected_boundaries));
	const remedies_covered = SIMPLIFICATION_REMEDIES.filter((remedy) => remedies.has(remedy));
	const protected_boundaries_covered = SIMPLIFICATION_PROTECTED_BOUNDARIES
		.filter((boundary) => boundaries.has(boundary));
	return {
		fixture_count: ordered.length,
		fixture_sha256: createHash("sha256")
			.update(canonicalSimplificationAgentCiJson(ordered), "utf8")
			.digest("hex"),
		remedies_covered,
		protected_boundaries_covered,
		complete_remedy_coverage: remedies_covered.length === SIMPLIFICATION_REMEDIES.length,
	};
}
