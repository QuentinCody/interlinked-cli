// ===========================================
// Per-edit mutation — census facts (extracted from evaluate.ts, 2026-09-01,
// for the 500-line cap)
// ===========================================
// Pure derivations over the measured census: which sites are uncovered in
// the changed region, how many distinct sites changed, which unchanged
// symbols regressed, how many mutants were inconclusive. Facts only — the one
// gate verdict stays in evaluate.ts's `decideMeasured`.

import { type MeasuredMutant, type SurvivorDiffSets, toMutantRecord } from "./manifest-diff.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutantIdentity, MutantRecord, MutantStatus, StableId } from "./types.js";

/** Pair derived identities with the adapter rows they came from, by index. */
export function zip(identities: MutantIdentity[], adapted: AdaptedMutant[]): MeasuredMutant[] {
	const out: MeasuredMutant[] = [];
	const n = Math.min(identities.length, adapted.length);
	for (let i = 0; i < n; i++) {
		const identity = identities[i];
		const a = adapted[i];
		if (identity && a) out.push({ identity, status: a.status });
	}
	return out;
}

export function uncoveredInChanged(measured: MeasuredMutant[], changed: Set<StableId>): StableId[] {
	const sites = new Set<StableId>();
	for (const m of measured) {
		if (m.status === "uncovered" && changed.has(m.identity.symbolId)) sites.add(m.identity.siteId);
	}
	return [...sites];
}

/** Distinct mutation sites in the changed region (spec §6 precheck). Counts every
 *  derived site whose symbol changed — not just the measured/covered ones — so an
 *  edit with many sites is rejected as "too big" before its survivors matter. */
export function distinctChangedSites(identities: MutantIdentity[], changed: Set<StableId>): number {
	const sites = new Set<StableId>();
	for (const id of identities) {
		if (changed.has(id.symbolId)) sites.add(id.siteId);
	}
	return sites.size;
}

/** Public API: the argument shape of `statusRegressions`. */
export interface RegressionInput {
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
export function statusRegressions(input: RegressionInput): MutantRecord[] {
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
export function inconclusiveCount(measured: MeasuredMutant[]): number {
	let n = 0;
	for (const m of measured) {
		if (m.status === "timeout" || m.status === "indeterminate") n++;
	}
	return n;
}

export function continuityEvidenceGap(missing: readonly StableId[]): string | null {
	if (missing.length === 0) return null;
	return `incomplete unchanged-symbol census — ${missing.length} prior mutant(s) were absent from the full current report (${missing.join(", ")})`;
}
