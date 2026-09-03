// ===========================================
// Simplification Agent CI — plan primitives
// ===========================================
// Shared vocabulary, ordering, hashing, and shape predicates used by both the
// P4 orchestration plan and the P5 validation plan. Kept dependency-light so
// neither plan module has to import the other.

import { createHash } from "node:crypto";
import { matchesAnyGlob } from "./path-glob.js";
import {
	canonicalSimplificationAgentCiJson,
	type ValidSimplificationAgentCiRequest,
} from "./simplification-agent-ci-request.js";
import {
	SIMPLIFICATION_REMEDIES,
	type SimplificationRemedy,
} from "./simplification-types.js";

export const SIMPLIFICATION_PROTECTED_BOUNDARIES = [
	"authorization",
	"trust-boundary-validation",
	"secret-handling",
	"data-loss-prevention",
	"migrations-and-rollback",
	"accessibility",
	"compatibility",
	"auditability",
	"sole-nontrivial-test",
] as const;

export type SimplificationProtectedBoundary =
	(typeof SIMPLIFICATION_PROTECTED_BOUNDARIES)[number];

export type SimplificationPlanParseResult<T> =
	| { ok: true; plan: T }
	| { ok: false; reason: string };

const PROMPT_BOUNDARY_TAGS = [
	"repository_input",
	"repository_instructions",
	"changed_files",
	"deterministic_evidence",
	"prior_findings",
	"specialist_output",
	"contract_evidence",
] as const;

const BOUNDARY_TAG_PATTERN = new RegExp(
	`</?(?:${PROMPT_BOUNDARY_TAGS.join("|")})[^>]*>`,
	"gi",
);

/** Strip coordinator-owned boundary tags from untrusted repository text. */
export function sanitizeSimplificationPromptInput(value: string): string {
	return value.replace(BOUNDARY_TAG_PATTERN, "");
}

export function remedyOrder(remedy: SimplificationRemedy): number {
	return SIMPLIFICATION_REMEDIES.indexOf(remedy);
}

export function boundaryOrder(boundary: SimplificationProtectedBoundary): number {
	return SIMPLIFICATION_PROTECTED_BOUNDARIES.indexOf(boundary);
}

export function compareCodeUnits(left: string, right: string): number {
	if (left < right) return -1;
	return left > right ? 1 : 0;
}

export function sha256Canonical(value: unknown): string {
	return createHash("sha256")
		.update(canonicalSimplificationAgentCiJson(value), "utf8")
		.digest("hex");
}

export function requireUniqueRepositoryPaths(values: unknown, location: string): string[] {
	if (!Array.isArray(values)) throw new TypeError(`${location} must be an array`);
	if (values.length > 100_000) {
		throw new TypeError(`${location} must contain at most 100000 paths`);
	}
	if (!values.every(isRepoPath)) {
		throw new TypeError(`${location} must contain normalized repository-relative paths`);
	}
	if (new Set(values).size !== values.length) {
		throw new TypeError(`${location} must not contain duplicates`);
	}
	return [...values].sort(compareCodeUnits);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function pathIsSelectedByRequest(
	request: ValidSimplificationAgentCiRequest,
	path: string,
): boolean {
	const included = request.scope.includes.length === 0 ||
		matchesAnyGlob(path, request.scope.includes);
	return included && !matchesAnyGlob(path, request.scope.excludes);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isRepoPath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
		!value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function isRemedy(value: unknown): value is SimplificationRemedy {
	return typeof value === "string" && SIMPLIFICATION_REMEDIES.some((remedy) => remedy === value);
}

export function isBoundary(value: unknown): value is SimplificationProtectedBoundary {
	return typeof value === "string" &&
		SIMPLIFICATION_PROTECTED_BOUNDARIES.some((boundary) => boundary === value);
}
