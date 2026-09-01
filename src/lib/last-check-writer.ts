// ===========================================
// last-check.txt writer — statusline kinetic-row feed (hook-entry path)
// ===========================================
// The generated .mjs hook (src/lib/hooks-template.ts, `writeLastCheck`)
// writes `.interlinked/last-check.txt` so the bash statusline can render
// outcome language ("✗ blocked rm -rf · 2s ago"). This module is the SAME
// writer for the compiled `dist/hook-entry.js` path — the dev-mode entry
// this repo registers in `.claude/settings.json`. Found 2026-06-12: the
// two-implementations drift left hook-entry without the writer, freezing
// the statusline's row 2 on an 11-day-old block.
//
// Format contract (mirrors the .mjs exactly; bash `last_field` parses it):
//   result=clean|warn|block|no_harness
//   tool=<tool label> | file=<repo-relative or empty> | summary=<block only>
//   rule=<block only> | count=<warn only> | ms=<elapsed>
// One line, ` | `-separated, pipes/newlines stripped from values.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessDecision } from "../harness/types.js";
import type { UnifiedHookEvent } from "../harness/unified-event.js";

export interface LastCheckFields {
	result: "clean" | "warn" | "block" | "no_harness";
	tool?: string;
	file?: string;
	summary?: string;
	rule?: string;
	count?: number;
	ms?: number;
}

const SUMMARY_MAX = 80;

/** key=value pairs joined with ` | `, empties skipped, delimiters stripped. */
export function formatLastCheckLine(fields: LastCheckFields): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined || v === null || v === "") continue;
		const safe = String(v)
			.replace(/[|\r\n]+/g, " ")
			.trim();
		parts.push(`${k}=${safe}`);
	}
	return parts.join(" | ");
}

/** Repo-relative edited file for tool calls; "" when the event has none. */
export function extractEventFile(event: UnifiedHookEvent): string {
	// `event` is ultimately built from an untrusted native runner payload
	// (`adapter.parseHookInput`, tolerant-of-anything by contract) or replayed
	// from a stored JSONL record — `action` is required by the *declared*
	// type but not guaranteed to survive a malformed source, so this cast
	// stays honest about that rather than trusting the static type.
	const action = event.action as { kind?: string; tool_input?: unknown } | undefined;
	if (!action || action.kind !== "tool_call") return "";
	const ti = action.tool_input as
		| { file_path?: unknown; filePath?: unknown; path?: unknown; notebook_path?: unknown }
		| null
		| undefined;
	if (!ti || typeof ti !== "object") return "";
	const raw = ti.file_path ?? ti.filePath ?? ti.path ?? ti.notebook_path ?? "";
	if (typeof raw !== "string" || raw.length === 0) return "";
	// Same untrusted-source rationale as `action` above — `context` is
	// declared required but a malformed/replayed event can still omit it.
	const context = event.context as { cwd?: string } | undefined;
	const cwd = context?.cwd;
	if (cwd && raw.startsWith(`${cwd}/`)) return raw.slice(cwd.length + 1);
	return raw;
}

function toolLabel(event: UnifiedHookEvent): string {
	// See extractEventFile: `action` is declared required but the source is
	// an untrusted native payload / replayed record, so this stays honest
	// about the possible-absent case rather than trusting the static type.
	const action = event.action as { kind?: string; tool_name?: string } | undefined;
	if (!action) return "tool";
	if (action.kind === "tool_call" && action.tool_name) return action.tool_name;
	if (action.kind === "shell_command") return "Bash";
	return "tool";
}

/** Post-tool BLOCK row (Grok 2026-08-28 issue 11): decision outranks warning
 *  count — a `decision: "block"` with an empty warning list used to write
 *  `result=clean` while the model saw the block (the .mjs and the claude-code
 *  adapter both branch on the decision first). */
function postToolBlockFields(
	event: UnifiedHookEvent,
	decision: HarnessDecision,
	elapsedMs: number,
): LastCheckFields {
	const fields: LastCheckFields = {
		result: "block",
		tool: toolLabel(event),
		file: extractEventFile(event),
		ms: elapsedMs,
	};
	if (decision.rule_id) fields.rule = decision.rule_id;
	return fields;
}

/**
 * Map a (event, decision) pair to last-check fields, mirroring the .mjs
 * call sites: pre-tool blocks; post-tool block/warn/clean. Everything else —
 * pre-tool allow/ask, lifecycle events — returns null (no write).
 */
export function deriveLastCheckFields(
	event: UnifiedHookEvent,
	decision: HarnessDecision,
	elapsedMs: number,
): LastCheckFields | null {
	if (event.phase === "pre-tool") {
		if (decision.decision !== "block") return null;
		const summary = (decision.reason || "Blocked by Interlinked guard")
			.split(/\r?\n/)[0]
			?.slice(0, SUMMARY_MAX);
		const fields: LastCheckFields = {
			result: "block",
			tool: toolLabel(event),
			file: extractEventFile(event),
		};
		if (summary) fields.summary = summary;
		if (decision.rule_id) fields.rule = decision.rule_id;
		return fields;
	}
	if (event.phase === "post-tool") {
		const warnings = decision.warnings ?? [];
		if (decision.decision === "block") return postToolBlockFields(event, decision, elapsedMs);
		if (warnings.length > 0) {
			return {
				result: "warn",
				tool: toolLabel(event),
				file: extractEventFile(event),
				count: warnings.length,
				ms: elapsedMs,
			};
		}
		return {
			result: "clean",
			tool: toolLabel(event),
			file: extractEventFile(event),
			ms: elapsedMs,
		};
	}
	return null;
}

/** Harness-unreachable marker for post-tool events — mirrors the .mjs
 *  `no_harness` write so the statusline can distinguish "daemon skipped
 *  this edit" from silence. Best-effort; never throws. */
export function writeNoHarnessArtifact(
	interlinkedDir: string,
	event: UnifiedHookEvent,
	elapsedMs: number,
): void {
	if (event.phase !== "post-tool") return;
	try {
		const fields: LastCheckFields = {
			result: "no_harness",
			tool: toolLabel(event),
			file: extractEventFile(event),
			ms: elapsedMs,
		};
		writeFileSync(join(interlinkedDir, "last-check.txt"), `${formatLastCheckLine(fields)}\n`);
	} catch (e) {
		void e;
	}
}

/** Derive + write in one best-effort call. Never throws (statusline input
 *  is cosmetic — losing one update must not disturb the hook path). */
export function writeLastCheckArtifact(
	interlinkedDir: string,
	event: UnifiedHookEvent,
	decision: HarnessDecision,
	elapsedMs: number,
): void {
	try {
		const fields = deriveLastCheckFields(event, decision, elapsedMs);
		if (!fields) return;
		writeFileSync(join(interlinkedDir, "last-check.txt"), `${formatLastCheckLine(fields)}\n`);
	} catch (e) {
		void e;
	}
}
