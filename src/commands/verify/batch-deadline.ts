// ===========================================
// Run a verify phase until the soft deadline
// ===========================================
// External tools wait on child processes, so the cooperative file-loop check cannot stop them. This wrapper gives the
// phase an abort signal that fires at the soft deadline. When the deadline (not the owning command) aborts the phase,
// the run is marked partial and the caller gets a fallback value, so verify still prints the JSON it has.

import { currentProcessSignal, withProcessCancellation } from "../../harness/check-engine/process-cancellation.js";
import type { CheckReport } from "../../harness/check-engine/types.js";
import { markVerifyPartial, verifyDeadlineRemainingMs } from "./check-timing.js";

/** A tool report with no results and one timeout skip entry that names why. */
export function emptyToolReport(check: string, reason: string): CheckReport {
	return {
		results: [],
		toolsRun: [],
		toolsSkipped: [],
		skipped: [{ check, reason, category: "timeout" }],
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}

/** Run `work`; if the soft deadline aborts it, mark the run partial and return `fallback()` instead. */
export async function runUntilSoftDeadline<T>(phase: string, work: () => Promise<T>, fallback: () => T): Promise<T> {
	const remaining = verifyDeadlineRemainingMs();
	if (remaining === null) return work();
	if (remaining <= 0) {
		markVerifyPartial(phase, "soft deadline reached before this phase started");
		return fallback();
	}
	const owner = currentProcessSignal();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("soft deadline")), remaining);
	const signal = owner ? AbortSignal.any([owner, deadline.signal]) : deadline.signal;
	try {
		return await withProcessCancellation(signal, work);
	} catch (error) {
		if (owner?.aborted || !deadline.signal.aborted) throw error;
		markVerifyPartial(phase, "soft deadline reached while this phase was running");
		return fallback();
	} finally {
		clearTimeout(timer);
	}
}
