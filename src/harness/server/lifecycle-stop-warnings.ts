// ===========================================
// Stop-event verification warning helpers
// ===========================================
// Extracted from lifecycle-events.ts (2026-06 refactor).
// Owns buildStaleBaselineNudge and buildCommitCadenceNudge directly;
// re-exports buildVerificationStopWarnings and pushIfNotNull from
// lifecycle-stop-warnings-code-file-verification.ts (line-cap split,
// 2026-09) so every existing importer keeps resolving through this module.
// The main lifecycle-events.ts owns buildStopWarnings (which wires
// buildPatternRescanWarnings, the sequence detectors, and calls into
// this module) — keeping test source-text assertions intact.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatStaleBaselineWarning,
	NUDGE_MARKER,
	shouldNudge,
} from "../baseline-staleness.js";
import { formatStopNudge, readSessionTokens } from "../commit-cadence.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

export { buildVerificationStopWarnings } from "./lifecycle-stop-warnings-code-file-verification.js";

/** Commit-cadence Stop nudge — encourage bundling uncommitted code-file
 *  edits into commits before ending. Doc/plan files are excluded.
 *  Wording escalates by cumulative session token count, read once from
 *  the transcript path the hook script forwarded. Returns null when the
 *  nudge is disabled, already-emitted, or below threshold; otherwise
 *  marks `stop_nudge_emitted` and returns the formatted warning. */
/**
 * Stale-baseline nudge. Every ratchet compares against a committed water-line,
 * so a stale one silently stops catching regressions — the failure mode is a
 * green run that measured the wrong month.
 *
 * Throttled to once a day and marker-backed: a baseline stays stale for weeks,
 * and repeating the identical warning at every Stop would train the reader to
 * ignore it.
 */
export function buildStaleBaselineNudge(
	ctx: ServerRuntime,
	event: HarnessEvent,
	sessionWroteFiles = true,
): string | null {
	// Repo-housekeeping nudges address sessions DOING repo work. A read-only
	// session (zero files_written) was nagged about 56-day-old baselines it
	// never touched (operator report 2026-08-23) — same class as the
	// gate-reach fix; stay silent there.
	if (!sessionWroteFiles) return null;
	const interlinkedDir = join(event.cwd || ctx.cwd, ".interlinked");
	const now = Date.now();
	if (!shouldNudge({ interlinkedDir, now })) return null;
	const warning = formatStaleBaselineWarning({ interlinkedDir, now });
	if (warning === null) return null;
	try {
		writeFileSync(join(interlinkedDir, NUDGE_MARKER), `${new Date(now).toISOString()}\n`);
	} catch (err) {
		// Marker unwritable (read-only checkout, permissions). Nudging again
		// tomorrow beats throwing out of the Stop handler.
		void err;
	}
	return warning;
}

export function buildCommitCadenceNudge(
	ctx: ServerRuntime,
	event: HarnessEvent,
	// Nullable: the "returns null when session is falsy" test pins a no-throw contract.
	session: SessionTrajectory | undefined,
): string | null {
	const cadenceCfg = ctx.rules.commit_cadence;
	if (!cadenceCfg?.enabled || !session || session.stop_nudge_emitted) return null;
	const nonDocCount = session.non_doc_files_edited_since_commit?.size ?? 0;
	const docCount = session.doc_files_edited_since_commit ?? 0;
	const tokens = readSessionTokens(event.transcript_path, event.agent_source);
	const cumulativeTokens = tokens?.total;
	const nudge = formatStopNudge({
		uncommittedNonDocCount: nonDocCount,
		docFilesExcluded: docCount,
		threshold: cadenceCfg.stop_threshold,
		...(cumulativeTokens !== undefined ? { cumulativeTokens } : {}),
		tokenBandLow: cadenceCfg.token_band_low,
		tokenBandHigh: cadenceCfg.token_band_high,
	});
	if (nudge === null) return null;
	session.stop_nudge_emitted = true;
	ctx.log(
		`Commit-cadence Stop nudge: ${nonDocCount} uncommitted code files, ${docCount} doc files excluded, tokens=${tokens?.total ?? "n/a"}`,
	);
	return nudge;
}
