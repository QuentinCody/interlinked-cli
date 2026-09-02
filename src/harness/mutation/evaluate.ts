// ===========================================
// Per-edit mutation — local evaluation orchestrator (build step 4)
// ===========================================
// Ties the pure pipeline together: overlay content → symbol hashes + identities →
// changed-region + survivor-diff → MutationGateOutcome (+ hash-bound receipt). The
// engine execution that produces `adapted` is INJECTED, so this is the local
// 1-node core the cloud Sandbox runner calls. No I/O, no clock (the `at` stamp is
// passed in) — fully deterministic.

import { createHash } from "node:crypto";
import { isTestPath } from "../coverage-test-selector.js";
import {
	type AuthenticatedNoTestPolicy,
	type AuthenticatedZeroMutantCensus,
	isAuthenticatedNoTestPolicy,
	isAuthenticatedZeroMutantCensus,
} from "./authenticated-zero-census.js";
import {
	continuityEvidenceGap,
	distinctChangedSites,
	inconclusiveCount,
	statusRegressions,
	uncoveredInChanged,
	zip,
} from "./evaluate-census.js";
import { executedTestEvidenceGap, runEvidenceGaps } from "./evaluate-evidence.js";
import { computeSymbolHashes, deriveIdentities } from "./identity.js";
import {
	acceptedSurvivors,
	applyMeasuredRun,
	changedSymbols,
	computeNewSurvivors,
	hasFileBaseline,
	missingUnchangedMutants,
	type MeasuredMutant,
	normalizeManifestKey,
	priorStatuses,
	quarantinedSymbols,
	type SurvivorDiffSets,
} from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import { type SurvivorMove, survivorMoves } from "./survivor-moves.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutationGateOutcome,
	MutationManifest,
	MutationReceipt,
	ReceiptOutcome,
	StableId,
	TestRunResult,
} from "./types.js";

export { v2RunEvidenceGaps } from "./evaluate-evidence.js";

interface MutationEvalInput {
	file: string;
	baseManifest: MutationManifest;
	/** The proposed (post-overlay) content of the edited file. */
	overlayContent: string;
	/** Per-mutant engine results (status + raw span) — produced by the runner. */
	adapted: AdaptedMutant[];
	/** Small-scope ceiling (spec §6): over this many changed-region sites ⇒ block
	 *  "split this patch" rather than gate a huge edit. */
	siteCountThreshold: number;
	/** Optional overlay test-run signal (spec §7): red suite ⇒ block, weak RED-
	 *  witness ⇒ warn. Absent ⇒ neither gate fires (mutants-only runner). */
	testRun?: TestRunResult | undefined;
	/** Positive runner-reported count of tests that actually executed. A green
	 * suite flag without this count can be produced by a zero-test dry run and
	 * must never certify clean. */
	executedTestCount?: number | null;
	/** Injected timestamp (no clock dependency). */
	at: string;
	/** True when the runner measured a LINE RANGE, not the whole file. Threaded
	 *  into the manifest refresh: a partial run may only add knowledge, never
	 *  replace a symbol's complete record (review 2026-08-23, finding 1). */
	partialScope?: boolean;
	/** Report rows for this file the adapter could not parse into a mutant.
	 *  Any loss means the census is incomplete, so the run cannot certify clean
	 *  (goal 28 §8). Absent = nothing was dropped. */
	droppedMutants?: number;
	/** The mutation engine's process exit status (goal 28 §8, "engine exit 0").
	 *  Only `0` is evidence the engine finished. Non-zero means it failed and any
	 *  report it left is partial; `null` means the status could not be recovered;
	 *  absent means the runner never reported one. None of the last three
	 *  certify — see `missingEvidence`. */
	engineExitCode?: number | null;
	/** Additional authenticated completeness gaps. Supplying gaps can only make
	 *  a result more conservative; the protocol-v3 composition uses this to
	 *  preserve partial/terminal evidence reasons through the one evaluator. */
	evidenceGaps?: readonly string[];
	/** Process-local capability minted only from an authenticated protocol-v3
	 *  `not_mutatable` bundle. A plain empty legacy report must never set this. */
	authenticatedZeroMutantCensus?: AuthenticatedZeroMutantCensus;
	/** Opaque capability minted only from an authenticated protocol-v3
	 * `not_mutatable` result whose signed acceptance approved its
	 * `no_test_policy`. This is not a caller-controlled v2 escape hatch. */
	authenticatedNoTestPolicy?: AuthenticatedNoTestPolicy;
	/** Independently supplied by the verified-evidence composition seam. The
	 * zero-census capability must bind this exact authenticated result identity. */
	authenticatedEvidenceResultHash?: string;
	/** Repo root `file` resolves against when absolute — see `normalizeManifestKey`
	 *  in manifest.ts. Threaded from the daemon's `ctx.cwd` (gate.ts /
	 *  pre-tool-coverage-gates.ts); omitted callers fall back to `process.cwd()`. */
	cwd?: string;
	/** The pre-edit on-disk content the base manifest's records were measured
	 *  against. When present, a survivor that MOVED with its statement into
	 *  another symbol (an extracted helper) is reconciled against the prior
	 *  floor by content fingerprint (survivor-moves.ts) instead of being
	 *  charged to this edit as new. Absent ⇒ identity alone decides. */
	priorContent?: string | undefined;
}

function unavailable(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

function contentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

// Census facts (`zip` / `uncoveredInChanged` / `distinctChangedSites` /
// `statusRegressions` / `inconclusiveCount` / `continuityEvidenceGap`) moved to
// ./evaluate-census.ts (2026-09-01, line cap).

interface VerdictInput {
	partial: boolean;
	firstSighting: boolean;
	oversize: boolean;
	suiteRed: boolean;
	newSurvivors: MutantRecord[];
	regressed: MutantRecord[];
	uncoveredCount: number;
	inconclusiveCount: number;
	/** How many mutants the run actually measured. Zero is never proof of a
	 *  mutant-free scope (review 2026-08-24, item 1: `{files:{}}` flowed through
	 *  as a measured-clean allow and persisted a clean-looking generation). */
	measuredCount: number;
	/** True only for a verifier-authenticated `not_mutatable` zero census. */
	zeroMutantCensusVerified: boolean;
	/** Evidence the run did NOT carry back, one human-readable item per gap.
	 *
	 *  Goal 28 §8: a result may certify clean only when the evidence is present
	 *  AND valid. The gap this closes was the cheapest false clean in the system:
	 *  `testRun` was optional, and an ABSENT one read as "not red", so pointing
	 *  `runner_url` at any mutants-only runner returned every mutant `Killed` —
	 *  because no test ever ran — and the gate allowed the edit and refreshed the
	 *  manifest. One config line, no adversary.
	 *
	 *  Checked AFTER the adverse-evidence branch, never before: missing evidence
	 *  is a reason a run cannot certify CLEAN, never a reason to discard a red
	 *  suite or a proven survivor. */
	evidenceMissing: string[];
}

/** Separate "adverse evidence arrived" from "conclusively measured clean"
 *  (review 2026-08-24, items 1–3, 5). Positive findings block even from a
 *  partial or inconclusive run — real evidence stands. A CLEAN verdict is
 *  earned only by a full-scope, fully-conclusive run; anything less is
 *  not-measured and falls to `unavailable_behavior`, never to allow. */
// The protocol-v2 evidence floor (`runEvidenceGaps` / `executedTestEvidenceGap`
// / `v2RunEvidenceGaps`) moved to ./evaluate-evidence.ts (2026-09-01, line cap);
// `v2RunEvidenceGaps` is re-exported below so its importers are untouched.

function hasAuthenticatedNoTestPolicy(input: MutationEvalInput): boolean {
	if (input.executedTestCount !== 0) return false;
	if (input.adapted.length !== 0) return false;
	return isAuthenticatedNoTestPolicy(input.authenticatedNoTestPolicy, {
		resultHash: input.authenticatedEvidenceResultHash ?? "",
		targetFile: normalizeManifestKey(input.file, input.cwd),
		targetContentHash: contentHash(input.overlayContent),
	});
}

function missingEvidence(input: MutationEvalInput): string[] {
	const executedTestGap = hasAuthenticatedNoTestPolicy(input)
		? null
		: executedTestEvidenceGap(input.executedTestCount);
	return runEvidenceGaps(input, executedTestGap);
}

function decideMeasured(v: VerdictInput): { decision: "block" | "allow" } | { notMeasured: string } {
	// Hard evidence FIRST (review 2026-08-25, pass 6): a red overlay suite or a
	// tripped ratchet blocks regardless of scope or baseline state — partiality
	// and first sighting are reasons a run cannot certify CLEAN, never reasons
	// to discard adverse findings (the old order let partial+first-sighting
	// return not-measured past a red suite).
	const ratchetTripped =
		!v.firstSighting &&
		(v.oversize || v.newSurvivors.length > 0 || v.regressed.length > 0 || v.uncoveredCount > 0);
	if (v.suiteRed || ratchetTripped) return { decision: "block" };
	// C2 — the evidence gate. Sits directly below the adverse-evidence branch and
	// above every other not-measured reason: a run missing evidence can still
	// BLOCK on what it did prove, but can never CERTIFY.
	if (v.evidenceMissing.length > 0) {
		return { notMeasured: v.evidenceMissing.join("; ") };
	}
	if (v.partial && v.firstSighting) {
		return {
			notMeasured:
				"first sighting under a partial (line-range) run — a partial floor must never become the baseline; record a full census first (interlinked mutation measure --record)",
		};
	}
	if (v.measuredCount === 0 && !v.zeroMutantCensusVerified) {
		return {
			notMeasured:
				"the run reported zero mutants for this file — an empty report is not proof of a mutant-free scope, so nothing was measured",
		};
	}
	if (v.inconclusiveCount > 0) {
		return {
			notMeasured: `${v.inconclusiveCount} changed-region mutant(s) returned timeout/indeterminate — inconclusive evidence never counts as clean`,
		};
	}
	if (v.partial) {
		return {
			notMeasured:
				"the run measured a line range, not the whole file — no finding in range, but partial evidence never certifies clean",
		};
	}
	return { decision: "allow" };
}

function buildReceipt(
	input: MutationEvalInput,
	measured: MeasuredMutant[],
	outcome: ReceiptOutcome,
): MutationReceipt {
	return {
		overlayHash: contentHash(input.overlayContent),
		generation: input.baseManifest.generation,
		sites: measured.map((m) => ({ mutantId: m.identity.mutantId, symbolId: m.identity.symbolId, status: m.status })),
		engine: input.baseManifest.engine,
		engineVersion: input.baseManifest.engineVersion,
		measuredAt: input.at,
		// Review 2026-08-28 item 2: without this, an adoption receipt was
		// byte-shaped like a clean one and every durable consumer (run ledger,
		// dashboard) read adoption as clean.
		outcome,
	};
}

/**
 * FIRST SIGHTING that passed the current v2 evidence checks (a green testRun,
 * a positive executed-test count, engine exit 0, and no adapter-dropped rows —
 * config hash / runner identity are still open, plan 27) is ADOPTION, not
 * measurement (review 2026-08-28 item 1): the run IS the baseline, so nothing
 * was compared against one, and calling it "measured clean" overstates what
 * happened. `_ready` because the ADOPTED claim is declared only after durable
 * persistence (gate-decision.ts::adoptionDecision); the `warning` field here is
 * the success message for that layer to emit. A red suite still takes the
 * measured-block path; oversize is deliberately NOT enforced on first sighting
 * (the site count reflects the whole file, not the edit — see the `oversize`
 * computation below), so an oversize first sighting adopts. Returns null when
 * the run is not an adoption.
 */
function adoptionOutcome(args: {
	decision: "allow" | "block";
	firstSighting: boolean;
	refreshedManifest: MutationManifest | undefined;
	key: string;
	input: MutationEvalInput;
	measured: MeasuredMutant[];
	redWitnessFailed: boolean;
}): MutationGateOutcome | null {
	const { decision, firstSighting, refreshedManifest, key, input, measured } = args;
	if (decision !== "allow" || !firstSighting || refreshedManifest === undefined) return null;
	const adoptedSurvivors = measured.filter((m) => m.status === "survived").length;
	return {
		kind: "baseline_adoption_ready",
		receipt: buildReceipt(input, measured, "baseline_adopted"),
		refreshedManifest,
		redWitnessFailed: args.redWitnessFailed,
		warning:
			`[interlinked:mutation] baseline adopted for ${key} — first measured sighting: ` +
			`${measured.length} mutant(s) recorded (${adoptedSurvivors} pre-existing survivor(s) accepted as the floor). ` +
			"NOT certified clean: nothing was compared against a baseline, because this run created it. " +
			"Later edits ratchet against this floor.",
	};
}

type OverlaySymbolHashes = NonNullable<ReturnType<typeof computeSymbolHashes>>;

interface MutationComparison {
	measured: MeasuredMutant[];
	continuityGap: string | null;
	newSurvivors: MutantRecord[];
	regressed: MutantRecord[];
	uncoveredSites: StableId[];
	changedSiteCount: number;
	/** Matched moves (prior id → current id) — widen the floor AND travel
	 *  into the manifest refresh so the prior record's review continues. */
	moves: SurvivorMove[];
}

interface MutationComparisonInput {
	input: MutationEvalInput;
	key: string;
	overlayHashes: OverlaySymbolHashes;
	identities: MutantIdentity[];
}

/** The accepted floor, widened by the CURRENT identities of survivors that
 *  merely moved (survivor-moves.ts). A move is "same mutant, new address":
 *  charging it as new would ask the agent to kill a survivor a previous run
 *  already accepted. Only an UNRECORDED survivor in a CHANGED symbol can be a
 *  move target, so the widened set never excuses a recorded mutant that
 *  regressed. Without `priorContent` the floor is identity-only. */
function acceptedWithMoves(base: MutationManifest, key: string, moves: readonly SurvivorMove[]): Set<StableId> {
	const accepted = acceptedSurvivors(base, key);
	for (const move of moves) accepted.add(move.currentMutantId);
	return accepted;
}

/** Compare the current census with the manifest floor before the evaluator
 * applies scope and evidence policy. This helper derives facts only; the one
 * gate verdict remains in `decideMeasured`. */
function compareMutationRun(args: MutationComparisonInput): MutationComparison {
	const { input, key, overlayHashes, identities } = args;
	const measured = zip(identities, input.adapted);
	const changed = changedSymbols(input.baseManifest, key, overlayHashes);
	const missingPriorMutants =
		input.partialScope === true
			? []
			: missingUnchangedMutants(input.baseManifest, key, overlayHashes, measured);
	const moves = survivorMoves({
		file: input.file,
		key,
		baseManifest: input.baseManifest,
		priorContent: input.priorContent,
		currentContent: input.overlayContent,
		identities,
		adapted: input.adapted,
		changed,
	});
	const sets: SurvivorDiffSets = {
		changed,
		accepted: acceptedWithMoves(input.baseManifest, key, moves),
		quarantined: quarantinedSymbols(input.baseManifest, key),
	};
	return {
		measured,
		moves,
		continuityGap: continuityEvidenceGap(missingPriorMutants),
		newSurvivors: computeNewSurvivors(measured, sets, input.at),
		regressed: statusRegressions({
			measured,
			sets,
			prior: priorStatuses(input.baseManifest, key),
			firstSeen: input.at,
		}),
		uncoveredSites: uncoveredInChanged(measured, changed),
		changedSiteCount: distinctChangedSites(identities, changed),
	};
}

/** Evaluate a measured per-edit mutation run into a gate outcome (spec §5). */
export function evaluateMutation(input: MutationEvalInput): MutationGateOutcome {
	// The manifest key, resolved ONCE (manifest.ts's `normalizeManifestKey` — the
	// single choke point) and reused for every read AND the eventual write below,
	// so this call never reads one key's history and writes another's. A test/spec
	// target is rejected here, upfront — before any hashing/identity work, and
	// covering the block AND allow branches alike (the later `applyMeasuredRun`
	// call only fires on allow, so checking only there would miss a test target
	// that happened to compute a "block" verdict).
	const key = normalizeManifestKey(input.file, input.cwd);
	if (isTestPath(key)) {
		return unavailable("test files are not mutation targets — mutating a test proves nothing (the test is the oracle)");
	}

	const overlayHashes = computeSymbolHashes(input.file, input.overlayContent);
	const identities = deriveIdentities(
		input.file,
		input.overlayContent,
		input.adapted.map((a) => a.raw),
	);
	if (overlayHashes === null || identities === null) return unavailable("typescript unavailable");

	const { measured, continuityGap, newSurvivors, regressed, uncoveredSites, changedSiteCount, moves } =
		compareMutationRun({ input, key, overlayHashes, identities });

	// FIRST SIGHTING: this file has never been measured, so there is no prior
	// state to diff against. `changedSymbols` therefore reports EVERY symbol as
	// changed, which makes `changedSiteCount` the size of the FILE rather than of
	// the edit, and makes every pre-existing survivor look newly introduced.
	//
	// Judging on that is a guaranteed rejection that says nothing about the change
	// — a one-line comment edit measured 116 "changed sites" — and because the
	// manifest is only written by a clean pass, the gate could never bootstrap:
	// rejected forever for having no baseline, and no baseline because always
	// rejected.
	//
	// So the first measurement of a file ESTABLISHES the baseline instead of
	// verdicting it: the survivors are recorded, not charged to this edit. From
	// the second edit onward there is a real prior and the ratchet applies
	// normally. This is the same adoption semantics every other ratchet here uses.
	const firstSighting = !hasFileBaseline(input.baseManifest, key);
	const oversize = !firstSighting && changedSiteCount > input.siteCountThreshold;
	// Spec §7: a red overlay suite is a hard block; a new test that doesn't fail on
	// base (RED-witness) is a warning, never a block.
	const suiteRed = input.testRun?.overlayGreen === false;
	const redWitnessFailed = input.testRun?.redWitnessSatisfied === false;
	// A red suite still blocks on first sighting: that is a property of the edit,
	// not an artifact of having no baseline.
	const verdict = decideMeasured({
		partial: input.partialScope === true,
		firstSighting,
		oversize,
		suiteRed,
		newSurvivors,
		regressed,
		uncoveredCount: uncoveredSites.length,
		inconclusiveCount: inconclusiveCount(measured),
		measuredCount: measured.length,
		zeroMutantCensusVerified: isAuthenticatedZeroMutantCensus(
			input.authenticatedZeroMutantCensus,
			{
				resultHash: input.authenticatedEvidenceResultHash ?? "",
				targetFile: key,
				targetContentHash: contentHash(input.overlayContent),
			},
		),
		evidenceMissing: [
			...missingEvidence(input),
			...(continuityGap === null ? [] : [continuityGap]),
		],
	});
	if ("notMeasured" in verdict) return unavailable(verdict.notMeasured);
	const decision = verdict.decision;
	// Manifest refresh is earned ONLY by a measured-clean pass — a dirty run must
	// not launder the manifest, and an unavailable run never reaches here (§4/§12).
	// `applyMeasuredRun` re-normalizes+re-checks `key` internally too (it is the
	// non-bypassable backstop for every caller, not just this one) — deliberately
	// NOT wrapped in a try/catch here: the upfront check above already used the
	// identical predicate on the identical key, so a throw from this call would
	// mean the two checks disagree, which is a bug in THIS fix and should fail
	// loud (tests), not be silently absorbed at runtime.
	const refreshedManifest =
		decision === "allow"
			? applyMeasuredRun({
					base: input.baseManifest,
					file: key,
					overlayHashes,
					measured,
					at: input.at,
					partial: input.partialScope === true,
					moves,
					...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
				})
			: undefined;
	const adopted = adoptionOutcome({ decision, firstSighting, refreshedManifest, key, input, measured, redWitnessFailed });
	if (adopted !== null) return adopted;
	return {
		kind: "measured",
		decision,
		// A blocked result's receipt says "finding", never "measured_clean" —
		// the type must not permit the false statement even on a receipt the
		// gate never persists (review 2026-08-28 second pass, finding 5).
		receipt: buildReceipt(input, measured, decision === "allow" ? "measured_clean" : "finding"),
		// Regressions (killed→survived in an unchanged symbol) surface alongside
		// new survivors so the block message names the exact mutants.
		newSurvivors: [...newSurvivors, ...regressed],
		uncoveredSites,
		changedSiteCount,
		siteCountThreshold: input.siteCountThreshold,
		suiteRed,
		redWitnessFailed,
		refreshedManifest,
		// Auditable: an allow that excused moved survivors must not read like a
		// plain clean allow (verdict.ts surfaces the count on the wire).
		...(moves.length > 0 ? { movedSurvivors: moves.length } : {}),
	};
}
