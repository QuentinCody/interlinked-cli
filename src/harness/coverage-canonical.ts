// ===========================================
// Canonical Coverage Model — language-agnostic
// ===========================================
// The single internal representation every coverage source normalizes into,
// so the ratchet, CRAP, per-test map, and gate are written once and every
// language flows through them. Native engines (v8/istanbul, coverage.py,
// cargo-llvm-cov, JaCoCo, gcov) are wrapped, never reimplemented; their output
// is converted here. LCOV is the primary interchange format (`coverage-lcov.ts`),
// Cobertura the planned fallback. Nothing in this module is TS- or JS-specific.

/** A single coverage dimension: covered / total with a derived percentage. */
interface CanonicalMetric {
	covered: number;
	total: number;
	/** 0–100. A file with no countable entities (total === 0) is vacuously 100%. */
	pct: number;
}

/** Per-function coverage. `hits` is entry count (0 = never executed). */
export interface CanonicalFunction {
	name: string;
	/** 1-based start line. */
	line: number;
	hits: number;
}

/** Per-file coverage, normalized and engine-agnostic. */
export interface CanonicalFileCoverage {
	/** Repo-relative, POSIX-separated path. */
	path: string;
	lines: CanonicalMetric;
	branches: CanonicalMetric;
	functions: CanonicalMetric;
	/** Per-function entries; empty when the source emits no function records. */
	perFunction: CanonicalFunction[];
	/**
	 * 1-based line number → hit count. Lets downstream attribute *per-function*
	 * line coverage (CRAP) by intersecting these with function line-ranges —
	 * the detail LCOV's FN/FNDA (entry-count only) can't give on its own.
	 */
	lineHits: Map<number, number>;
}

/** Provenance of a canonical coverage set — which engine/format produced it. */
export type CoverageSource = "lcov" | "cobertura" | "istanbul-json" | "v8-json";

/** A whole coverage run, normalized. */
export interface CanonicalCoverage {
	/** Keyed by repo-relative path. */
	files: Map<string, CanonicalFileCoverage>;
	source: CoverageSource;
}

/**
 * Build a metric from covered/total, deriving pct.
 * `total === 0` ⇒ 100 (nothing to cover is vacuously fully covered — matches
 * the istanbul/LCOV convention and avoids penalizing type-only / no-op files).
 */
export function metric(covered: number, total: number): CanonicalMetric {
	const pct = total === 0 ? 100 : (covered / total) * 100;
	return { covered, total, pct };
}
