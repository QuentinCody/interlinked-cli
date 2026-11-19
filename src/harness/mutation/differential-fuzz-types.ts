// interlinked-tdd: exempt — type definitions only, no executable surface.
// ===========================================
// Differential fuzz — shared types (build step: promote scratch/probes/mutant-shadow-runner.ts)
// ===========================================
// Portable, per-mutant counterexample search: generate diverse inputs from the
// TARGET FUNCTION'S OWN DECLARED TYPES (no hand-written generators), run the
// pristine and mutated module side by side, and diff the full observable output
// (return value + thrown error). A divergence KILLS the mutant with a minimized
// repro; the ABSENCE of a divergence after N runs is SEARCH EVIDENCE toward the
// mutant being unkillable — never a proof of equivalence (only `mutation accept`
// with a verifier-issued certificate may claim that — see disposition.ts).
//
// See docs/design/equivalent-mutant-handling.md ("Lever 3 — raise the
// equivalence-proof bar... some 'equivalents' are stubborn-but-killable... and
// `fast-check` kills a class example tests miss") and
// scratch/probes/mutant-shadow-runner.ts (the proven applyReplacement/
// buildMutant/import-both mechanism this module generalizes into a portable,
// type-driven engine that needs no per-target hand-written generator).

/** One surviving mutant, resolved to everything needed to rebuild and fuzz it.
 *  Constructed by the CLI layer from a loaded `MutationManifest` — this module
 *  never reads the manifest itself, so it stays independently testable against
 *  plain fixture files. */
export interface FuzzMutantTarget {
	/** Repo-relative POSIX path — the manifest's own file key. */
	file: string;
	/** Resolved absolute path on disk (the CLI layer's `resolve(cwd, file)`). */
	absPath: string;
	/** Dotted qualified name from the manifest's SymbolRecord, e.g. "computeScore".
	 *  Only single-segment top-level bindings are supported today — see
	 *  `differential-fuzz-locate.ts`'s `findTopLevelBinding`. */
	qualifiedName: string;
	symbolId: string;
	mutantId: string;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	/** Rank of this site's offset among same-(symbol,mutator,lexeme) sites,
	 *  ascending — identity.ts's own ordinal derivation. Used to re-locate the
	 *  exact character span inside the CURRENT source text. */
	ordinalWithinSymbol: number;
	/** 0-based UTF-16 offset of the mutated lexeme in the source. When present
	 *  the engine uses it directly; when absent it re-locates the site from
	 *  `mutantId` / `ordinalWithinSymbol` (see `differential-fuzz-locate.ts`). */
	startOffset?: number;
	/** The source text the offset / ordinal refer to. Absent ⇒ the engine reads
	 *  `absPath` from disk. */
	source?: string;
	/** The manifest's recorded `symbolHash` for `symbolId` (identity.ts's
	 *  normalized-token hash of the enclosing function at measurement time).
	 *  When present, re-location compares it with the symbol's CURRENT hash:
	 *  an unchanged hash keeps the ordinal rule; a changed hash together with a
	 *  changed `measuredSites` count is an ambiguous re-location and is refused
	 *  (docs/reviews/kill-proof-manifest-route.md §3). Absent ⇒ no comparison. */
	symbolHash?: string;
	/** Distinct candidate offsets of `originalLexeme` under `mutator` inside the
	 *  symbol at measurement time — the population `ordinalWithinSymbol` ranked
	 *  against. The manifest records no such count; the kill-proof route derives
	 *  it from the symbol's own ordinals (highest ordinal + 1 over records
	 *  sharing mutator and lexeme). Only read when `symbolHash` is present. */
	measuredSites?: number;
}

/** One parameter's type-derived arbitrary, with provenance for the report. */
export interface ParamArbitrarySpec {
	name: string;
	/** `checker.typeToString(...)`, truncated — human-facing only. */
	typeText: string;
	/** True when this parameter's coverage is a broad/generic fallback rather
	 *  than a type-faithful arbitrary (any/unknown/function/deeply-recursive/
	 *  unsupported shape). A weak parameter means "do not silently under-test":
	 *  a no-divergence result is real evidence, but weaker evidence. */
	weak: boolean;
	note: string;
	/** True when this parameter was drawn partly from the corpus (companion-test
	 *  literals, repo files, edits of both) rather than from the type alone. */
	corpusSeeded?: boolean;
}

/** One call's fully-observed outcome, safe to compare and to render as a
 *  literal in a proposed regression test. Never carries a stack trace — the
 *  mutant module is built from a DIFFERENT temp file than the original, so
 *  stack text would diverge on file/line alone and manufacture false kills. */
export interface CallOutcomeSummary {
	threw: boolean;
	/** JSON-safe rendering of the return value (present iff !threw). */
	valueJson: string;
	errorName?: string;
	errorMessage?: string;
	/** Rendering of the argument list AFTER the call — a function that mutates
	 *  its inputs is observable through them. Compared like the return value. */
	argsAfterJson?: string;
}

export const DEFAULT_FUZZ_RUNS = 300;
/** Wall-clock cap for the whole search, shrinking included. */
export const DEFAULT_FUZZ_TIME_BUDGET_MS = 10_000;
/** Per-call cap. A mutant that loops forever is observed as a timeout, not a hang. */
export const DEFAULT_FUZZ_CALL_TIMEOUT_MS = 250;

/** Corpus-seeded generation for string parameters that look like source text
 *  (see differential-fuzz-corpus.ts). Absent ⇒ type-driven generation only. */
export interface FuzzCorpusConfig {
	/** Repo source files (absolute or cwd-relative) whose text seeds the search.
	 *  May be empty: the function's own companion-test literals still apply. */
	files: string[];
	/** Cap, in characters, on any one seed text. */
	maxBytes: number;
	/** Extra literal seed texts (mostly for tests). */
	seeds?: string[];
}

export interface FuzzRunConfig {
	/** Corpus-seeded generation for source-text string parameters. */
	corpus?: FuzzCorpusConfig;
	/** Generated inputs to try. Default {@link DEFAULT_FUZZ_RUNS}. */
	runs?: number;
	/** Fixed seed for a reproducible replay; omitted ⇒ fast-check picks one
	 *  (and reports it back — always recorded, since a seed nobody wrote down
	 *  makes a "no divergence" run unreplayable). */
	seed?: number;
	/** Wall-clock budget for the whole search. Default {@link DEFAULT_FUZZ_TIME_BUDGET_MS}. */
	timeBudgetMs?: number;
	/** Per-call timeout. Default {@link DEFAULT_FUZZ_CALL_TIMEOUT_MS}. */
	callTimeoutMs?: number;
}

export type FuzzOutcomeKind = "kill" | "no_divergence" | "unavailable" | "unsupported_target";

interface FuzzOutcomeBase {
	target: FuzzMutantTarget;
}

/** A divergence was found: this IS a kill, with a minimized repro fast-check's
 *  own shrinker produced (see `differential-fuzz-run.ts`; no hand-rolled
 *  shrink loop — fast-check already does the minimizing). */
export interface FuzzKillOutcome extends FuzzOutcomeBase {
	kind: "kill";
	/** The minimized failing call, one entry per parameter, in declaration order. */
	counterexample: unknown[];
	originalOutcome: CallOutcomeSummary;
	mutantOutcome: CallOutcomeSummary;
	numRuns: number;
	seed: number;
	/** A proposed test source block — a SUGGESTION the caller reviews before
	 *  adopting, same convention as scaffold-fuzz.ts. Never written to disk by
	 *  this module. */
	regressionFixture: string;
	params: ParamArbitrarySpec[];
	/** False when the function is not exported by its module and the engine called
	 *  it through a synthetic export; the proposed fixture then needs the function
	 *  exported (or a public caller) before it can be adopted. */
	targetExported: boolean;
}

/** N inputs produced no divergence. Evidence of a failed counterexample search
 *  — NEVER proof of equivalence. Wired into the disposition store as
 *  `unresolved` evidence (see `differential-fuzz-disposition.ts`); `dead_code`
 *  is never inferred here. */
export interface FuzzNoDivergenceOutcome extends FuzzOutcomeBase {
	kind: "no_divergence";
	numRuns: number;
	seed: number;
	params: ParamArbitrarySpec[];
	/** See {@link FuzzKillOutcome.targetExported}. */
	targetExported: boolean;
	/** True iff ANY parameter fell back to a broad/generic arbitrary — the
	 *  search covered less of the real input space than a type-faithful
	 *  generator would, so this evidence is weaker than it looks. Surfaced
	 *  loudly rather than silently folded into a clean "no divergence". */
	weakGeneration: boolean;
	weakParams: string[];
	dispositionWritten: boolean;
	dispositionNote: string;
}

/** A required optional dependency (typescript / fast-check / esbuild) is not
 *  resolvable at runtime, or the mutant module could not be built at all. Not
 *  a verdict about the mutant — an honest "could not run this search". */
export interface FuzzUnavailableOutcome extends FuzzOutcomeBase {
	kind: "unavailable";
	reason: string;
}

/** The target's shape is outside what this engine supports today (a class
 *  method, a nested/anonymous function, a module-scope pseudo-symbol with no
 *  function to derive a signature from, source drift against the manifest).
 *  Distinct from `unavailable`: the tooling works, this particular mutant's
 *  shape is just not one it can fuzz yet. */
export interface FuzzUnsupportedOutcome extends FuzzOutcomeBase {
	kind: "unsupported_target";
	reason: string;
}

export type FuzzOutcome =
	| FuzzKillOutcome
	| FuzzNoDivergenceOutcome
	| FuzzUnavailableOutcome
	| FuzzUnsupportedOutcome;
