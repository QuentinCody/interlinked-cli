// Stop-event reflection for outstanding cross-file spec drift
// (docs/design/spec-audit-runtime-checks.md §3.5). Formatter contract:
// pure function returning string | null, called from the Stop branch via
// lifecycle-stop-warnings.ts — stderr-only, never blocks, signals captured
// at PostToolUse by the spec-ledger phase (never a content scan at Stop).

import { isProvenSpecDrift } from "./spec/drift-confidence.js";

/** Max drift entries quoted in the Stop nudge. */
const MAX_SHOWN = 3;

interface SpecDriftStashEntry {
	kind?: string;
	file: string;
	line: number;
	message: string;
}

/**
 * Retained structural drift at Stop. Inferred prose comparisons remain
 * review evidence; missing classification in an older snapshot is not proof.
 * Full findings remain in the append-only log and the review agenda.
 */
export function formatSpecDriftWarning(
	outstanding: SpecDriftStashEntry[] | undefined,
): string | null {
	const proven = outstanding?.filter((finding) => isProvenSpecDrift(finding.kind)) ?? [];
	if (proven.length === 0) return null;
	const shown = proven
		.slice(0, MAX_SHOWN)
		.map((f) => `  - ${f.file}:${f.line} — ${f.message}`)
		.join("\n");
	const more =
		proven.length > MAX_SHOWN
			? `\n  …and ${proven.length - MAX_SHOWN} more`
			: "";
	return (
		`[interlinked:spec-drift][proven] ${proven.length} retained structural spec finding(s) outstanding in the repository snapshot (session causation unmeasured):\n` +
		`${shown}${more}\n` +
		`  Inspect the compared definitions before editing. Full observed findings and provenance: \`interlinked query spec-drift\`. Deliberate disagreements can be documented at their definition.`
	);
}

/** One open review finding, as the Stop nudge needs it. */
interface OpenReviewFindingLite {
	id: string;
	file: string;
	line: number;
	message: string;
}

/**
 * Open ingested review findings at Stop: neither touched by an edit nor
 * acked. Reflective — a finding can be legitimately deferred, but silently
 * ignoring an audit you paid hours for is the failure mode this exists for.
 */
export function formatReviewFindingsWarning(
	open: OpenReviewFindingLite[] | undefined,
): string | null {
	if (!open || open.length === 0) return null;
	const shown = open
		.slice(0, MAX_SHOWN)
		.map((f) => `  - ${f.id.slice(0, 48)}… ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message.slice(0, 90)}`)
		.join("\n");
	const more = open.length > MAX_SHOWN ? `\n  …and ${open.length - MAX_SHOWN} more` : "";
	return (
		`[interlinked:review-findings] ${open.length} ingested review finding(s) have neither a touching edit nor an ack:\n` +
		`${shown}${more}\n` +
		`  Address them, or record the deliberate deferrals: \`interlinked findings ack <id> --reason "…"\`. Full list: \`interlinked findings status\`.`
	);
}
