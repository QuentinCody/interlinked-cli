// ===========================================
// Simplification Agent CI request — cross-field shape rules
// ===========================================
// Pure cross-field checks lifted out of the strict request parser. They take
// already-parsed primitives, so the parser keeps one readable control flow and
// each rule stays independently testable.

const MAX_VALIDATION_CANDIDATES = 100;

/** Scope list fields, narrowed as a set once every member has the right shape. */
export interface SimplificationAgentCiScopeFields {
	head_sha: string;
	paths: string[];
	includes: string[];
	excludes: string[];
}

/** Cross-field scope rules: base_sha pairing and per-kind path cardinality. */
export function scopeConsistencyReason(
	kind: string,
	base_sha: string | null,
	paths: unknown,
): string | null {
	if (
		(kind === "diff" && base_sha === null) ||
		(kind !== "diff" && base_sha !== null)
	) return "request.scope.base_sha is required only for diff scope";
	if (kind === "repository" && Array.isArray(paths) && paths.length !== 0) {
		return "request.scope.paths must be empty for repository scope";
	}
	if (kind === "paths" && Array.isArray(paths) && paths.length === 0) {
		return "request.scope.paths must not be empty for paths scope";
	}
	return null;
}

/** Narrow the four scope list fields together, or report the set as invalid. */
export function narrowScopeFields(
	head_sha: unknown,
	paths: unknown,
	includes: unknown,
	excludes: unknown,
): SimplificationAgentCiScopeFields | null {
	if (
		typeof head_sha !== "string" || !Array.isArray(paths) ||
		!Array.isArray(includes) || !Array.isArray(excludes)
	) return null;
	return { head_sha, paths, includes, excludes };
}

/** Candidate ceiling: the narrowed integer, or the parse failure reason. */
export function checkedCandidateCount(value: unknown): number | { reason: string } {
	if (
		typeof value !== "number" || !Number.isInteger(value) ||
		value < 0 || value > MAX_VALIDATION_CANDIDATES
	) {
		return { reason: "request.validation.max_candidates must be an integer from 0 through 100" };
	}
	return value;
}

/** Per-mode validation rules binding the check plan to the candidate budget. */
export function validationModeReason(
	mode: string,
	check_plan_sha256: string | null,
	max_candidates: number,
): string | null {
	if (mode === "none" && (check_plan_sha256 !== null || max_candidates !== 0)) {
		return "request.validation none mode must omit a check plan and use zero candidates";
	}
	if (mode === "candidate" && (typeof check_plan_sha256 !== "string" || max_candidates === 0)) {
		return "request.validation candidate mode requires a check plan and at least one candidate";
	}
	return null;
}
