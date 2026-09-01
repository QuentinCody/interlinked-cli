// ===========================================
// Obligation ledger — metric-agnostic TDD-debt state machine
// ===========================================
import { isJsonObject } from "../lib/json-types.js";
// The single source of truth for "code changed and a quality bar is not yet
// met" — coverage today, mutation (cloud, async) by descriptor next. An edit
// OPENS an obligation; a later measurement DISCHARGES it; a re-edit of the same
// region opens fresh debt a stale discharge can't close; a mutation run
// ESCALATEs with the specific surviving mutants. The teeth live OUTSIDE this
// module (a PreToolUse stale-debt phase, the commit/push gate) — observation
// here, decisions there.
//
// State changes are a small discriminated union (`ObligationTxn`) applied
// through one pure `applyObligationTxn`, so live state and the replayed
// append-only log can never diverge — the single-source-of-truth pattern
// `reservations.ts` uses (see its header). This module is PURE: no fs, no
// clock, no config. Timestamps, edit counters, and content hashes are INPUTS,
// so a replay is deterministic. The `.interlinked/obligations.jsonl` I/O and
// per-edit wiring live in their own layer (Phase 2); this is the engine they
// fold rows through.

/** The metric an obligation enforces. `coverage` ships today; `mutation` is
 *  designed-in (cloud-async discharge) and rides the same machine by
 *  descriptor — adding it is a registration, not an engine change.
 *  `red_suite` = the red-bar as a debt: the edited pair's overlay run left the
 *  suite RED; iterate that pair to green (the red→green loop), don't wander.
 *  `transient` = a deferrable artifact-correctness finding (an unused import, an
 *  unresolved symbol) whose wrongness is a property of a not-yet-complete tree:
 *  the coordinated edit's OTHER half resolves it. Warned at the edit that
 *  introduces it, blocked at the first edit that walks away from it. */
export type ObligationKind = "coverage" | "mutation" | "red_suite" | "transient";

/** Where a discharge originated. `local` = an in-process overlay run;
 *  `observed` = harvested from the agent's own test run; `cloud` = an async
 *  remote job (mutation). Recorded on the obligation so the commit/push gate
 *  can demand a trusted source (e.g. a signed `cloud` discharge) per kind. */
export type DischargeSource = "local" | "observed" | "cloud";

/** A 1-based inclusive line range identifying the changed region an obligation
 *  covers. Omitted ⇒ a file-level obligation (coverage keys by file today). */
export interface ObligationRegion {
	start: number;
	end: number;
}

/** A surviving mutant reported by a mutation run — the actionable payload of an
 *  `escalate`: which line, what the operator did, so the push gate can name the
 *  missing assertion instead of a bare "mutants survived". */
export interface MutationSurvivor {
	line: number;
	/** Human-readable mutation, e.g. "replaced `>` with `>=`". */
	description: string;
	/** Operator id, e.g. "ConditionalBoundary" (optional; engine-specific). */
	operator?: string;
}

/** One state change in the ledger. `op` is the transition; `kind` is the metric
 *  (kept distinct so a coverage and a mutation obligation on the same file are
 *  independent). Every field a REPLAY needs is on the txn — no ambient clock —
 *  so `replayObligations` is deterministic. */
export type ObligationTxn =
	| {
			op: "open";
			kind: ObligationKind;
			/** Repo-relative POSIX path. */
			file: string;
			/** Changed region (mutation); omitted ⇒ file-level (coverage). */
			region?: ObligationRegion;
			/** Hash of the changed content — stored as a FIELD (not the id) so an
			 *  async discharge computed for stale content reconciles correctly. */
			contentHash: string;
			sessionId: string;
			atMs: number;
			/** Monotonic edit counter at open time — the staleness clock the
			 *  trajectory gate compares against (window is configurable). */
			editSeq?: number;
			/** `transient` only: WHICH checker raised the deferrable finding — a
			 *  diagnostic code (`TS6133`) or a registry check id. Part of the
			 *  obligation's identity, so two independent deferrals on one file are
			 *  two debts and discharging one cannot silently close the other. */
			detector?: string;
			/** `transient` only: how many edits to UNRELATED files have landed while
			 *  this debt stayed open — the wander counter that gives a coordinated
			 *  change its one free counterpart edit before the gate bites. Carried on
			 *  the txn (not derived) so replay is deterministic, and AUTHORITATIVE on
			 *  re-open: unlike `openedAtMs`/`editSeq`, the caller's value wins, because
			 *  the whole point is that it advances. */
			strikes?: number;
			/** `red_suite` only: the failing test FILES the red run reported
			 *  (repo-relative, best-effort parsed) — the episode's evidence.
			 *  Debt relatedness widens to any file these tests exercise, so a
			 *  legitimate cross-module fix isn't blocked as a "wander". A
			 *  re-open of the same debt REPLACES the list (the latest red run
			 *  is the episode's current truth). */
			failingTestFiles?: string[];
	  }
	| {
			op: "discharge";
			id: string;
			source: DischargeSource;
			atMs: number;
			/** The content the discharge was measured against. When present it must
			 *  match the obligation's current `contentHash` or the discharge is
			 *  ignored — the async reconcile (the agent re-edited while a cloud job
			 *  ran). Omitted ⇒ unconditional (synchronous local coverage). */
			forContentHash?: string;
			/** Signed attestation from a trusted discharger (forward-compat:
			 *  proof-of-enforcement R1). Unused by the engine today. */
			witness?: string;
	  }
	| { op: "escalate"; id: string; survivors: MutationSurvivor[]; atMs: number };

/** The netted current state of one obligation id. Optional fields are written
 *  `| undefined` (not bare `?`) because the apply path spreads-and-overrides
 *  them to undefined under `exactOptionalPropertyTypes`. */
export interface Obligation {
	id: string;
	kind: ObligationKind;
	file: string;
	region?: ObligationRegion | undefined;
	/** The content the open debt currently describes (reconcile key). */
	contentHash: string;
	status: "open" | "discharged";
	sessionId: string;
	openedAtMs: number;
	editSeq?: number | undefined;
	dischargedAtMs?: number | undefined;
	dischargeSource?: DischargeSource | undefined;
	witness?: string | undefined;
	/** Surviving mutants from the last escalate (mutation only). */
	survivors?: MutationSurvivor[] | undefined;
	/** `transient` only: the checker that raised the deferred finding. */
	detector?: string | undefined;
	/** `transient` only: unrelated-edit wander count (see the open txn). */
	strikes?: number | undefined;
	/** `red_suite` only: failing test files from the opening/latest red run. */
	failingTestFiles?: string[] | undefined;
}

/** Current netted state: id → obligation. A `Map` mutated in place by
 *  `applyObligationTxn`, exactly like `reservations.ts`'s cache. */
export type ObligationState = Map<string, Obligation>;

/**
 * Stable identity for an obligation: `kind:file` (file-level, coverage),
 * `kind:file:start-end` (region-level, mutation), optionally suffixed
 * `#detector` (transient — one debt per checker, so an unused import and an
 * unresolved symbol in the same file are independently dischargeable). The
 * content hash is deliberately NOT part of the id — a re-edit of the same
 * region updates the SAME obligation (new `contentHash` field) rather than
 * orphaning the old id, and the async reconcile is done by comparing content
 * hashes at discharge.
 */
export function obligationId(
	kind: ObligationKind,
	file: string,
	region?: ObligationRegion,
	detector?: string,
): string {
	const base = region ? `${kind}:${file}:${region.start}-${region.end}` : `${kind}:${file}`;
	return detector ? `${base}#${detector}` : base;
}

/**
 * Apply one transition to the state IN PLACE, mirroring
 * `reservations.ts::applyTransition`. Total — an unknown id (discharge /
 * escalate) is a safe no-op, and a content-mismatched discharge is ignored, so
 * a stale cloud discharge can never close debt the agent has since re-opened.
 */
export function applyObligationTxn(state: ObligationState, txn: ObligationTxn): void {
	switch (txn.op) {
		case "open": {
			const id = obligationId(txn.kind, txn.file, txn.region, txn.detector);
			const existing = state.get(id);
			// Continuous open accrues staleness from the FIRST touch (so a churning
			// re-edit can't perpetually reset the clock and dodge the gate); a
			// clean→dirty cycle (was discharged, or never seen) starts fresh.
			const anchor =
				existing !== undefined && existing.status === "open"
					? { openedAtMs: existing.openedAtMs, editSeq: existing.editSeq }
					: { openedAtMs: txn.atMs, editSeq: txn.editSeq };
			state.set(id, {
				id,
				kind: txn.kind,
				file: txn.file,
				region: txn.region,
				contentHash: txn.contentHash,
				status: "open",
				sessionId: txn.sessionId,
				detector: txn.detector,
				strikes: txn.strikes,
				openedAtMs: anchor.openedAtMs,
				editSeq: anchor.editSeq,
				// A new open invalidates any prior measurement.
				survivors: undefined,
				// Latest red run's evidence REPLACES the old (absent ⇒ cleared):
				// a stale failing-test list must not keep widening relatedness.
				failingTestFiles: txn.failingTestFiles,
			});
			return;
		}
		case "discharge": {
			const ob = state.get(txn.id);
			if (!ob) return; // unknown ⇒ no-op
			// Async reconcile: a discharge measured for content the region no
			// longer has (a re-edit landed while a cloud job ran) is stale — drop
			// it so the newer debt stays open. Omitted hash ⇒ unconditional.
			if (txn.forContentHash !== undefined && txn.forContentHash !== ob.contentHash) return;
			state.set(txn.id, {
				...ob,
				status: "discharged",
				dischargedAtMs: txn.atMs,
				dischargeSource: txn.source,
				witness: txn.witness,
				survivors: undefined,
			});
			return;
		}
		case "escalate": {
			const ob = state.get(txn.id);
			if (!ob) return; // unknown ⇒ no-op
			// Surviving mutants mean the bar is NOT met: keep/return to open and
			// attach the actionable payload for the push gate.
			state.set(txn.id, { ...ob, status: "open", survivors: txn.survivors });
			return;
		}
	}
}

/**
 * Fold a transition log into current state — a fresh `Map`, deterministic. Live
 * apply and replay share `applyObligationTxn`, so they cannot diverge (the
 * invariant the reservation property tests pin, here for obligations).
 */
export function replayObligations(txns: Iterable<ObligationTxn>): ObligationState {
	const state: ObligationState = new Map();
	for (const txn of txns) applyObligationTxn(state, txn);
	return state;
}

/**
 * The OPEN obligations, optionally filtered to one kind — what the gates act on
 * (the trajectory stale-debt phase, the commit/push backstop).
 */
export function openObligations(state: ObligationState, kind?: ObligationKind): Obligation[] {
	const out: Obligation[] = [];
	for (const ob of state.values()) {
		if (ob.status !== "open") continue;
		if (kind && ob.kind !== kind) continue;
		out.push(ob);
	}
	return out;
}

/**
 * Default trajectory staleness window: how many edits an open trajectory-cadence
 * obligation may survive before the next code edit is blocked. GENEROUS by
 * default and configurable (`per_edit_coverage.debt_stale_after_edits`) — a wide
 * window keeps the gate a backstop against runaway untested code, not a per-edit
 * handcuff. Set to 1 for near-atomic strict TDD; 0 disables the trajectory teeth
 * (the commit/push gate still backstops every kind).
 */
export const DEFAULT_STALE_AFTER_EDITS = 10;

/**
 * True when an open obligation has gone stale: its open `editSeq` is more than
 * `staleAfterEdits` edits behind the current edit. A null/non-positive window or
 * a missing `editSeq` ⇒ never edit-stale (commit/push remains the backstop).
 */
export function isStale(ob: Obligation, currentEditSeq: number, staleAfterEdits: number | null): boolean {
	if (staleAfterEdits === null || staleAfterEdits <= 0) return false;
	if (ob.editSeq === undefined) return false;
	return currentEditSeq - ob.editSeq > staleAfterEdits;
}

/** The earliest surface at which open debt of a kind BLOCKS. `commit`/`push`
 *  always backstop every kind regardless — this names the EARLIEST gate. */
export type EnforcementCadence = "trajectory" | "commit" | "push";

/** The per-kind policy that is the whole extensibility surface: adding a metric
 *  is declaring one of these, not touching the engine. */
export interface MetricDescriptor {
	kind: ObligationKind;
	/** Discharge sources the commit/push gate will accept for this kind. */
	dischargeSources: DischargeSource[];
	/** Earliest surface that blocks open debt of this kind. */
	enforcementCadence: EnforcementCadence;
	/** Trajectory staleness window (edits) for `trajectory` cadence; null when
	 *  the kind is not edit-gated (mutation: cloud-async, push-only). */
	staleAfterEdits: number | null;
}

/** Coverage: opens per-edit, discharges from a fast local/observed run, and the
 *  trajectory phase blocks once debt goes stale (generous, configurable). */
export const COVERAGE_DESCRIPTOR: MetricDescriptor = {
	kind: "coverage",
	dischargeSources: ["local", "observed"],
	enforcementCadence: "trajectory",
	staleAfterEdits: DEFAULT_STALE_AFTER_EDITS,
};

/** Mutation: opens at the commit boundary, discharges ONLY from a (trusted,
 *  ideally signed) cloud job, and never gates an intermediate edit — its block
 *  is at push. Designed-in; the cloud producer is unbuilt. */
export const MUTATION_DESCRIPTOR: MetricDescriptor = {
	kind: "mutation",
	dischargeSources: ["cloud"],
	enforcementCadence: "push",
	staleAfterEdits: null,
};

/** Red suite: the red-bar as a pair-scoped debt (the twin of coverage debt —
 *  same "block, but not too soon, and never for staying in the pair" rule).
 *  Opens when an edit's overlay run leaves the suite RED; discharges from the
 *  next same-pair overlay run that is not red; the commit gate is the
 *  ground-truth backstop. */
const RED_SUITE_DESCRIPTOR: MetricDescriptor = {
	kind: "red_suite",
	dischargeSources: ["local", "observed"],
	enforcementCadence: "trajectory",
	staleAfterEdits: DEFAULT_STALE_AFTER_EDITS,
};

/**
 * Transient: the deferrable-finding debt. Opens when a write introduces a
 * net-new deferrable diagnostic, discharges when the SAME checker no longer
 * reports it for that file (never a cheaper proxy), and its teeth are the
 * WANDER rule, not edit-distance — `staleAfterEdits: null` is deliberate.
 *
 * Edit-distance would be actively wrong here. Reconciling a half-landed
 * refactor legitimately takes several edits inside the same pair, and a
 * countdown would block precisely the work that discharges the debt. What
 * distinguishes "reconciling" from "forgot" is not how many edits passed but
 * WHICH file the next one touches — so relatedness carries the whole decision
 * (`transient-debt.ts`), exactly as it does for `red_suite`.
 */
const TRANSIENT_DESCRIPTOR: MetricDescriptor = {
	kind: "transient",
	dischargeSources: ["local"],
	enforcementCadence: "trajectory",
	staleAfterEdits: null,
};

export const METRIC_DESCRIPTORS: Record<ObligationKind, MetricDescriptor> = {
	coverage: COVERAGE_DESCRIPTOR,
	mutation: MUTATION_DESCRIPTOR,
	red_suite: RED_SUITE_DESCRIPTOR,
	transient: TRANSIENT_DESCRIPTOR,
};

type OpenTxn = Extract<ObligationTxn, { op: "open" }>;
type DischargeTxn = Extract<ObligationTxn, { op: "discharge" }>;
type EscalateTxn = Extract<ObligationTxn, { op: "escalate" }>;

function isObligationKind(v: unknown): v is ObligationKind {
	return v === "coverage" || v === "mutation" || v === "red_suite" || v === "transient";
}

function isDischargeSource(v: unknown): v is DischargeSource {
	return v === "local" || v === "observed" || v === "cloud";
}


function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((entry): entry is string => typeof entry === "string");
}

function asString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function asNumber(v: unknown): number | null {
	return typeof v === "number" ? v : null;
}

function parseRegion(value: unknown): ObligationRegion | null {
	if (!isJsonObject(value)) return null;
	const { start, end } = value;
	if (typeof start !== "number" || typeof end !== "number") return null;
	return { start, end };
}

function parseMutationSurvivor(value: unknown): MutationSurvivor | null {
	if (!isJsonObject(value)) return null;
	const { line, description, operator } = value;
	if (typeof line !== "number" || typeof description !== "string") return null;
	if (operator !== undefined && typeof operator !== "string") return null;
	return operator === undefined ? { line, description } : { line, description, operator };
}

function parseSurvivorList(value: unknown): MutationSurvivor[] | null {
	if (!Array.isArray(value)) return null;
	const out: MutationSurvivor[] = [];
	for (const entry of value) {
		const parsed = parseMutationSurvivor(entry);
		if (parsed === null) return null;
		out.push(parsed);
	}
	return out;
}

/** Marker distinguishing "field absent" (`undefined`) from "field present but
 *  malformed" (`INVALID`) so a caller can propagate a parse failure without
 *  conflating it with a legitimately-omitted optional field. */
const INVALID = Symbol("invalid-optional-field");

/**
 * Parse an optional field: absent ⇒ `undefined` (field stays unset, honoring
 * `exactOptionalPropertyTypes`); present and well-formed ⇒ the parsed value;
 * present but malformed ⇒ `INVALID`, so the caller can reject the whole row.
 */
function optionalField<T>(value: unknown, parse: (v: unknown) => T | null): T | undefined | typeof INVALID {
	if (value === undefined) return undefined;
	const parsed = parse(value);
	return parsed === null ? INVALID : parsed;
}

function parseOpenTxn(value: unknown): OpenTxn | null {
	if (!isJsonObject(value) || value.op !== "open") return null;
	if (!isObligationKind(value.kind)) return null;
	if (typeof value.file !== "string") return null;
	if (typeof value.contentHash !== "string") return null;
	if (typeof value.sessionId !== "string") return null;
	if (typeof value.atMs !== "number") return null;
	const region = optionalField(value.region, parseRegion);
	if (region === INVALID) return null;
	const editSeq = optionalField(value.editSeq, asNumber);
	if (editSeq === INVALID) return null;
	const detector = optionalField(value.detector, asString);
	if (detector === INVALID) return null;
	const strikes = optionalField(value.strikes, asNumber);
	if (strikes === INVALID) return null;
	const failingTestFiles = optionalField(value.failingTestFiles, (v) => (isStringArray(v) ? v : null));
	if (failingTestFiles === INVALID) return null;
	return {
		op: "open",
		kind: value.kind,
		file: value.file,
		contentHash: value.contentHash,
		sessionId: value.sessionId,
		atMs: value.atMs,
		...(region !== undefined ? { region } : {}),
		...(editSeq !== undefined ? { editSeq } : {}),
		...(detector !== undefined ? { detector } : {}),
		...(strikes !== undefined ? { strikes } : {}),
		...(failingTestFiles !== undefined ? { failingTestFiles } : {}),
	};
}

function parseDischargeTxn(value: unknown): DischargeTxn | null {
	if (!isJsonObject(value) || value.op !== "discharge") return null;
	if (typeof value.id !== "string") return null;
	if (!isDischargeSource(value.source)) return null;
	if (typeof value.atMs !== "number") return null;
	const forContentHash = optionalField(value.forContentHash, asString);
	if (forContentHash === INVALID) return null;
	const witness = optionalField(value.witness, asString);
	if (witness === INVALID) return null;
	return {
		op: "discharge",
		id: value.id,
		source: value.source,
		atMs: value.atMs,
		...(forContentHash !== undefined ? { forContentHash } : {}),
		...(witness !== undefined ? { witness } : {}),
	};
}

function parseEscalateTxn(value: unknown): EscalateTxn | null {
	if (!isJsonObject(value) || value.op !== "escalate") return null;
	if (typeof value.id !== "string") return null;
	if (typeof value.atMs !== "number") return null;
	const survivors = parseSurvivorList(value.survivors);
	if (survivors === null) return null;
	return { op: "escalate", id: value.id, survivors, atMs: value.atMs };
}

/**
 * Defensively narrow an unknown parsed JSONL row to an `ObligationTxn`, or null
 * for a torn / foreign / legacy line. Total — the Phase-2 I/O layer folds the
 * non-null results through `replayObligations`, so a malformed row is skipped,
 * never thrown (fail-open: bookkeeping must not crash the harness). This is the
 * generic successor to `coverage-obligation-ledger.ts`'s coverage-only row
 * narrowing. Each per-op parser returns a CONSTRUCTED object literal checked
 * against its concrete txn member by the compiler — never an assertion over
 * the input — so a required field added to `ObligationTxn` fails to compile
 * here instead of silently under-validating at runtime.
 */
export function parseObligationTxn(value: unknown): ObligationTxn | null {
	return parseOpenTxn(value) ?? parseDischargeTxn(value) ?? parseEscalateTxn(value);
}
