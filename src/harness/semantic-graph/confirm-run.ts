// Semantic graph — the confirmation run. Loads the unit snapshot and the
// latest edges, takes the top slice of proposed edges, asks Haiku (through an
// injectable runner), and appends every edge whose verdict changed its state.
// An `undecided` verdict appends nothing: the edge stays proposed and the next
// run may select it again. Haiku confirms; it never gates.

import {
	confirmMany,
	DEFAULT_CONFIRM_FRACTION,
	DEFAULT_CONFIRM_MIN,
	defaultHaikuRunner,
	type HaikuRunner,
	selectForConfirmation,
} from "./confirm.js";
import { loadRelationships } from "./relationships.js";
import { appendEdges, latestEdges, loadEdges, loadUnits } from "./store.js";
import type { Edge } from "./types.js";

export interface ConfirmRunOptions {
	/** Injected in tests; `defaultHaikuRunner` otherwise. */
	runner?: HaikuRunner;
	/** Top slice fraction; default `DEFAULT_CONFIRM_FRACTION`. */
	fraction?: number;
	/** Slice floor; default `DEFAULT_CONFIRM_MIN`. */
	min?: number;
	/** Hard ceiling on runner calls. */
	maxCalls: number;
	concurrency?: number;
	now?: () => string;
}

export interface ConfirmRunReport {
	/** Live proposed edges with a target (the selection pool). */
	candidates: number;
	selected: number;
	calls: number;
	/** Selected edges not asked (over `maxCalls`, or units/type unresolved). */
	skipped: number;
	confirmed: number;
	contradicted: number;
	undecided: number;
	/** Rows appended (confirmed + contradicted). */
	appended: number;
	units: number;
}

function liveEdges(cwd: string): Edge[] {
	return [...latestEdges(loadEdges(cwd)).values()].filter((edge) => edge.state !== "stale");
}

export async function runConfirmation(cwd: string, opts: ConfirmRunOptions): Promise<ConfirmRunReport> {
	const now = opts.now ?? (() => new Date().toISOString());
	const units = loadUnits(cwd);
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	const live = liveEdges(cwd);
	const candidates = live.filter((edge) => edge.state === "proposed" && edge.target !== null).length;
	const selected = selectForConfirmation(live, opts.fraction ?? DEFAULT_CONFIRM_FRACTION, opts.min ?? DEFAULT_CONFIRM_MIN);
	const result = await confirmMany(
		opts.runner ?? defaultHaikuRunner,
		selected,
		(id) => byId.get(id),
		loadRelationships(cwd).relationships,
		{ maxCalls: opts.maxCalls, ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) },
		now,
	);
	const verdicts = result.edges.map((edge) => edge.confirmation?.verdict).filter((verdict) => verdict !== undefined);
	const changed = result.edges.filter((edge) => edge.state === "confirmed" || edge.state === "contradicted");
	appendEdges(
		cwd,
		changed.map((edge) => ({ ...edge, judged_at: now() })),
	);
	return {
		candidates,
		selected: selected.length,
		calls: result.calls,
		skipped: result.skipped,
		confirmed: verdicts.filter((verdict) => verdict === "supported").length,
		contradicted: verdicts.filter((verdict) => verdict === "contradicted").length,
		undecided: verdicts.filter((verdict) => verdict === "undecided").length,
		appended: changed.length,
		units: units.length,
	};
}
