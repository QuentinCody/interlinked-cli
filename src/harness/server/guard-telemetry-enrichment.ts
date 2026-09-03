// ===========================================
// Guard telemetry enrichment — model attribution + recurrence bridge
// ===========================================
// Two gaps found 2026-09-03 while asking why an operator kept getting
// approval prompts (79 in two days, 70 of them raised by subagents):
//
// 1. MODEL ATTRIBUTION. `writeActivityRecord` resolves the model from the
//    transcript, but only for `tool_use_start`. Guard verdict rows carried
//    `model: null`, so "which model keeps trying this?" needed a manual join
//    back through `subagent_id`. Re-reading the transcript per verdict would
//    put file I/O on the guard hot path (≈14k verdicts in two days), so the
//    model is cached per ACTOR when the tool_use_start row already paid for
//    the read, and recalled for free at verdict-write time.
//
// 2. RECURRENCE BLINDNESS. `recordHarnessCaught` was wired only into
//    PostToolUse check failures and the edit-contract phase, so PreToolUse
//    guard-rule blocks never reached `recurrences.jsonl`. The most repeated
//    agent behaviour of the session — 61 attempts to delete its own scratch
//    probes — was invisible to `interlinked recurrence list`, which is the
//    surface built to spot exactly that and propose a ratchet.
//
// The actor key is `subagent_id` when present, NOT the session: a subagent's
// tool calls reach the daemon under the PARENT session id, so keying by
// session would blend a Sonnet worker's behaviour into its Opus parent's and
// destroy the per-model comparison this exists to enable.

import { relative } from "node:path";
import { recordHarnessCaught } from "../recurrence.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

/** Bound on the per-actor model cache. The daemon is long-lived and every
 *  subagent mints a fresh key, so this is dropped oldest-first rather than
 *  allowed to grow with session count. */
export const ACTOR_MODEL_CAP = 500;

const actorModels = new Map<string, string>();

/** Test seam: the cache is module state, so a suite must be able to clear it. */
export function __resetActorModelsForTesting(): void {
	actorModels.clear();
}

/** The identity a guard verdict should be attributed to: the subagent when the
 *  event carries one, else the session. */
export function actorKeyFor(event: HarnessEvent): string {
	return event.subagent_id ?? event.session_id;
}

/** Record the model observed for one actor. Empty values are ignored so a
 *  failed transcript read never pins a bogus attribution. */
export function rememberActorModel(actorKey: string, model: string): void {
	if (!model) return;
	if (actorModels.size >= ACTOR_MODEL_CAP && !actorModels.has(actorKey)) {
		const oldest = actorModels.keys().next();
		if (!oldest.done) actorModels.delete(oldest.value);
	}
	actorModels.set(actorKey, model);
}

/** The model last seen for this actor, or undefined. Never guesses. */
export function recallActorModel(actorKey: string): string | undefined {
	return actorModels.get(actorKey);
}

/** Repo-relative path for the edited file, or `bash:<verb>` for a command —
 *  a Bash block has no file, and the bare tool name aggregates too coarsely to
 *  read in `recurrence detail`. */
function subjectOf(event: HarnessEvent, cwd: string): string {
	const input = event.tool_input;
	const filePath = typeof input?.file_path === "string" ? input.file_path : null;
	if (filePath) return relative(cwd, filePath) || filePath;
	const command = typeof input?.command === "string" ? input.command : "";
	const verb = command.trim().split(/\s+/)[0];
	return verb ? `bash:${verb}` : (event.tool_name ?? "unknown");
}

/**
 * Record a PreToolUse guard-rule refusal as a `harness_caught` recurrence,
 * keyed by the rule id so `recurrence list` ranks rules by how often agents
 * run into them and `recurrence propose` can suggest a ratchet.
 *
 * Only refusals are recorded. A `warn` is not a catch — warnings outnumber
 * blocks roughly 7:1 here, and folding them in would drown the ledger. A
 * `dry_run` event never persists, per the repo rule that a simulated call must
 * not move any gate. Never throws: guard telemetry must not break the pipeline.
 */
export function bridgeGuardBlockToRecurrence(
	event: HarnessEvent,
	decision: HarnessDecision,
	fallbackCwd: string,
): void {
	if (event.dry_run) return;
	const refused = decision.decision === "block" || decision.decision === "ask";
	if (!refused || !decision.rule_id) return;
	try {
		const cwd = event.cwd ?? fallbackCwd;
		recordHarnessCaught({
			check_id: decision.rule_id,
			agent_source: event.agent_source ?? "unknown",
			session_id: event.session_id,
			file: subjectOf(event, cwd),
			message: decision.reason,
			cwd,
			ts: event.timestamp,
			phase: "pre_block",
			severity: decision.decision === "block" ? "error" : "warning",
		});
	} catch {
		// Best-effort, mirroring recordHarnessCaught's own contract.
		return;
	}
}
