// ===========================================
// Dead-on-arrival — Stop-time reachability nudge
// ===========================================
// Companion to verification-stop-checks.ts. One Stop / SessionEnd
// reflection nudge: a file edited this session whose FRESH Supermodel
// `.graph.*` shard reports zero dependent files (`impact.direct === 0`)
// and no external callers (`[calls]` absent or empty) — nothing imports
// it or calls into it. Either a new entry point wired up elsewhere, or
// dead on arrival.
//
// Freshness is gated through `classifyCase`: only an `E-fresh` shard is
// trusted, so a stale or missing shard yields no finding. That is the
// zero-false-positive contract — when the data can't be trusted the check
// stays silent rather than guessing (the reason plan-07 scoped PostToolUse
// out; at Stop enough wall-clock has usually passed for Supermodel's
// daemon to have regenerated the shard). See
// `docs/plans/08-supermodel-graph-provider.md` §3c.
//
// Deterministic; touches the filesystem (a stat + small shard read per
// file). A warning (stderr), never blocks — the same "lever held in
// reserve" stance as the commit-cadence and verification-stop nudges.

import { relative } from "node:path";
import { classifyCase } from "./graph-prediction-classifier.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import { loadGraphForFile } from "./supermodel-graph.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

interface DeadOnArrivalHit {
	/** Resolved absolute path of the dead-on-arrival source file. */
	sourcePath: string;
}

/** Maximum hits enumerated in the Stop nudge. */
const DEAD_ON_ARRIVAL_MAX_SHOWN = 5;

/**
 * Public — Stop-time scan of the files written this session. Returns one
 * hit per file whose fresh Supermodel shard reports it as unreferenced
 * (no dependent files and no callers).
 *
 * Touches the filesystem (a stat + small shard read per file); intended
 * for the Stop / SessionEnd branch, never a hot path. Deduplicates on the
 * resolved source path because `files_written` stores both the raw and
 * the resolved-absolute form of each file (see session-state.ts).
 */
export function detectDeadOnArrival(
	filesWritten: ReadonlySet<string>,
	cwd: string,
): DeadOnArrivalHit[] {
	const hits: DeadOnArrivalHit[] = [];
	const seen = new Set<string>();

	for (const file of filesWritten) {
		let info: ReturnType<typeof classifyCase>;
		try {
			info = classifyCase(file, cwd);
		} catch {
			continue; // classification failure — treat as "can't tell", skip
		}
		// Only a fresh shard is trustworthy. A / B / C / D / E-stale → skip.
		if (info.case !== "E-fresh") continue;
		if (seen.has(info.sourcePath)) continue;
		seen.add(info.sourcePath);

		const graph = loadGraphForFile(file, cwd);
		if (!graph) continue;
		const noDependents = graph.impact?.direct === 0;
		const noCallers = !graph.calls || graph.calls.callers.length === 0;
		if (noDependents && noCallers) {
			hits.push({ sourcePath: info.sourcePath });
		}
	}

	return hits;
}

/**
 * Public — pure formatter for the dead-on-arrival Stop nudge. Returns null
 * when there are no hits. Paths are shown relative to `cwd` when possible.
 */
export function formatDeadOnArrivalWarning(
	hits: ReadonlyArray<DeadOnArrivalHit>,
	cwd?: string,
): string | null {
	if (hits.length === 0) return null;
	const shown = hits.slice(0, DEAD_ON_ARRIVAL_MAX_SHOWN);
	const lines = shown.map((h) => {
		const display = cwd ? relative(cwd, h.sourcePath) || h.sourcePath : h.sourcePath;
		return `  - ${display}`;
	});
	const more =
		hits.length > DEAD_ON_ARRIVAL_MAX_SHOWN
			? `\n  ...and ${hits.length - DEAD_ON_ARRIVAL_MAX_SHOWN} more`
			: "";
	return (
		`[interlinked:verify-before-stop] Stopping with ${hits.length} file(s) edited this ` +
		"session that nothing imports or calls into, per their fresh Supermodel `.graph` " +
		`shards:\n${lines.join("\n")}${more}\n` +
		"Each is either a new entry point wired up elsewhere, or dead on arrival. Confirm " +
		"they're reachable before stopping."
	);
}

/** Stop-wiring entry point — relocated from lifecycle-stop-warnings.ts (line-cap
 *  pressure) alongside its own detect/format pair, matching the co-located
 *  pattern fixture-leak.ts / untested-exports-stop-check.ts already use.
 *  Behavior unchanged: same name, same signature, so the call site in
 *  buildVerificationStopWarnings needed no edit, only its import source. */
export function checkDeadOnArrival(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cwd = event.cwd || ctx.cwd;
	const doaHits = detectDeadOnArrival(session.files_written, cwd);
	const warning = formatDeadOnArrivalWarning(doaHits, cwd);
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: dead-on-arrival (${doaHits.length})`);
	return warning;
}
