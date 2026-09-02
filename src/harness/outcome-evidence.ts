// ===========================================
// Post-tool outcome-evidence lift (shared, protocol-agnostic)
// ===========================================
// The `.mjs` hook flattens a runner's object tool_response into the flat
// `stdout` / `stderr` / `exit_code` / `tool_outcome` fields via
// `deriveToolOutcome` BEFORE sending. The compiled `dist/hook-entry.js` path
// forwards the runner's object untouched, so every daemon consumer of the
// flat fields — `trackTestRun`, `classifyObservedOutcome`, the observed-check
// tracker, `trackErrorOutcome` — saw nothing. Observed live 2026-07-28: a
// PASSING bare `vitest run` classified "neither" and was dropped silently,
// while failures still recorded via the PostToolUseFailure event name — reds
// accumulated, greens could not clear them, and the commit gate wedged shut.
//
// This is the ONE implementation of the daemon-side lift. It is called from
// `processEvent` (server-event-loop) — the choke point BOTH socket protocols
// funnel through — and from `toHarnessEvent` (evaluator-unified) for direct
// framed evaluation. Idempotent by design: an event whose `tool_outcome` is
// already set (the `.mjs` path, or a second pass) is left untouched, so the
// two call sites cannot fight and hook-derived evidence always wins.

import type { HarnessEvent } from "./types.js";

/** Longest lifted stdout/stderr — evidence for classification, not storage.
 *  Tail-kept because test runners print their summary LAST. */
const EVIDENCE_TAIL_BYTES = 8_192;

function tailString(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	return v.length > EVIDENCE_TAIL_BYTES ? v.slice(-EVIDENCE_TAIL_BYTES) : v;
}

/**
 * Populate the flat outcome fields from an OBJECT tool_response, in place.
 *
 * Outcome derivation is conservative: any failure marker (PostToolUseFailure
 * event name, `is_error`, nonzero exit code) wins over "success", and
 * `interrupted` beats both, so a runner that folds failures into plain
 * PostToolUse events never gets a synthesized green. String responses are
 * left exactly as before (`observedOutput` reads them directly).
 */
export function liftOutcomeEvidence(event: HarnessEvent): void {
	const fields = liftableResponseFields(event);
	if (fields === undefined) return;

	applyStreamEvidence(event, fields);
	const codeRaw = applyExitCode(event, fields);
	event.tool_outcome = deriveToolOutcomeFromFields(event, fields, codeRaw);
}

/**
 * Return the object tool_response's fields when this event is eligible for the
 * lift, or `undefined` when it is not (wrong hook event, outcome already
 * derived upstream, or a non-object tool_response).
 */
function liftableResponseFields(event: HarnessEvent): Record<string, unknown> | undefined {
	if (event.hook_event !== "PostToolUse" && event.hook_event !== "PostToolUseFailure")
		return undefined;
	// Already derived upstream (.mjs hook, or a prior pass) — never second-guess.
	if (event.tool_outcome !== undefined) return undefined;
	const resp = event.tool_response;
	if (resp === null || resp === undefined || typeof resp !== "object" || Array.isArray(resp))
		return undefined;
	// SAFETY: narrowed to a non-null, non-array object; every read below
	// re-checks its own field's type before use.
	return resp as Record<string, unknown>;
}

/** Copy stdout/stderr tails onto the event, never overwriting existing values. */
function applyStreamEvidence(event: HarnessEvent, fields: Record<string, unknown>): void {
	const stdout = tailString(fields.stdout);
	const stderr = tailString(fields.stderr);
	if (stdout !== undefined && event.stdout === undefined) event.stdout = stdout;
	if (stderr !== undefined && event.stderr === undefined) event.stderr = stderr;
}

/** Copy the exit code onto the event (never overwriting) and return the raw value. */
function applyExitCode(event: HarnessEvent, fields: Record<string, unknown>): unknown {
	const codeRaw = fields.exitCode ?? fields.exit_code ?? fields.returncode;
	if (typeof codeRaw === "number" && event.exit_code === undefined) event.exit_code = codeRaw;
	return codeRaw;
}

/** Conservative outcome: `interrupted` beats any failure marker, which beats success. */
function deriveToolOutcomeFromFields(
	event: HarnessEvent,
	fields: Record<string, unknown>,
	codeRaw: unknown,
): "interrupted" | "error" | "success" {
	if (fields.interrupted === true) return "interrupted";
	const failed =
		event.hook_event === "PostToolUseFailure" ||
		fields.is_error === true ||
		(typeof codeRaw === "number" && codeRaw !== 0);
	return failed ? "error" : "success";
}
