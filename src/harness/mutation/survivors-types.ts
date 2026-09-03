// ===========================================
// Per-edit mutation — survivor work-list row/summary shapes
// ===========================================
// Pure type contracts for the survivor work-list computed by `survivors.ts`.
// Split out because the shapes (what a caller reads) and the fold that builds
// them (how it is computed) are two different things to review; this module
// carries zero runtime.

import type { SurvivorDispositionKind } from "./disposition.js";
import type { MeasurementProvenance, StableId } from "./types.js";

/**
 * Which survivors to report.
 *
 * `includeDispositioned` defaults to FALSE because a dispositioned survivor is
 * already answered — it carries a certificate, a dead-code verdict, or a
 * recorded counterexample search — and mixing it into the work-list re-charges
 * an agent for work someone already did. The count is still reported, never
 * hidden.
 */
export interface SurvivorFilter {
	/** Case-insensitive substring match on the repo-relative POSIX path. */
	file?: string | undefined;
	/** Case-insensitive substring match on the engine's mutator name. */
	mutator?: string | undefined;
	/** Report survivors that already carry a disposition (default: false). */
	includeDispositioned?: boolean | undefined;
	/**
	 * Does this path still exist in the working tree? A manifest outlives the
	 * files it measured (nothing prunes deleted paths on load), so a repo that
	 * has refactored hard can carry survivors nobody can fix. Omitted ⇒ every
	 * file is assumed present, and nothing is marked stale.
	 */
	exists?: ((file: string) => boolean) | undefined;
}

/** One actionable survivor, with everything needed to find and kill it. */
export interface SurvivorMutantRow {
	file: string;
	symbolId: StableId;
	qualifiedName: string;
	mutantId: StableId;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	firstSeen: string;
	/** null ⇒ nobody has judged this survivor yet. */
	disposition: SurvivorDispositionKind | null;
}

/** Per-symbol rollup — the unit an agent actually fixes (one function, one test). */
export interface SurvivorSymbolRow {
	file: string;
	symbolId: StableId;
	qualifiedName: string;
	open: number;
	dispositioned: number;
	uncovered: number;
	total: number;
	/** A quarantined symbol's survivors are downgraded by the gate; say so. */
	quarantined: boolean;
}

/** Per-file rollup — the unit a session picks. */
export interface SurvivorFileRow {
	file: string;
	/** Symbols walked in this file — carried so a restricted view can recompute
	 *  `totals.symbols` exactly instead of approximating it. */
	symbols: number;
	open: number;
	dispositioned: number;
	uncovered: number;
	timeout: number;
	killed: number;
	total: number;
	/** Detected fraction, uncovered counted as undetected. 0..1. */
	score: number;
	/** True when {@link SurvivorFilter.exists} said the path is gone. */
	stale: boolean;
	/**
	 * What would actually kill these survivors — see {@link remedyFor}. Derived
	 * from the provenance, so an unqualified file honestly reports `unknown`
	 * instead of guessing.
	 */
	remedy: SurvivorRemedy;
	/**
	 * The conditions these counts were measured under, or null when nothing
	 * recorded them.
	 *
	 * Null is not "current" — it is "unqualified". Two files measured under
	 * different test scopes produce survivor counts that cannot be added
	 * together, and this repo's own manifest proved how far apart they land:
	 * 186 survivors vs 18 for the same unedited file.
	 */
	provenance: MeasurementProvenance | null;
}

/**
 * Per-mutator rollup — the most portable signal in this module.
 *
 * A file ranking is repo-specific, but "this suite never notices a flipped
 * boundary operator" is a property of how the tests are written, and it
 * transfers: the same escape rate shows up in the next repo the harness runs
 * in, and it names the test-writing habit to change rather than a file to open.
 */
export interface SurvivorMutatorRow {
	mutator: string;
	open: number;
	total: number;
	/** open / total, 0..1 — how often this operator escapes the suite. */
	escapeRate: number;
}

/**
 * The two ways a surviving mutant gets killed, plus "we cannot tell".
 *
 * They are different jobs, and one ranked list holding both is unusable:
 * `write_test` needs a new test file, `strengthen_tests` needs better
 * assertions in tests that already run. The boundary is the measured test count
 * alone — zero tests, or at least one — so no threshold is tuned against any
 * particular repo.
 */
export type SurvivorRemedy = "write_test" | "strengthen_tests" | "unknown";

/** Aggregate counts across a whole survivor summary, or a restricted view of one. */
export interface SurvivorTotals {
	files: number;
	symbols: number;
	mutants: number;
	killed: number;
	survived: number;
	open: number;
	dispositioned: number;
	uncovered: number;
	timeout: number;
	/** Files whose path no longer exists (only counted when `exists` was given). */
	staleFiles: number;
	/** Files whose records carry no provenance — their counts are unqualified,
	 *  so the totals below are a mixture, not a measurement. */
	unqualifiedFiles: number;
	/** Open survivors grouped by the job that would kill them. */
	openByRemedy: Record<SurvivorRemedy, number>;
	/** Detected fraction over every mutant the filter admitted, 0..1. */
	score: number;
}

export interface SurvivorSummary {
	generation: number;
	authoritativeAt: string;
	totals: SurvivorTotals;
	files: SurvivorFileRow[];
	symbols: SurvivorSymbolRow[];
	mutators: SurvivorMutatorRow[];
	mutants: SurvivorMutantRow[];
}
