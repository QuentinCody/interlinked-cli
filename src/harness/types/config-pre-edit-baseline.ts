// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Pre-Edit Baseline Config Type
// ===========================================
//
// Split out of config.ts (2026-09-02) to keep that file under the per-file
// line cap. Re-exported from config.ts so the public surface of ./config.ts
// is unchanged for existing importers.

/** Cached check results from before an edit, used for baseline subtraction and ratchet comparison */
export interface PreEditBaseline {
	/** Function signatures with missing return types (Set of trimmed signature text) */
	missingReturnTypes: Set<string>;
	/** Complex function signatures (Set of trimmed signature text) */
	complexFunctions: Set<string>;
	/**
	 * Per-file, per-function CRAP scores captured before the edit.
	 * Keyed by repo-relative file path, inner map keyed by "name@line".
	 * Consumed by filterToRisers() in the PostToolUse CRAP block.
	 * Optional — absent when coverage data is unavailable (fail-open).
	 */
	crapScores?: Map<string, Map<string, number>> | undefined;
	/**
	 * Code-clone similarity pairs captured before the edit.
	 * Consumed by the PostToolUse code_clones block so old duplication in a
	 * touched file is not reported as a new agent warning.
	 */
	dryCloneBaseline?: import("../checks/dry-baseline.js").DryBaseline | undefined;
	/** When this baseline was captured */
	capturedAt: number;
	/** Count of suppression directives (@ts-expect-error, @ts-expect-error, eslint-disable, biome-ignore) */
	suppressionCount: number;
	/** Count of `as any` casts */
	asAnyCastCount: number;
	/** Count of non-null assertions (`foo!.bar`) */
	nonNullAssertionCount: number;
	/** Count of unjustified casts (as X without a // SAFETY: comment) */
	unjustifiedCastCount?: number;
	/** Count of TODO / FIXME / HACK / XXX markers (Batch 7 ratchet). */
	todoMarkerCount?: number;
	/** Count of console.* statements (Batch 7 ratchet). */
	consoleStatementCount?: number;
	/** Count of exported symbols — public API surface (Batch 7 ratchet). */
	publicApiSurfaceCount?: number;
	/** Composite type-density counters: bare `: any` / `: unknown` / `: Function` / `: {}`
	 *  annotations plus untyped exported params and missing exported return types.
	 *  Optional — older callers/tests may not capture it; the ratchet check
	 *  fails open in that case. */
	typeDensity?: import("../quality-checks/ratchet-metrics.js").TypeDensityCounts;
	/** Software/model/dependency version references captured before the edit. Used by
	 *  software_version_regression to detect stale-memory downgrades. Optional — older direct test callers fail open. */
	softwareVersions?: import("../quality-checks/software-version-regression.js").SoftwareVersionReference[];
	/** Per-primitive bare-unsafe-builtin counts before the edit, keyed by wrapper name; discovered_primitive_ratchet warns on any increase. Optional — older direct test callers fail open. */
	discoveredPrimitiveViolations?: Record<string, number> | undefined;
	/** Ambient-seam counts before the edit (plan 25 lane 2); seam_ratchet warns on any rise. Optional — fails open. */
	ambientSeams?: import("../quality-checks/ratchet-metrics.js").AmbientSeamCounts | undefined;
	/** Assertion-strength counts before the edit (plan 25 lane 4); assertion_strength_ratchet warns on pure weakening. Optional — fails open. */
	assertionStrength?: import("../quality-checks/ratchet-metrics.js").AssertionStrengthCounts | undefined;
}
