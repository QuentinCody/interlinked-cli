// Behavioral retrieval cost — how expensive a file is to REACH, measured from
// what agents actually did rather than from static structure.
//
// Retrieval quality is normally argued in the abstract. It has an observable
// signature: an agent that cannot find things searches repeatedly for one
// symbol and reads a pile of unrelated files before it can make one edit.
// Those are recorded facts.
//
// THE ATTRIBUTION IS THE POINT. Read-fanout is charged to the file that was
// finally EDITED, not to the agent. That converts "this agent flailed" into
// "this file is expensive to reach" — a property of the CODEBASE, and
// therefore something a ratchet could hold. It is also self-calibrating across
// repos: no threshold has to be guessed, because the agents supply the
// distribution. A hardened repo and a legacy one will produce different
// numbers honestly, without anyone tuning a constant.
//
// This is deliberately MEASUREMENT ONLY. Whether high retrieval cost predicts
// bad outcomes is an open question, answered by joining these numbers with
// `outcomes.ts`. If it does not predict trouble, no ratchet gets built on it —
// which is the whole reason the join was built before the metric.
//
// Known limit: cost is charged to the first edit after an exploration run, so
// exploration that serves several later edits lands entirely on the first one.
// That is the conservative direction (it never spreads blame onto files that
// were cheap), and the alternative — splitting cost across subsequent edits —
// would invent an attribution the data does not support.

import type { OutcomeEvent } from "./outcomes.js";

/** Per-file retrieval cost, in units of agent effort spent getting there. */
interface RetrievalCost {
	/** Distinct OTHER files read before this file's first edit. */
	readsBeforeEdit: number;
	/** Searches issued before this file's first edit. */
	searchesBeforeEdit: number;
	/** Searches that repeated a term already searched — outright retrieval failure. */
	repeatSearches: number;
}

/** Tools whose calls count as reading a file. */
const READ_TOOLS = new Set(["Read", "NotebookRead", "read_file"]);
/** Tools whose calls count as a search. */
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Search", "grep", "rg"]);

/** Exploration accumulated since the last edit, awaiting a file to charge it to. */
interface PendingExploration {
	filesRead: Set<string>;
	searches: number;
	repeats: number;
	terms: Set<string>;
}

function emptyExploration(): PendingExploration {
	return { filesRead: new Set(), searches: 0, repeats: 0, terms: new Set() };
}

/** Fold one non-edit event into the pending exploration run. */
function accumulate(pending: PendingExploration, e: OutcomeEvent): void {
	if (READ_TOOLS.has(e.tool) && e.file) {
		pending.filesRead.add(e.file);
		return;
	}
	if (!SEARCH_TOOLS.has(e.tool)) return;
	pending.searches += 1;
	const term = e.searchTerm;
	if (!term) return;
	if (pending.terms.has(term)) pending.repeats += 1;
	else pending.terms.add(term);
}

/**
 * Charge the pending exploration to `file`, which was just edited for the
 * first time.
 *
 * Reading the file you then edit is ORIENTATION, not retrieval cost — the
 * agent had already found it — so the target is excluded from its own count.
 */
function chargeTo(file: string, pending: PendingExploration): RetrievalCost {
	const others = new Set(pending.filesRead);
	others.delete(file);
	return {
		readsBeforeEdit: others.size,
		searchesBeforeEdit: pending.searches,
		repeatSearches: pending.repeats,
	};
}

/**
 * Retrieval cost per file across one recorded sequence.
 *
 * Only a file's FIRST edit accrues cost: by the second edit the agent is
 * already oriented, and charging again would measure the work, not the
 * reachability. Files never edited do not appear — cost is only observable
 * when the agent actually arrived somewhere.
 */
export function retrievalCostByFile(events: readonly OutcomeEvent[]): Map<string, RetrievalCost> {
	const costs = new Map<string, RetrievalCost>();
	let pending = emptyExploration();

	for (const e of events) {
		const isEdit = Boolean(e.file) && !READ_TOOLS.has(e.tool) && !SEARCH_TOOLS.has(e.tool);
		if (!isEdit) {
			accumulate(pending, e);
			continue;
		}
		const file = e.file as string;
		if (!costs.has(file)) costs.set(file, chargeTo(file, pending));
		pending = emptyExploration();
	}
	return costs;
}
