// CRAP telemetry — append-only JSONL under `.interlinked/crap-telemetry.jsonl`.
//
// Mirrors the `suggestion-scorer.ts:writeTelemetry` pattern (one entry per
// finding per phase, newline-delimited JSON, non-blocking try/catch). This
// stream lets us calibrate the CRAP threshold over time: if >80% of shown
// findings at score X are ignored, X is too low for that complexity range.
//
// The writer is fully best-effort — telemetry failures must never propagate
// to the hook pipeline and block the agent.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type CrapTelemetryPhase = "verify" | "post_tool_use" | "pre_tool_use";

export interface CrapTelemetryEntry {
	ts: string;
	session_id: string;
	agent_name?: string;
	phase: CrapTelemetryPhase;
	file: string;
	function: string;
	line: number;
	complexity: number;
	coverage_pct: number;
	crap_score: number;
	stale: boolean;
	/** Whether the agent saw this finding (false for silent/shadow mode). */
	shown: boolean;
	threshold: number;
}

/** Filename for the telemetry stream. Public so callers can reference it. */
export const CRAP_TELEMETRY_FILENAME = "crap-telemetry.jsonl";

/**
 * Append CRAP telemetry entries to `.interlinked/crap-telemetry.jsonl`.
 *
 * Non-blocking — any filesystem error is swallowed silently. Creates the
 * parent directory if it doesn't exist. Atomicity is one entry per line,
 * newline-delimited, suitable for `jq`/`duckdb`/line-count analysis.
 */
export function appendCrapTelemetry(
	interlinkedDir: string,
	entries: CrapTelemetryEntry[],
): void {
	if (entries.length === 0) return;
	try {
		const telemetryPath = join(interlinkedDir, CRAP_TELEMETRY_FILENAME);
		const dir = dirname(telemetryPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const body = entries.map((e) => JSON.stringify(e)).join("\n");
		appendFileSync(telemetryPath, `${body}\n`);
	} catch (err) {
		void err; /* intentional: telemetry is non-fatal — never block the agent */
	}
}
