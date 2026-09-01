// ===========================================
// Edit-contract phase — LG-1…LG-5 orchestration (edit-contract-hardening.md)
// ===========================================
//
// The single PreToolUse slot where the edit-contract pieces compose, in an
// order that makes each failure explain the next:
//   1. stale-read warning (LG-3)  — pushed FIRST so a doom block carries it:
//      staleness is the explanation, the rescue is the exit.
//   2. blind-edit provenance (LG-4) — measure-first: recurrence row always,
//      agent-visible warning only when `edit_contract.blind_edit: "warn"`.
//   3. apply_patch context validation (LG-2, warn-tier).
//   4. Edit/MultiEdit doom block (LG-1/LG-2) with one-round-trip rescue.
// Every observation lands a recurrence row (LG-5) so promotion decisions
// (apply_patch warn→block, blind-edit measure→warn) ride on measured counts.

import { blindEditSpan, ensureEditMechanics, staleReadWarning } from "../read-provenance.js";
import { recordHarnessCaught } from "../recurrence.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { analyzeApplyPatchDoom, analyzeStrReplaceDoom, formatDoomReason } from "./edit-doom.js";

type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/** Recurrence row for one edit-contract observation (fire-and-forget). */
function recordRow(
	event: HarnessEvent,
	checkId: string,
	file: string,
	phase: "pre_block" | "pre_warn",
	message?: string,
): void {
	recordHarnessCaught({
		check_id: checkId,
		agent_source: event.agent_source,
		session_id: event.session_id,
		file,
		cwd: event.cwd,
		phase,
		message,
	});
}

function applyStaleReadCheck(
	event: HarnessEvent,
	session: SessionTrajectory,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (rules.edit_contract?.stale_read === "off") return;
	const warning = staleReadWarning(session, event, toolName, toolInput);
	if (!warning) return;
	warnings.push(warning);
	recordRow(event, "edit-stale-read", String(toolInput.file_path ?? ""), "pre_warn");
}

function applyBlindEditCheck(
	event: HarnessEvent,
	session: SessionTrajectory,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	const mode = rules.edit_contract?.blind_edit ?? "measure";
	if (mode === "off") return;
	const span = blindEditSpan(session, event, toolName, toolInput);
	if (!span) return;
	ensureEditMechanics(session).blind_edits++;
	recordRow(
		event,
		"edit-blind-lines",
		span.file,
		"pre_warn",
		`anchor at lines ${span.startLine}–${span.endLine} never displayed this session`,
	);
	if (mode === "warn") {
		warnings.push(
			`[interlinked:blind-edit][heuristic] This edit anchors on lines ${span.startLine}–${span.endLine} of ${span.file}, which this session never displayed (partial reads only). If you know this region from a bash read or an earlier session, proceed; otherwise Read that range first.`,
		);
	}
}

/**
 * The composed edit-contract phase. Returns a block decision for doomed
 * Edit/MultiEdit calls (the client would reject them anyway); everything else
 * is warnings/telemetry. Wired in pre-tool.ts in the old-string guard's slot.
 */
export function evaluateEditContractPhase(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	// Provenance checks need a session's view history; the doom block does not
	// (fail open on the session-less path, never on the doomed edit itself).
	if (session) {
		applyStaleReadCheck(event, session, rules, toolName, toolInput, warnings);
		applyBlindEditCheck(event, session, rules, toolName, toolInput, warnings);
	}

	for (const doom of analyzeApplyPatchDoom(toolName, toolInput)) {
		warnings.push(doom.warning);
		recordRow(event, "edit-applypatch-context", doom.path, "pre_warn");
	}

	const doom = analyzeStrReplaceDoom(toolName, toolInput);
	if (!doom) return null;
	if (session) {
		const mechanics = ensureEditMechanics(session);
		mechanics.doomed++;
		mechanics.last_doom = { file: doom.filePath, step: session.tool_call_count };
	}
	const checkId =
		doom.kind === "missing" ? "edit-doomed-missing-anchor" : "edit-doomed-ambiguous-anchor";
	recordRow(event, checkId, doom.filePath, "pre_block", `entry ${doom.entryIndex}/${doom.entryCount}`);
	return {
		decision: "block",
		reason: formatDoomReason(doom),
		rule_id: doom.kind === "missing" ? "edit_doom_missing_anchor" : "edit_doom_ambiguous_anchor",
		warnings,
	};
}
