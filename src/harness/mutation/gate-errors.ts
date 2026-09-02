// ===========================================
// Per-edit mutation — runner error classification (extracted from gate.ts)
// ===========================================
// Everything the gate needs in order to say WHY a run produced no verdict:
// pending-handle recovery, busy / not-measurable classification, and the
// human-readable reason string. Kept structural and free of gate.ts's
// orchestration types so it never cycles back into its caller (the same
// discipline gate-decision.ts follows).

/** The minimum a caller needs to come back for an unfinished run. */
export interface PendingHandle {
	jobId: string;
	runnerUrl: string;
}

/**
 * Pull the still-running job handles out of whatever a runner threw.
 *
 * Both shapes matter: a single runner rejects with `MutationRunPendingError`
 * directly, while a wrapper that aggregates several rejections carries them in
 * a `pending` array. Anything else is a real failure with nothing to claim.
 * Structural checks, not `instanceof`, so this stays free of an import cycle
 * with the runners that depend on this module's types.
 */
export function pendingHandlesFrom(err: unknown): PendingHandle[] {
	const isHandle = (v: unknown): v is PendingHandle =>
		typeof v === "object" &&
		v !== null &&
		// SAFETY: object-ness is established above; these two reads are the
		// predicate's actual test, and `typeof` on a missing key is "undefined",
		// so a non-handle fails rather than throwing.
		typeof (v as PendingHandle).jobId === "string" &&
		typeof (v as PendingHandle).runnerUrl === "string";

	if (isHandle(err)) return [err];
	const nested = errRecord(err)?.pending;
	if (Array.isArray(nested)) return nested.filter(isHandle);
	return [];
}

/**
 * Narrow an `unknown` thrown value to a plain object, or `undefined` if it
 * isn't one — `err` genuinely can be `null`/a primitive/anything at runtime
 * (it comes from a `catch`), so every field read below goes through this
 * instead of an `as {..}` cast that would silently assert non-nullish-ness
 * the type checker can't actually verify.
 */
function errRecord(err: unknown): Record<string, unknown> | undefined {
	return typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
}

/**
 * Why the run produced no verdict.
 *
 * Three outcomes that used to read identically as "the mutation runner failed",
 * which is the least useful of them and was wrong most of the time:
 *   - still working  -> results ARE coming, in the PostToolUse window
 *   - not measurable -> the runner succeeded; there is nothing to measure
 *                       (usually: no test exercises this file)
 *   - failed         -> actually broken
 */
export function notMeasuredReason(err: unknown, pendingCount: number): string {
	if (pendingCount > 0) return "mutation still running past the budget";
	if (isRunnerBusy(err)) {
		return "the mutation runner is busy with another job right now — not measured this edit, and NOT evidence this file has no tests (retry on the next edit)";
	}
	const reason = notMeasurableReasonOf(err);
	if (reason === "no_tests") {
		return "no test exercises this file, so mutation cannot measure it — add one and the gate starts protecting this code";
	}
	if (reason !== null) return `mutation not measurable here (${reason})`;
	return describeRunnerFailure(err);
}

/**
 * Quote the runner's own words.
 *
 * "the mutation runner failed" was the terminal string for every unclassified
 * error, and it was the DOMINANT live outcome — 12 occurrences in the last 4000
 * activity records, against zero measured verdicts. It names the component and
 * withholds the cause, which is the one combination nobody can act on: the
 * reader cannot separate a dead endpoint from a failed clone from a crashed
 * engine, so re-running is the only move left. The client now carries the
 * response body up (`describeErrorResponse`), so there is finally something to
 * say.
 */
function describeRunnerFailure(err: unknown): string {
	const message = errRecord(err)?.message;
	if (typeof message !== "string" || message.trim() === "") return "the mutation runner failed";
	return `the mutation runner failed — ${message.trim()}`;
}

/**
 * A contended runner is not a broken one, and it is definitely not a
 * "no tests" verdict — collapsing "busy" into either is the exact
 * measurement-integrity defect this check exists to prevent (a contended
 * runner silently drops the file out of the denominator). Detected
 * structurally — by error name (a runner that throws the dedicated
 * `MutationRunnerBusyError`) or by message (the generic HTTP-status error a
 * plain non-ok response produces) — rather than `instanceof`, so this module
 * stays free of an import cycle with the runners it evaluates.
 */
function isRunnerBusy(err: unknown): boolean {
	const name = errRecord(err)?.name;
	if (name === "MutationRunnerBusyError") return true;
	const message = errRecord(err)?.message;
	return typeof message === "string" && /\bHTTP 503\b/.test(message);
}

/** Structural read, so this module stays free of an import cycle with the runners. */
function notMeasurableReasonOf(err: unknown): string | null {
	const name = errRecord(err)?.name;
	if (name !== "MutationNotMeasurableError") return null;
	const reason = errRecord(err)?.reason;
	return typeof reason === "string" && reason !== "" ? reason : "unspecified";
}
