// ===========================================
// Per-event latency log
// ===========================================
// Every harness response (PreToolUse / PostToolUse / lifecycle) writes one
// JSONL line to `<interlinkedDir>/logs/latency.jsonl`. The schema is the same
// shape `interlinked diag latency` (Task #10 follow-up) reads to compute p50/
// p99 per check, slowest files, slowest sessions.
//
// Plan 13 KPIs §"Cross-cutting" / Plan 11 §"Per-section telemetry". Log
// failures must NEVER crash the daemon — fs errors are swallowed deliberately
// (`void e`), since a permission glitch in `.interlinked/logs/` shouldn't take
// down the gate.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROTATION_BYTES_DEFAULT = 10 * 1024 * 1024; // 10 MB

/** Per-tool execution metric serialised into latency.jsonl. The shape matches
 *  `ToolBreakdownEntry` in `quality-checks.ts` — flattened from the engine's
 *  `ToolMetrics` so the latency CLI can compute p50/p99 per tool. */
interface ToolBreakdown {
	tool: string;
	ms: number;
	finding_count: number;
}

export interface LatencyLogEntry {
	hook_event: string | null;
	tool_name: string | null;
	session_id: string | null;
	agent_source: string | null;
	decision: string;
	checks_ran?: string[] | null;
	checks_timing_ms?: number | null;
	tool_breakdown?: ToolBreakdown[] | null;
	/** Per-phase wall-clock breakdown of the PostToolUse handler. Each key
	 *  is a named phase (e.g. "baseline-capture", "structural-checks",
	 *  "quality-checks", "project-wide-sweep", "scored-suggestions",
	 *  "session-persist"); each value is elapsed ms. Sum should approximate
	 *  `checks_timing_ms`. Lets us see which phase is growing on the
	 *  residual = checks_timing_ms − sum(tool_breakdown.ms) bucket. */
	phase_breakdown?: Record<string, number> | null;
}

interface LatencyLogOptions {
	rotation_bytes?: number;
}

/**
 * Append one event-decision record to the latency log under `interlinkedDir`.
 * Creates the `logs/` subdirectory on demand. Rotates the file when it exceeds
 * `rotation_bytes` (default 10 MB) — older content moves to `latency.jsonl.1`,
 * overwriting any prior archive (keep-last-1 policy; richer retention belongs
 * in `interlinked diag latency` if needed).
 *
 * Filesystem errors are deliberately discarded: telemetry must never crash the
 * daemon. The `void e` swallow is the canonical pattern in this codebase
 * (see e.g. `server.ts:347` `writeClassifierStatus`).
 */
export function appendLatencyLog(
	interlinkedDir: string,
	entry: LatencyLogEntry,
	opts: LatencyLogOptions = {},
): void {
	try {
		const logsDir = join(interlinkedDir, "logs");
		if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
		const path = join(logsDir, "latency.jsonl");
		const rotationBytes = opts.rotation_bytes ?? ROTATION_BYTES_DEFAULT;

		// Rotate if needed BEFORE appending so the new line lands in a fresh file.
		if (existsSync(path)) {
			const size = statSync(path).size;
			if (size >= rotationBytes) {
				renameSync(path, `${path}.1`);
			}
		}

		const record = {
			schema: "v1" as const,
			kind: "hook_decision" as const,
			ts: new Date().toISOString(),
			hook_event: entry.hook_event,
			tool_name: entry.tool_name,
			session_id: entry.session_id,
			agent_source: entry.agent_source,
			decision: entry.decision,
			checks_ran: entry.checks_ran ?? null,
			checks_timing_ms: entry.checks_timing_ms ?? null,
			tool_breakdown: entry.tool_breakdown ?? null,
			phase_breakdown: entry.phase_breakdown ?? null,
		};
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch (e) {
		// Telemetry never crashes the daemon. The next event retries against the
		// (possibly recovered) filesystem; persistent failures show up only in
		// tests where the path is intentionally unreachable.
		void e;
	}
}
