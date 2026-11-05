// ===========================================
// Kill proof — types
// ===========================================
// A kill proof answers one narrow question with local execution: does this test
// pass on the current implementation AND fail, by its own check, when exactly one
// specified mutant (or explicit fault) is applied — for the exact source bytes,
// test bytes and runtime being certified? Coverage, a `test-contract` marker, a
// surviving-mutant count or an older receipt are not proof; a crash, a load
// error, a runner timeout or an unresolvable mutant is not a kill.

/** What to mutate: a manifest survivor by stable id, or an explicit `find`→`replace` fault. */
export type MutantSpec =
	| { kind: "manifest"; mutantId: string; file?: string }
	| { kind: "explicit"; file: string; find: string; replace: string };

/** The mutant pinned to the CURRENT source bytes. */
export interface ResolvedMutant {
	/** Repo-relative POSIX path of the mutated file. */
	file: string;
	/** 0-based UTF-16 offset of the lexeme in the current source. */
	offset: number;
	originalLexeme: string;
	replacement: string;
	/** 1-based line of the mutated lexeme. */
	line: number;
	/** The source line holding the lexeme at proof time; a freshness check compares it after re-location (review R10). */
	lineText?: string;
	source: "manifest" | "explicit";
	/** Manifest identity — present only for `source: "manifest"`. */
	mutantId?: string;
	siteId?: string;
	symbolId?: string;
	qualifiedName?: string;
	mutator?: string;
	ordinalWithinSymbol?: number;
	manifestGeneration?: number;
	manifestStatus?: string;
}

export type CaseVerdict = "killed" | "survived" | "inconclusive";

/** One baseline-passing test case under the mutant. `test` is `file › fullName`. */
export interface CaseOutcome {
	test: string;
	verdict: CaseVerdict;
	/** inconclusive only: the first failure line, or why no result exists. */
	reason?: string;
}

/**
 * killed — at least one named test failed by its own check under the mutant.
 * survived — every named test still passed: the tests do not detect this mutant.
 * inconclusive — no test failed by its own check, and at least one crashed, failed
 *   to load, or the runner timed out; nothing is proven either way.
 * not-passing-now — a named test does not pass on the live tree; the proof cannot start.
 * unavailable — the mutant does not resolve, a test file is missing, or the runner
 *   could not run on the live tree.
 */
export type ProofVerdict = "killed" | "survived" | "inconclusive" | "not-passing-now" | "unavailable";

export interface HashedFile {
	path: string;
	sha256: string;
}

/** A file a named test reaches through static local imports (review K11), with the named tests that reach it. */
export interface BoundImport extends HashedFile {
	/** The named test files whose import closure reaches this file; a change stales only their certification (K13). */
	importedBy: string[];
}

export interface ProofEnvironment {
	node: string;
	/** `vitest` version resolved from the project root; null when not resolvable. */
	vitest: string | null;
	platform: string;
	/** The vitest/vite config file the run used, hashed; null when none exists. */
	config: HashedFile | null;
	/** Files the config declares as `setupFiles` / `globalSetup`, hashed (review N9); empty when none. */
	setupFiles: HashedFile[];
}

/** The receipt: everything a later reader needs to decide whether the proof still applies. */
export interface KillProofReceipt {
	version: 1;
	/** sha256 (16 hex) over the binding: source bytes, mutant, test bytes, environment. */
	id: string;
	/** sha256 over every other field of this receipt (canonical JSON); an edited outcome no longer matches (review K3). */
	digest: string;
	verdict: Exclude<ProofVerdict, "not-passing-now" | "unavailable">;
	reasons: string[];
	provedAt: string;
	/** Canonical (realpath) project root the run read. */
	root: string;
	source: HashedFile;
	mutant: ResolvedMutant;
	tests: HashedFile[];
	/** The named tests' local static import closure (helpers, fixtures modules), hashed; capped (see bound-imports.ts). */
	boundImports: BoundImport[];
	/** Present (true) when the closure walk hit its cap with files unvisited: the receipt binds less than the tests
	 *  load and certifies nothing (round 5, R5-3). Absent otherwise. */
	boundImportsTruncated?: true;
	/** The named test files with at least one killed case — the only files this receipt certifies. */
	killedTests: string[];
	baseline: { cases: number; durationMs: number };
	underMutant: { durationMs: number; timedOut: boolean; error?: string; cases: CaseOutcome[] };
	environment: ProofEnvironment;
}

/** The command's result: a receipt when the mutant run executed, else the reason it did not.
 *  `warnings` (either shape): run-level notes that change no verdict — today the copy-size budget (round-4 M10). */
export type ProveKillResult =
	| { ok: true; receipt: KillProofReceipt; receiptPath: string; warnings?: string[] }
	| { ok: false; verdict: "not-passing-now" | "unavailable"; reasons: string[]; mutant?: ResolvedMutant; warnings?: string[] };


export type Freshness = { fresh: true } | { fresh: false; reasons: string[] };
