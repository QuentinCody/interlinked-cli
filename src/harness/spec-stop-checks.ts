// Stop-event reflection for outstanding cross-file spec drift
// (docs/design/spec-audit-runtime-checks.md §3.5). Formatter contract:
// pure function returning string | null, called from the Stop branch via
// lifecycle-stop-warnings.ts — stderr-only, never blocks, signals captured
// at PostToolUse by the spec-ledger phase (never a content scan at Stop).

/** Max drift entries quoted in the Stop nudge. */
const MAX_SHOWN = 3;

interface SpecDriftStashEntry {
	file: string;
	line: number;
	message: string;
}

/**
 * Outstanding cross-file spec-fact drift at Stop: the session's last
 * markdown edit left claims/facts disagreeing across files. Reflective
 * wording — resolving or explicitly deferring are both legitimate; the
 * findings also surface in `interlinked verify`.
 */
export function formatSpecDriftWarning(
	outstanding: SpecDriftStashEntry[] | undefined,
): string | null {
	if (!outstanding || outstanding.length === 0) return null;
	const shown = outstanding
		.slice(0, MAX_SHOWN)
		.map((f) => `  - ${f.file}:${f.line} — ${f.message}`)
		.join("\n");
	const more =
		outstanding.length > MAX_SHOWN
			? `\n  …and ${outstanding.length - MAX_SHOWN} more`
			: "";
	return (
		`[interlinked:spec-drift] ${outstanding.length} cross-file spec fact finding(s) still outstanding from this session's markdown edits:\n` +
		`${shown}${more}\n` +
		`  Resolve them (update the stale side) or leave a note where the value is defined if the disagreement is deliberate. They also appear in \`interlinked verify\`.`
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
