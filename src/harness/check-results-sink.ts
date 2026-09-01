// ===========================================
// Check-Results Sink — per-call faithful test record
// ===========================================
// The harness computes a structured `decision.check_results` per tool call but
// never serializes it (the durable logs are lossy/aggregate). This sink writes
// one compact row per PostToolUse call to `.interlinked/check-results.jsonl` so
// the viz BASELINE filmstrip can replay exactly what the agent was tested on.
//
// FAIL-OPEN by contract: this runs AFTER the decision is returned to the hook,
// fire-and-forget. It must never throw or block — a sink failure can never be
// allowed to affect the agent's tool loop.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventAttributionFields } from "./event-attribution-fields.js";
import type { HarnessDecision } from "./types/decisions.js";
import type { HarnessEvent } from "./types/events.js";

interface CheckRowEntry {
	id: string;
	severity: string;
	determinism: "proven" | "heuristic";
	phase?: string;
}

interface CheckRow {
	ts: string;
	tool_use_id: string;
	/** Session the call belonged to — lets consumers slice check noise per
	 *  session/agent (absent on legacy rows written before 2026-07-24). */
	session?: string;
	agent_name?: string;
	subagent_id?: string;
	model?: string;
	parent_agent?: string;
	tool?: string;
	file?: string;
	decision: "allow" | "block";
	ran?: number;
	checks: CheckRowEntry[];
}

const FILE_KEYS = ["file_path", "path", "notebook_path"];

/** Best-effort file path for the call: a finding's own file, else the tool input, else a modified file. */
function extractFile(event: HarnessEvent, findings: HarnessDecision["check_results"]): string | undefined {
	const fromFinding = findings?.find((c) => c.file)?.file;
	if (fromFinding) return fromFinding;
	const input = event.tool_input;
	if (input) {
		for (const key of FILE_KEYS) {
			const v = input[key];
			if (typeof v === "string") return v;
		}
	}
	const fm = event.files_modified;
	return fm && fm.length > 0 ? fm[0] : undefined;
}

/**
 * Project a PostToolUse decision into a filmstrip row. Returns null when there
 * is nothing to record (no correlation id, or no checks ran and nothing fired).
 */
export function buildCheckRow(event: HarnessEvent, decision: HarnessDecision): CheckRow | null {
	const toolUseId = event.tool_use_id;
	if (!toolUseId) return null;

	const findings = decision.check_results ?? [];
	const ranList = decision.checks_ran ?? [];
	if (findings.length === 0 && ranList.length === 0) return null;

	const checks: CheckRowEntry[] = findings.map((c) => {
		const entry: CheckRowEntry = {
			id: c.name,
			severity: c.severity,
			determinism: c.determinism === "fully_deterministic" ? "proven" : "heuristic",
		};
		if (c.phase) entry.phase = c.phase;
		return entry;
	});

	const row: CheckRow = {
		ts: event.timestamp,
		tool_use_id: toolUseId,
		decision: decision.decision === "allow" ? "allow" : "block",
		checks,
	};
	if (event.session_id) row.session = event.session_id;
	if (event.agent_name) row.agent_name = event.agent_name;
	Object.assign(row, eventAttributionFields(event));
	if (event.tool_name) row.tool = event.tool_name;
	const file = extractFile(event, decision.check_results);
	if (file) row.file = file;
	if (ranList.length > 0) row.ran = ranList.length;
	return row;
}

/**
 * Append the call's check-results row under `cwd/.interlinked/`. Swallows every
 * error — the sink is fire-and-forget and must never disturb the tool loop.
 */
export function appendCheckResults(cwd: string, event: HarnessEvent, decision: HarnessDecision): void {
	try {
		const row = buildCheckRow(event, decision);
		if (!row) return;
		const path = join(cwd, ".interlinked", "check-results.jsonl");
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(row)}\n`);
	} catch (err) {
		void err; /* fire-and-forget: a sink failure must never affect the agent */
	}
}
