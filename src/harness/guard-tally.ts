// Live guard tally — what the harness has actually DONE, for the statusline.
//
// The statusline's numbers describe the HARNESS: rule count, check count. A
// human reads those once, learns the tool is installed, and never looks again;
// worse, they drift (the rendered "265 inline" disagreed with the live
// inventory's 255), and a wrong number erodes trust in every other number
// beside it. What a human cannot see today is the thing the product exists to
// do — refuse bad tool calls as they happen.
//
// This is the substrate for showing that. O(1) per decision, read on the
// daemon's existing 10s snapshot tick, so it adds nothing to the hook path.
//
// Counted since DAEMON START and labeled that way in the render. A restart
// resets it, which is honest: the process cannot vouch for history it never
// observed, and quietly implying otherwise is the same class of drift as the
// stale check count.

/** Guard activity since this daemon started. */
interface GuardTally {
	/** Tool calls refused outright. */
	blocked: number;
	/** Warnings surfaced on allowed calls (counted individually, not per call). */
	warned: number;
	/** Calls escalated to the human for confirmation. */
	asked: number;
	/** Rule id of the most recent block, for a "what stopped me" label. */
	lastBlockRule: string | null;
}

/** The decision fields this module reads — a structural subset of HarnessDecision. */
interface GuardDecisionLike {
	decision: "allow" | "block" | "ask";
	warnings?: readonly string[] | undefined;
	rule_id?: string | undefined;
}

const tally: GuardTally = { blocked: 0, warned: 0, asked: 0, lastBlockRule: null };

/**
 * Fold one guard decision into the tally.
 *
 * A block with no `rule_id` never erases a remembered one: the label exists to
 * answer "what stopped me", and the most recent NAMED rule is a better answer
 * than nothing.
 */
export function recordGuardDecision(decision: GuardDecisionLike): void {
	if (decision.decision === "block") {
		tally.blocked += 1;
		if (decision.rule_id) tally.lastBlockRule = decision.rule_id;
		return;
	}
	if (decision.decision === "ask") {
		tally.asked += 1;
		return;
	}
	tally.warned += decision.warnings?.length ?? 0;
}

/** Current tally. Returns a copy so a caller cannot mutate daemon state. */
export function guardTallySnapshot(): GuardTally {
	return { ...tally };
}

/** Reset every counter. Test-only in production; a restart resets naturally. */
export function resetGuardTally(): void {
	tally.blocked = 0;
	tally.warned = 0;
	tally.asked = 0;
	tally.lastBlockRule = null;
}
