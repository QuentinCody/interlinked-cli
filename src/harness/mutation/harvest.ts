// ===========================================
// Per-edit mutation — harvesting the earlier window's results
// ===========================================
// A run that outlived the PreToolUse budget kept going; the runner retained its
// report under the client-minted job id. This claims those reports in the
// PostToolUse window and turns them into findings for the agent.
//
// PostToolUse cannot prevent the write — the bytes are already on disk. What it
// can do is tell the agent, in the same turn, that what it just wrote has
// survivors. That is strictly better than discarding work the engine already
// paid for, which is what happened before this existed.
//
// NEVER THROWS. This runs after a tool call has already succeeded; an
// unreachable runner or a half-finished job must degrade to "no findings this
// window", never to an exception escaping into the hook.

import type { PendingRun } from "./pending-runs.js";
import { strykerToAdapted } from "./stryker-adapter.js";

/** Minimal fetch shape, injected so tests need no network. */
export type HarvestFetch = (url: string) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

export interface HarvestedSurvivor {
	mutator: string;
	lexeme: string;
	replacement: string;
	line: number;
}

export interface HarvestResult {
	/** How many jobs actually returned a report — for honest reporting of partials. */
	harvested: number;
	survivors: HarvestedSurvivor[];
}

/** Same identity rule the sharded runner uses, so overlapping shards collapse. */
function keyOf(s: HarvestedSurvivor): string {
	return [s.mutator, s.lexeme, s.replacement, String(s.line)].join("\x00");
}

/**
 * Outcome of one claim attempt.
 *
 * "not ready" and "gone" must NOT be collapsed. Retrying a job that is still
 * computing is the whole point of the second window; retrying a runner that
 * refused the connection just burns the budget waiting for a machine that is
 * not coming back. Collapsing both into one value made a dead peer hold
 * PostToolUse for the full 25s — caught by this module's own suite taking 25s.
 */
type ClaimOutcome =
	| { kind: "ready"; survivors: HarvestedSurvivor[] }
	| { kind: "not_ready" }
	| { kind: "gone" };

function survivorsFrom(report: unknown): HarvestedSurvivor[] | null {
	const adapted = strykerToAdapted(report);
	if (adapted === null) return null;
	return adapted
		.flatMap((f) => f.mutants)
		.filter((m) => m.status === "survived")
		.map((m) => ({
			mutator: m.raw.mutator,
			lexeme: m.raw.originalLexeme,
			replacement: m.raw.replacement,
			line: 0,
		}));
}

async function claimOne(run: PendingRun, fetchImpl: HarvestFetch): Promise<ClaimOutcome> {
	try {
		const res = await fetchImpl(`${run.runnerUrl.replace(/\/$/, "")}/job/${encodeURIComponent(run.jobId)}`);
		// 404 is the ordinary "still running, or already claimed" answer. Any other
		// non-ok status is a server that answered but will never produce this report.
		if (!res.ok) return res.status === 404 ? { kind: "not_ready" } : { kind: "gone" };
		const survivors = survivorsFrom(await res.json());
		return survivors === null ? { kind: "gone" } : { kind: "ready", survivors };
	} catch {
		// Unreachable runner. The write already happened; a harvest failure must not
		// become an exception in a PostToolUse hook — and must not be retried.
		return { kind: "gone" };
	}
}

/** How long the second window will wait for a run to finish, and how often it asks. */
export const DEFAULT_HARVEST_BUDGET_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 400;

export interface HarvestOptions {
	budgetMs?: number;
	pollIntervalMs?: number;
	/** Injected so tests need no real time. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

type ResolvedHarvestOptions = Required<HarvestOptions>;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolveOptions(options: HarvestOptions): ResolvedHarvestOptions {
	return {
		budgetMs: options.budgetMs ?? DEFAULT_HARVEST_BUDGET_MS,
		pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
		sleep: options.sleep ?? realSleep,
		now: options.now ?? Date.now,
	};
}

/**
 * Claim one shard, WAITING for it if it has not finished yet.
 *
 * PostToolUse fires milliseconds after the write, but a run that outlived the
 * PreToolUse budget still needs seconds. A single immediate claim therefore
 * always lost the race — it 404s and the work is discarded, defeating the point
 * of a second window. This is the "another block of time" half of the two-window
 * design, so waiting IS the feature, not a workaround.
 *
 * A 404 means "not ready, or already claimed"; the two are indistinguishable
 * here, so the poll simply stops once the budget is gone.
 */
async function claimWithWait(
	run: PendingRun,
	fetchImpl: HarvestFetch,
	opts: ResolvedHarvestOptions,
): Promise<HarvestedSurvivor[] | null> {
	const deadline = opts.now() + opts.budgetMs;
	for (;;) {
		const got = await claimOne(run, fetchImpl);
		if (got.kind === "ready") return got.survivors;
		// A runner that is gone will never become ready; only wait on "not ready".
		if (got.kind === "gone") return null;
		if (opts.now() >= deadline) return null;
		await opts.sleep(opts.pollIntervalMs);
	}
}

/** Claim every pending shard for one edit and merge their survivors. */
export async function harvestPending(
	runs: readonly PendingRun[],
	fetchImpl: HarvestFetch,
	options: HarvestOptions = {},
): Promise<HarvestResult> {
	const opts = resolveOptions(options);
	// Shards wait CONCURRENTLY: the window costs the slowest shard, not their sum.
	const settled = await Promise.all(runs.map((r) => claimWithWait(r, fetchImpl, opts)));
	const seen = new Set<string>();
	const survivors: HarvestedSurvivor[] = [];
	let harvested = 0;
	for (const got of settled) {
		if (got === null) continue;
		harvested++;
		for (const s of got) {
			const k = keyOf(s);
			if (seen.has(k)) continue;
			seen.add(k);
			survivors.push(s);
		}
	}
	return { harvested, survivors };
}

/** How many survivors to name before summarising — a hook message the agent will
 *  actually read beats an exhaustive one it will skim past. */
const MAX_LISTED = 8;

/** Plural agreement, so a single finding does not read as machine output. */
function pluralize(n: number, word: string): string {
	return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

/**
 * One warning naming the survivors, or null when there is nothing to say.
 *
 * Silence on a zero-survivor report is deliberate: a per-edit gate that speaks
 * on every edit trains the reader to stop looking. NOT "clean" (review
 * 2026-08-28): an empty survivor list from the late window is only a valid
 * survivor report containing zero survivors — it never went through the
 * evaluator and carries no test/engine/census evidence, so it certifies
 * nothing (the ledger row says `harvest_partial` for the same reason).
 */
export function formatHarvestWarning(file: string, survivors: HarvestedSurvivor[]): string | null {
	if (survivors.length === 0) return null;
	const listed = survivors.slice(0, MAX_LISTED);
	const lines = listed.map((s) => `    ${s.mutator}: ${s.lexeme} -> ${s.replacement}`);
	const more = survivors.length > listed.length ? [`    …and ${survivors.length - listed.length} more`] : [];
	return [
		`[interlinked:mutation] ${pluralize(survivors.length, "surviving mutant")} in ${file} — measured after the write, in the second window:`,
		...lines,
		...more,
		"  A survivor means a test executes that code but would not notice it being wrong.",
	].join("\n");
}
