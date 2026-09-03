// ===========================================
// Session rework aggregate (7d) — the churn family's quantitative roll-up
// ===========================================
// The per-event churn rules (rules-churn.ts) nudge on individual loop shapes;
// this module answers the session-level question "how much of this session's
// editing returned files to content we already produced?" — the cleanest
// numeric signal of going-in-circles. Fired once, at Stop, above generous
// floors; per the family's catalog it is NUDGE-only, never a block (a blocked
// legitimate bisection would fail the low-FP bar).
// Spec: docs/design/history-relational-metrics.md §3 #6 and §6.

import type { TrajectoryState } from "./types.js";

/** Don't opine on tiny sessions. */
export const MIN_EDITS_FOR_NUDGE = 8;
/** Share of edits that must be content-revisits before the nudge fires. */
export const REWORK_RATIO_FLOOR = 0.25;
const MAX_TOP_FILES = 3;

interface SessionReworkSummary {
	totalEdits: number;
	/** Edits whose exact post-edit content appeared EARLIER for the same file
	 *  (whitespace-only cycles excluded via normSha, mirroring
	 *  churn_sha_cycle_revisit). */
	revisitedEdits: number;
	ratio: number;
	topFiles: Array<{ file: string; revisits: number; edits: number }>;
}

/** Pure aggregate over the already-folded trajectory state. */
export function sessionReworkSummary(state: TrajectoryState): SessionReworkSummary {
	let totalEdits = 0;
	let revisitedEdits = 0;
	const perFile: Array<{ file: string; revisits: number; edits: number }> = [];

	for (const [file, hist] of state.fileShaHistory) {
		totalEdits += hist.length;
		const revisits = countRevisits(hist);
		if (revisits > 0) perFile.push({ file, revisits, edits: hist.length });
		revisitedEdits += revisits;
	}

	perFile.sort((a, b) => b.revisits - a.revisits || a.file.localeCompare(b.file));
	return {
		totalEdits,
		revisitedEdits,
		ratio: totalEdits === 0 ? 0 : revisitedEdits / totalEdits,
		topFiles: perFile.slice(0, MAX_TOP_FILES),
	};
}

/** Does hist[index] repeat exact content seen earlier, across a non-whitespace-only span? */
function isContentRevisit(hist: ReadonlyArray<{ sha: string; normSha: string }>, index: number): boolean {
	const cur = hist[index];
	if (!cur) return false;
	let seenBefore = false;
	let allWhitespace = true;
	for (let j = 0; j < index; j++) {
		const prior = hist[j];
		if (!prior) continue;
		if (prior.sha === cur.sha) seenBefore = true;
		if (prior.normSha !== cur.normSha) allWhitespace = false;
	}
	return seenBefore && !allWhitespace;
}

/** Revisit = exact-content recurrence, unless the whole span is whitespace-only. */
function countRevisits(hist: ReadonlyArray<{ sha: string; normSha: string }>): number {
	let revisits = 0;
	for (let i = 1; i < hist.length; i++) {
		if (isContentRevisit(hist, i)) revisits++;
	}
	return revisits;
}

/** The Stop nudge, or null under either floor. */
export function formatSessionReworkNudge(summary: SessionReworkSummary): string | null {
	if (summary.totalEdits < MIN_EDITS_FOR_NUDGE) return null;
	if (summary.ratio < REWORK_RATIO_FLOOR) return null;
	const pct = Math.round(summary.ratio * 100);
	const top = summary.topFiles.map((f) => `${f.file} (${f.revisits}/${f.edits})`).join(", ");
	return (
		`[interlinked:session-rework] ${summary.revisitedEdits}/${summary.totalEdits} edits ` +
		`(${pct}%) returned a file to content this session already produced — going in ` +
		`circles rather than converging. Worst: ${top}. Step back, re-read the failing ` +
		"output, and form one hypothesis before the next edit."
	);
}
