// ===========================================
// Per-edit mutation — outcome → harness decision (build step 7, wire contract)
// ===========================================
// Maps a MutationGateOutcome onto the harness wire (spec §9). There is no `warn`
// decision: a WARN / not-measured outcome is `allow` + warnings. Only a
// `measured` block produces `decision: "block"`, carrying the survivor + uncovered
// work-list in `reason` (a Pre-block fires no Post, so the reason must carry it).

import type { HarnessDecision } from "../types/decisions.js";
import type { MutantRecord, MutationGateOutcome } from "./types.js";

const RULE_ID = "per-edit-mutation";
const CATEGORY = "mutation";

function survivorSummary(s: MutantRecord): string {
	return `${s.mutator} ${s.originalLexeme}→${s.replacement}`;
}

function blockReason(survivors: MutantRecord[], uncovered: number): string {
	const parts: string[] = [];
	if (survivors.length > 0) parts.push(`${survivors.length} new surviving mutant(s)`);
	if (uncovered > 0) parts.push(`${uncovered} uncovered changed mutation site(s)`);
	const detail = survivors.length > 0 ? ` Survivors: ${survivors.map(survivorSummary).join("; ")}.` : "";
	// No "annotate an equivalent mutant" escape here (review 2026-08-28 item 8):
	// the equivalence workflow requires EMPIRICAL proof — patch the mutant, run
	// the suite (feedback: prove equivalence empirically) — and `equivalent`
	// status needs a verifier-issued certificate, not a self-serve annotation.
	return `[interlinked:mutation] BLOCKED: ${parts.join(" + ")} in the changed region.${detail} Resolve by strengthening the test or fixing/removing the code; if you believe a mutant is equivalent, prove it empirically (patch the mutant, run the suite) rather than annotating it away.`;
}

/** Spec §6 small-scope block: too many mutation sites in the changed region to gate
 *  as one edit. Its own class — "split the patch", not "strengthen the test". */
function oversizeReason(count: number, threshold: number): string {
	return (
		`[interlinked:mutation] BLOCKED: this edit changes ${count} mutation sites in one patch ` +
		`(over the ${threshold}-site small-scope limit). Split it into smaller behavioral changes ` +
		`— each with its test — so the gate stays inside its budget. (spec §6)`
	);
}

/** Spec §7 red/green block: the proposed overlay's affected tests fail. Nothing
 *  downstream (survivors, coverage) is trustworthy until the suite is green. */
function suiteRedReason(): string {
	return (
		"[interlinked:mutation] BLOCKED: the affected tests are RED on this edit. " +
		"Fix the suite first — survivor/coverage results are meaningless against a failing suite. (spec §7)"
	);
}

/** Spec §7 RED-witness warning: a newly-added test passed on the pre-edit base too,
 *  so it never demonstrably failed — a weak/tautological test. WARN, not a block.
 *  Exported for the adoption path (gate-decision.ts), which composes its own
 *  warning list — review 2026-08-28 item 3: adoption must not swallow this. */
export function redWitnessWarning(): string {
	return (
		"[interlinked:mutation] the new test did not fail on the pre-edit base (RED-witness unmet) — " +
		"it may be tautological. Confirm it actually exercises the new behavior."
	);
}

/** Map a mutation gate outcome onto the harness wire contract (spec §9). */
export function mutationOutcomeToDecision(outcome: MutationGateOutcome): HarnessDecision {
	if (outcome.kind === "unavailable") {
		return { decision: "allow", warnings: [outcome.warning], rule_id: RULE_ID, category: CATEGORY };
	}
	if (outcome.kind === "baseline_adoption_ready") {
		// An allow that RECORDS — the warning keeps adoption visible so it can
		// never be read (or reported) as a clean measurement. NOTE for callers
		// that persist: this mapping emits the outcome's own warning verbatim,
		// which says "adopted" — a persisting caller must go through
		// gate-decision.ts::adoptionDecision instead, which declares adoption
		// only AFTER the persistence callback completes (review 2026-08-28 item
		// 1; not crash-durable — the sequence has no transaction).
		const warnings = outcome.redWitnessFailed
			? [outcome.warning, redWitnessWarning()]
			: [outcome.warning];
		return { decision: "allow", warnings, rule_id: RULE_ID, category: CATEGORY };
	}
	if (outcome.decision === "block") {
		// Priority: a red suite is the most fundamental failure; then oversize ("split
		// the patch"); then the survivor/uncovered work-list.
		const reason = outcome.suiteRed
			? suiteRedReason()
			: outcome.changedSiteCount > outcome.siteCountThreshold
				? oversizeReason(outcome.changedSiteCount, outcome.siteCountThreshold)
				: blockReason(outcome.newSurvivors, outcome.uncoveredSites.length);
		return { decision: "block", reason, rule_id: RULE_ID, severity: "medium", category: CATEGORY };
	}
	// Clean allow — but surface a failed RED-witness as a non-blocking warning,
	// and say when the allow leaned on move reconciliation (auditable: a plain
	// clean allow and one that excused moved survivors must not read alike).
	const warnings = [
		...(outcome.redWitnessFailed ? [redWitnessWarning()] : []),
		...(outcome.movedSurvivors === undefined ? [] : [movedSurvivorsNote(outcome.movedSurvivors)]),
	];
	if (warnings.length > 0) return { decision: "allow", warnings, rule_id: RULE_ID, category: CATEGORY };
	return { decision: "allow", rule_id: RULE_ID, category: CATEGORY };
}

/** survivor-moves.ts: an accepted survivor that moved with its statement into
 *  another symbol keeps its accepted status — this line makes that visible. */
function movedSurvivorsNote(count: number): string {
	return (
		`[interlinked:mutation] ${count} previously accepted survivor(s) moved with the code ` +
		"(same content, new symbol) and were not charged to this edit."
	);
}
