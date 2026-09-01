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
	toMutantRecord,
} from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationGateOutcome,
	MutationManifest,
	MutationReceipt,
	ReceiptOutcome,
	StableId,
	TestRunResult,
} from "./types.js";

export interface MutationEvalInput {
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
}

function unavailable(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

function contentHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function zip(identities: MutantIdentity[], adapted: AdaptedMutant[]): MeasuredMutant[] {
	const out: MeasuredMutant[] = [];
	const n = Math.min(identities.length, adapted.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const a = adapted[i];
		if (identity && a) out.push({ identity, status: a.status });
	}
	return out;
}

function uncoveredInChanged(measured: MeasuredMutant[], changed: Set<StableId>): StableId[] {
	const sites = new Set<StableId>();
	for (const m of measured) {
		if (m.status === "uncovered" && changed.has(m.identity.symbolId)) sites.add(m.identity.siteId);
	}
	return [...sites];
}

/** Distinct mutation sites in the changed region (spec §6 precheck). Counts every
 *  derived site whose symbol changed — not just the measured/covered ones — so an
 *  edit with many sites is rejected as "too big" before its survivors matter. */
function distinctChangedSites(identities: MutantIdentity[], changed: Set<StableId>): number {
	const sites = new Set<StableId>();
	for (const id of identities) {
		if (changed.has(id.symbolId)) sites.add(id.siteId);
	}
	return sites.size;
}

interface RegressionInput {
	measured: MeasuredMutant[];
	sets: SurvivorDiffSets;
	/** Prior status per mutantId — the transition baseline. */
	prior: Map<StableId, MutantStatus>;
	firstSeen: string;
}

/** Status-transition regressions in UNCHANGED symbols (reviews 2026-08-24/25):
 *  a `survived` mutant that is not already accepted (killed→survived — the
 *  test that killed it weakened), and a killed→uncovered transition (the test
 *  no longer even covers it). Either one riding along with an unrelated edit
 *  must block; a routine run must never enlarge the accepted-survivor floor.
 *  A mutant that was ALWAYS uncovered is not a regression — only the recorded
 *  prior status separates the two, which is why set membership alone was
 *  insufficient. Quarantined symbols stay WARN-territory (identity unstable),
 *  matching `computeNewSurvivors`. */
function statusRegressions(input: RegressionInput): MutantRecord[] {
	const out: MutantRecord[] = [];
	for (const m of input.measured) {
		const id = m.identity;
		if (input.sets.changed.has(id.symbolId) || input.sets.quarantined.has(id.symbolId)) continue;
		const survivedRegression = m.status === "survived" && !input.sets.accepted.has(id.mutantId);
		const coverageRegression = m.status === "uncovered" && input.prior.get(id.mutantId) === "killed";
		if (survivedRegression || coverageRegression) out.push(toMutantRecord(id, m.status, input.firstSeen));
	}
	return out;
}

/** Reviews 2026-08-24 item 5 / 2026-08-25 pass 6: a mutant whose run could not
 *  conclude (timeout / indeterminate) is not evidence of anything, ANYWHERE in
 *  the file — an inconclusive run must neither certify clean nor refresh the
 *  manifest, so the count is file-wide, not changed-region-only. */
function inconclusiveCount(measured: MeasuredMutant[]): number {
	let n = 0;
	for (const m of measured) {
		if (m.status === "timeout" || m.status === "indeterminate") n++;
	}
	return n;
}

function continuityEvidenceGap(missing: readonly StableId[]): string | null {
	if (missing.length === 0) return null;
	return `incomplete unchanged-symbol census — ${missing.length} prior mutant(s) were absent from the full current report (${missing.join(", ")})`;
}

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
/** Enumerate the evidence this run failed to carry back. Empty = sufficient.
 *
 *  Client-side only: every item here is checkable without a runner protocol
 *  change, which is why it lands first. */
/** The engine-exit half of `missingEvidence` (goal 28 §8, "engine exit 0").
 *
 *  A mutation engine that dies partway still leaves a report behind, and that
 *  report's survivors are exactly the ones a forged clean pass would hide — so a
 *  crash reads as CLEANER than a healthy run. Only an explicit 0 certifies;
 *  every other state is the absence of evidence, not evidence of absence.
 *  Returns null when the engine is proven to have finished. */
function engineExitEvidenceGap(exit: number | null | undefined): string | null {
	if (exit === 0) return null;
	// STRICT (operator decision 2026-08-28): absence refuses. `runner_url` is
	// configurable, so an old runner, a proxy, a replay, or a misdeployed Worker
	// can omit the field — "the deployed Worker always sends it" is not a
	// property of the protocol, only of one deployment. For a red-suite
	// response the missing-engine gap IS still computed (missingEvidence runs
	// before decideMeasured's verdict), but the adverse-evidence branch takes
	// precedence over it — correct, because the engine legitimately never ran.
	if (exit === undefined) {
		return "no engine-exit evidence — the runner never reported whether the mutation engine finished, so a crashed engine's partial report is indistinguishable from a complete one";
	}
	if (exit === null) {
		return "engine exit unrecoverable — the runner ran the engine but could not read back its status, so the report cannot be shown to be complete";
	}
	return `engine exited ${exit} — the mutation engine failed, so any report it produced is partial and its survivors cannot be trusted to be the whole set`;
}

export interface V2RunEvidenceInput {
	testRun?: TestRunResult | undefined;
	executedTestCount?: number | null | undefined;
	droppedMutants?: number | undefined;
	engineExitCode?: number | null | undefined;
	evidenceGaps?: readonly string[] | undefined;
}

function executedTestEvidenceGap(count: number | null | undefined): string | null {
	if (count === undefined || count === null) {
		return "no executed-test count — a green suite flag does not prove that any test oracle actually ran";
	}
	if (!Number.isSafeInteger(count) || count <= 0) {
		return `executed-test count was ${count} — zero tests executed, so the mutation run cannot certify clean`;
	}
	return null;
}

/**
 * The shared protocol-v2 evidence floor.
 *
 * Both the live gate and the explicit measure/record command consume the same
 * runner response shape. Keeping these mechanical gaps here prevents the
 * out-of-band command from silently inventing a weaker definition of
 * "complete" than the gate it is supposed to populate.
 */
function runEvidenceGaps(input: V2RunEvidenceInput, executedTestGap: string | null): string[] {
	const missing: string[] = [...(input.evidenceGaps ?? [])];
	const dropped = input.droppedMutants ?? 0;
	if (dropped > 0) {
		// The second-cheapest false clean, and it needs no adversary: one
		// truncated `location.end` on the SURVIVING mutants makes them vanish
		// while the killed ones remain, so a short census reads as clean.
		missing.push(
			`incomplete census — ${dropped} report row(s) for this file could not be parsed into a mutant, so the run cannot account for what it measured`,
		);
	}
	if (input.testRun === undefined) {
		missing.push(
			"no test-run evidence — the runner returned mutants but never reported whether the suite ran or passed, so every 'killed' verdict is unverified",
		);
	}
	if (executedTestGap !== null) missing.push(executedTestGap);
	const engineGap = engineExitEvidenceGap(input.engineExitCode);
	if (engineGap !== null) missing.push(engineGap);
	return missing;
}

export function v2RunEvidenceGaps(input: V2RunEvidenceInput): string[] {
	return runEvidenceGaps(input, executedTestEvidenceGap(input.executedTestCount));
}

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
}

interface MutationComparisonInput {
	input: MutationEvalInput;
	key: string;
	overlayHashes: OverlaySymbolHashes;
	identities: MutantIdentity[];
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
	const sets: SurvivorDiffSets = {
		changed,
		accepted: acceptedSurvivors(input.baseManifest, key),
		quarantined: quarantinedSymbols(input.baseManifest, key),
	};
	return {
		measured,
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

	const { measured, continuityGap, newSurvivors, regressed, uncoveredSites, changedSiteCount } =
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
	};
}
