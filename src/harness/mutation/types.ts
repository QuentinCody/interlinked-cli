// interlinked-tdd: exempt — type definitions only, no executable surface.
// ===========================================
// Per-edit mutation — identity, manifest & output contracts (build step 2)
// ===========================================
// The foundational data model for
// docs/design/per-edit-cloud-mutation-testing.md and its step-2 spec
// docs/design/per-edit-mutation-identity-and-manifest.md. Modeled as a sibling
// of coverage-index/types.ts: same content-hash validity inputs, the same
// immutable-snapshot-with-`generation`, and the same instability/quarantine
// model. No executable surface — see identity.ts for the derivation.

import type { SurvivorDisposition } from "./disposition.js";

/** A 16-hex-char sha-256 prefix used as a stable, content-addressed id. */
export type StableId = string;

/**
 * The mechanical mutant statuses — no LLM judgement, the verdict is exactly this
 * set. `uncovered` mirrors the engine's "no covering test"; `equivalent` is a
 * reviewed annotation that a mutant cannot change behaviour; `indeterminate`
 * marks a run that could not conclude (distinct from a definite `survived`).
 */
export type MutantStatus =
	| "killed"
	| "survived"
	| "timeout"
	| "uncovered"
	| "equivalent"
	| "indeterminate";

/**
 * One mutation reported by the engine, BEFORE identity re-anchoring. The raw
 * character offset is used only to find the enclosing symbol + ordinal; it is
 * never stored as identity (it shifts under unrelated edits — the whole reason
 * identity exists).
 */
export interface RawMutant {
	/** Repo-relative POSIX path of the mutated file. */
	file: string;
	/** Engine operator name, e.g. "EqualityOperator" / "relational_operator". */
	mutator: string;
	/** The original source token being mutated, e.g. ">". */
	originalLexeme: string;
	/** The replacement token, e.g. ">=". */
	replacement: string;
	/** 0-based UTF-16 code-unit offset (JavaScript string index) of the
	 * mutated token's start (engine-provided). */
	startOffset: number;
}

/** A mutation re-anchored to stable, line-shift-invariant identities (spec §1–§2). */
export interface MutantIdentity {
	mutantId: StableId;
	siteId: StableId;
	symbolId: StableId;
	/** Human-readable provenance, e.g. "PaymentService.charge". */
	qualifiedName: string;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	ordinalWithinSymbol: number;
}

export interface MutantRecord {
	mutantId: StableId;
	siteId: StableId;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	ordinalWithinSymbol: number;
	status: MutantStatus;
	/** ISO timestamp — when this identity first appeared. */
	firstSeen: string;
	/** LEGACY, still read forever: the prose WHY of an accepted equivalence.
	 *  Manifests written before typed dispositions carry ONLY this field, so it
	 *  can never be removed — `dispositionOf` surfaces it verbatim rather than
	 *  reinterpreting it as evidence. Still written alongside `disposition` as a
	 *  human-readable rendering for older readers. */
	accepted_reason?: string;
	/** The typed judgment (plan 16 §7): why this survivor is resolved, and with
	 *  what mechanism. `proved_equivalent` is the only kind that reaches
	 *  `status: "equivalent"`; `dead_code` / `unresolved` attach here WITHOUT
	 *  touching status, so a defect can never be laundered into the accepted
	 *  floor. Absent on records written before typed dispositions. */
	disposition?: SurvivorDisposition;
}

/** Mirror of coverage-index `ShardInstability`: quarantine on identity churn. */
export interface IdentityInstability {
	events: Array<{ at: string; kind: "id_churn" | "status_flip" }>;
	consecutiveStableRuns: number;
	/** A quarantined symbol's survivors downgrade BLOCK → WARN until it restabilises. */
	quarantined: boolean;
}

export interface SymbolRecord {
	symbolId: StableId;
	qualifiedName: string;
	/** Normalized-source content hash — the differential-skip / changed-region key. */
	symbolHash: string;
	/** Keyed by mutantId. */
	mutants: Record<StableId, MutantRecord>;
	instability: IdentityInstability;
}

/**
 * How the measured test set was chosen.
 *
 * This is the difference between two survivor counts for the SAME unedited
 * file, and it is not small: measured 2026-08-09, `deletion-hygiene.ts` read
 * 186 survivors under the runner's own filename-glob scope and 18 under
 * import-graph scope; `completions.ts` read 106 and 0. Same source, same
 * engine, no test written in between — the narrower scope simply loaded fewer
 * tests, so fewer mutants died.
 *
 * `companion_fallback` is a THIRD regime, distinct from both: the full
 * import-graph scope was over cap (test-scope.ts's `MAX_MUTATION_TEST_SCOPE`)
 * and declined, so only the target's OWN co-located companion/kill tests were
 * shipped. It kills MORE than `glob_fallback` (it includes the sibling
 * `*.mutation-kill.*` / `*.survivor(s).*` tests a four-stem filename guess
 * silently drops) but FEWER than a complete `import_graph` run, so its counts
 * are comparable to neither — the reason it is labelled apart rather than
 * folded into `glob_fallback`.
 */
export type MeasurementScope = "import_graph" | "companion_fallback" | "glob_fallback" | "unknown";

/** Which surface produced a measurement. Kept because the surfaces differ in
 *  scope and budget, not merely in who typed the command. */
export type MeasurementSurface = "per_edit" | "measure" | "sweep" | "adopt" | "unknown";

/**
 * The conditions a file's records were measured under.
 *
 * Without this, a manifest silently mixes regimes and its survivor totals are
 * not comparable — across files, or across time for one file. A record with no
 * provenance is not assumed current; it is reported as unqualified, which is
 * what it is.
 */
export interface MeasurementProvenance {
	/** ISO timestamp of the run that produced the file's current records. */
	at: string;
	scope: MeasurementScope;
	/** Test files in scope. 0 ⇒ the runner chose its own set. */
	testCount: number;
	surface: MeasurementSurface;
	engine?: string;
	engineVersion?: string;
}

/** The persistent per-edit mutation manifest — sibling of CoverageIndexManifest. */
export interface MutationManifest {
	version: 1;
	/** Immutable snapshot id; promotion is compare-and-swap on this generation. */
	generation: number;
	/** ISO timestamp of the run that established this snapshot. */
	authoritativeAt: string;
	engine: string;
	engineVersion: string;
	/** Invalidation input — identities re-measure on a graph-version bump. */
	dependencyGraphVersion: string;
	/** Toolchain/runtime fingerprint. */
	environmentHash: string;
	sourceRevision?: string;
	/** file → symbolId → record. */
	files: Record<string, Record<StableId, SymbolRecord>>;
	/** file → the conditions its records were measured under. Absent for every
	 *  record written before provenance existed, and for any writer that does
	 *  not supply it — read as "unqualified", never as "current". */
	fileProvenance?: Record<string, MeasurementProvenance>;
}

/**
 * The overlay test-run signal accompanying a mutation measurement (spec §7).
 * Produced by the runner alongside the mutants; absent when the runner reports
 * mutants only (older Worker, or a runner that does not run the suite).
 */
export interface TestRunResult {
	/** Affected tests GREEN on the proposed overlay. false ⇒ the edit breaks the
	 *  suite — a hard red/green block that supersedes the mutant work-list. */
	overlayGreen: boolean;
	/** A newly-added test was RED on the pre-edit BASE (the RED-witness). null ⇒
	 *  the edit added no new test, so there is nothing to witness. false ⇒ the new
	 *  test passes on base too (weak/tautological) — a WARN, not a block. */
	redWitnessSatisfied: boolean | null;
}

/** What a receipt actually attests (review 2026-08-28 item 2). A receipt
 *  without this field used to look identical for a first-sighting adoption and
 *  a measured-clean pass, so every durable consumer — the run ledger, the
 *  dashboard — read adoption as clean. `finding` marks a measured BLOCK's
 *  receipt (second pass, finding 5: a blocked result must not carry a receipt
 *  claiming clean, even though the gate never persists one — the type itself
 *  must not permit the false statement). Only `baseline_adopted` and
 *  `measured_clean` ever reach persistence; not-measured runs write nothing. */
export type ReceiptOutcome = "baseline_adopted" | "measured_clean" | "finding";

/** A receipt is valid ONLY against the exact measured overlay content (spec §8). */
export interface MutationReceipt {
	/** Hash of the proposed overlay content actually run. */
	overlayHash: string;
	/** Manifest snapshot the run was diffed against. */
	generation: number;
	sites: Array<{ mutantId: StableId; symbolId: StableId; status: MutantStatus }>;
	engine: string;
	engineVersion: string;
	measuredAt: string;
	/** What this receipt attests — adoption is NOT clean. */
	outcome: ReceiptOutcome;
}

/** Recorded when a measurement could not complete (parent doc §12, case 3). */
interface MutationObligation {
	reason: "cloud_unreachable" | "over_budget" | "partial";
	overlayHash: string;
	/** Changed symbols still needing measurement at commit time. */
	changedSymbols: StableId[];
}

/**
 * The gate outcome. Only `kind: "measured"` may block or mark the edit
 * mutation-clean; `baseline_adopted` records a first sighting's floor without
 * certifying anything; `unavailable` is an honest not-measured allow.
 */
export type MutationGateOutcome =
	| {
			/** FIRST measured sighting of this file (review 2026-08-28 item 1):
			 *  the run RECORDS the pre-existing survivor floor so brownfield
			 *  adoption is possible — an allow that persists — but it is NOT a
			 *  clean verdict: nothing was compared against a baseline, because
			 *  this run IS the baseline. `_ready` because adoption is DECLARED
			 *  only after the persistence CALLBACK completes (review item 1) — which
			 *  is NOT an atomic or crash-durable commit; the file-based sequence can
			 *  still be partial after a crash until the SQLite journal lands: the gate
			 *  layer persists this outcome and downgrades the message to
			 *  "measured but NOT adopted" when persistence fails or is absent.
			 *  Reaching this outcome requires the current v2 evidence checks
			 *  (a green testRun, a positive executed-test count, engine exit 0,
			 *  and no adapter-dropped rows — config hash / runner identity remain
			 *  open, plan 27); a red suite still produces a measured block, and
			 *  oversize is deliberately NOT enforced on first sighting (the
			 *  site count reflects the whole file, not the edit). */
			kind: "baseline_adoption_ready";
			receipt: MutationReceipt;
			/** The floor to persist — same role as a measured-clean allow's
			 *  refreshedManifest, never absent here. */
			refreshedManifest: MutationManifest;
			/** The adoption message to surface IF persistence succeeds. */
			warning: string;
			/** RED-witness (spec §7) must survive adoption: a new test that never
			 *  failed on base is still worth a warning on a first sighting. */
			redWitnessFailed?: boolean;
	  }
	| {
			kind: "measured";
			decision: "allow" | "block";
			receipt: MutationReceipt;
			newSurvivors: MutantRecord[];
			uncoveredSites: StableId[];
			/** Distinct mutation sites in the changed region (spec §6 precheck). */
			changedSiteCount: number;
			/** The configured small-scope ceiling; over it ⇒ "split this patch" block. */
			siteCountThreshold: number;
			/** Red/green gate (spec §7): the overlay's affected tests fail. A hard block
			 *  that supersedes the mutant work-list. Absent test-run data ⇒ undefined ⇒
			 *  not gated (older Worker / mutants-only runner). */
			suiteRed?: boolean;
			/** RED-witness (spec §7): a newly-added test did NOT fail on the base — a
			 *  weak/tautological test. WARN, never a block. */
			redWitnessFailed?: boolean;
			/** Present ONLY on a measured-clean allow: the refreshed manifest snapshot
			 *  for the caller to persist. Never present on a block or an unavailable
			 *  outcome — a dirty or unmeasured run must not launder the manifest
			 *  (spec §4/§12). */
			refreshedManifest?: MutationManifest | undefined;
			/** Accepted survivors this run reconciled as MOVED — same content
			 *  under a new identity (survivor-moves.ts) — and so did not charge
			 *  to the edit. Present only when at least one move was matched, so
			 *  an allow that leaned on reconciliation is distinguishable from a
			 *  plain clean allow. */
			movedSurvivors?: number;
	  }
	| {
			kind: "unavailable";
			reason: string;
			warning: string;
			obligation?: MutationObligation;
	  };
