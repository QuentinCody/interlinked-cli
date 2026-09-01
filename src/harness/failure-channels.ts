// ===========================================
// Phase 1 — Failure-recovery channel orchestrator
// ===========================================
// The single entry point the harness handler in `server.ts` calls when a
// PostToolUse arrives with `tool_outcome === "error"` (folded failure on
// Claude/Codex/Gemini/Copilot) or when a Cursor `postToolUseFailure`
// arrives. Both delivery shapes converge here — the per-provider failure
// detection in event-normalizers.ts already normalized the canonical
// fields, so this layer is provider-agnostic.
//
// Responsibilities (ordered):
//   1. Build a ToolFailureEvent from the HarnessEvent.
//   2. Channel 2 (triage)        — classify the failure label/category.
//   3. Channel 1 (recurrence)    — record under recurrences.jsonl with the
//      triage-derived signature so `interlinked recurrence list --kind
//      tool_failure` aggregates by category, not just by tool.
//   4. Channel 3 (recovery)      — local-tier suggestion.
//   5. Channel 5 (rollback)      — only on file-edit tools, only when we
//      have provenance evidence.
//   6. Channel 6 (explanation)   — local-tier human-readable cause.
//   7. Disk write                — `.interlinked/failures/<failure_id>.json`
//      + index.jsonl row.
//   8. Render warnings[]         — single multi-line string per channel,
//      surfaced via the existing post-decision aggregation in server.ts.
//
// Phase 2 wires the same orchestrator with cloud-tier upgrades; the
// public surface stays identical.

import { join } from "node:path";
import { explainFailure } from "./checks/failure-explanation.js";
import { classifyFailure } from "./checks/failure-triage.js";
import { suggestRecovery } from "./checks/recovery-suggestion.js";
import { assessRollbackFeasibility, formatRollbackLine } from "./checks/rollback-feasibility.js";
import { failureRecordRelPath, mintFailureId, writeFailureRecord } from "./failure-record.js";
import { recordToolFailure } from "./recurrence.js";
import { isFileTrackedAsWritten } from "./session-state.js";

import type {
	FailureRecord,
	HarnessEvent,
	SessionTrajectory,
	ToolFailureEvent,
	TriageResult,
} from "./types.js";

const FILE_EDIT_TOOLS = new Set([
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
	"WriteFile",
	"EditFile",
	"write_file",
	"edit_file",
	"apply_patch",
	"create_file",
	"str_replace",
]);

interface FailureChannelOutput {
	failure_id: string;
	signature: string;
	warnings: string[];
	triage: TriageResult;
	record_path: string;
}

/** Public API — consumed by `src/harness/server.ts` PostToolUse handler.
 *  Idempotent on the disk side (one record per call, always a fresh id);
 *  fail-open semantics — any thrown error in a single channel is caught
 *  and replaced with a degraded warning so the rest of the pipeline still
 *  surfaces useful output. */
export function runFailureChannels(opts: {
	event: HarnessEvent;
	session?: SessionTrajectory;
	cwd: string;
}): FailureChannelOutput | null {
	const { event, session, cwd } = opts;
	if (event.tool_outcome !== "error") return null;
	const toolName = event.tool_name;
	if (!toolName) return null;

	const failureEvent = toFailureEvent(event);
	const triage = safeRun(() => classifyFailure(failureEvent), {
		label: "unknown",
		category: "classifier-crashed",
		confidence: 0,
		source: "local-heuristic",
	});

	const signature = buildSignature(toolName, triage, failureEvent.error_message ?? failureEvent.stderr);
	const warnings: string[] = [];

	// Channel 1 — recurrence (fire-and-forget, swallowed inside recordToolFailure).
	recordToolFailure({
		tool_name: toolName,
		signature,
		agent_source: event.agent_source,
		session_id: event.session_id,
		file: extractFilePath(event) ?? undefined,
		message: failureEvent.error_message ?? undefined,
		cwd,
	});

	const triageLine = formatTriageLine(triage);
	if (triageLine) warnings.push(triageLine);

	// Channel 3 — recovery suggestion.
	const recovery = safeRun(() => suggestRecovery(failureEvent, triage), null);
	if (recovery) warnings.push(`[interlinked:recovery] ${recovery}`);

	// Channel 6 — failure-cause explanation.
	const explanation = safeRun(() => explainFailure(failureEvent, triage), null);
	if (explanation) warnings.push(`[interlinked:explain] ${explanation}`);

	// Channel 5 — rollback feasibility (only file-edit tools, only with
	// provenance evidence).
	let rollback;
	const filePath = extractFilePath(event);
	if (filePath && FILE_EDIT_TOOLS.has(toolName) && session) {
		const provenance = (p: string) => isFileTrackedAsWritten(session, p, cwd);
		rollback = safeRun(() => assessRollbackFeasibility(filePath, cwd, provenance), undefined);
		if (rollback) {
			const rollbackLine = formatRollbackLine(rollback);
			if (rollbackLine) warnings.push(rollbackLine);
		}
	}

	// Disk record. Failures here are tolerable — channel output still flows
	// through warnings[] regardless. Storage failures land in the harness
	// sync-errors log via the upper-layer try/catch.
	const failureId = mintFailureId();
	const record: FailureRecord = {
		failure_id: failureId,
		session_id: event.session_id,
		agent_source: event.agent_source,
		tool_name: toolName,
		tool_input: event.tool_input,
		tool_use_id: event.tool_use_id,
		cwd,
		timestamp: event.timestamp,
		signature,
		error_message: failureEvent.error_message,
		exit_code: failureEvent.exit_code,
		stderr: failureEvent.stderr,
		stdout: failureEvent.stdout,
		triage,
		recovery: recovery ?? undefined,
		explanation: explanation ?? undefined,
		rollback,
	};
	let recordPath: string;
	try {
		writeFailureRecord(record, cwd);
		recordPath = join(cwd, failureRecordRelPath(failureId));
		warnings.push(`[interlinked:failure] full record: ${failureRecordRelPath(failureId)}`);
	} catch {
		recordPath = "";
	}

	return {
		failure_id: failureId,
		signature,
		warnings,
		triage,
		record_path: recordPath,
	};
}

function toFailureEvent(event: HarnessEvent): ToolFailureEvent {
	return {
		session_id: event.session_id,
		agent_source: event.agent_source,
		tool_name: event.tool_name ?? "unknown",
		tool_input: event.tool_input,
		tool_use_id: event.tool_use_id,
		cwd: event.cwd,
		timestamp: event.timestamp,
		error_message: event.error_message,
		exit_code: event.exit_code,
		stderr: event.stderr,
		stdout: event.stdout,
	};
}

function buildSignature(toolName: string, triage: TriageResult, message?: string): string {
	const errClass = triage.category || triage.label;
	const messagePrefix = (message ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
	return `tool_failure:${toolName}:${errClass}:${messagePrefix}`;
}

function formatTriageLine(triage: TriageResult): string | null {
	if (triage.label === "unknown" && triage.category === "no-diagnostic") return null;
	const confidencePct = Math.round(triage.confidence * 100);
	return `[interlinked:triage] ${triage.label} / ${triage.category} (${confidencePct}% local-heuristic)`;
}

function extractFilePath(event: HarnessEvent): string | null {
	const fp = event.tool_input?.file_path as string | undefined;
	if (typeof fp === "string" && fp) return fp;
	const path = event.tool_input?.path as string | undefined;
	if (typeof path === "string" && path) return path;
	return null;
}

function safeRun<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
