// Test helper (H5, 2026-10-02): a nested run that got no host capacity produced NO verdict about the code under test.
// Under a loaded full-suite run the capacity governor defers nested work ("Host CPU or memory capacity unavailable"),
// and the suites that drive real nested runs then FAILED — nine false failures in one 2026-10-02 run, every one of
// them a refusal, none a defect. Such a case reports NOT RUN (a skip with the reason), never a failure. Only the
// harness's own capacity refusals count; any other failure text still fails the case.
import { testWorkerBudget } from "../harness/test-execution.js";

const NO_CAPACITY = /Host CPU or memory capacity unavailable|Host test capacity busy|Host memory reserve unavailable|NOT RUN \((?:test scheduler produced no verdict|host capacity or memory unavailable)/;

/** The capacity refusal named in `output`, or null when the output carries a verdict (pass or real failure). */
export function noCapacityReason(output: string): string | null {
    return NO_CAPACITY.exec(output)?.[0] ?? null;
}

interface SkippableContext { skip: (note?: string) => void; }

/** Skip the running case as NOT RUN when a nested run's output shows it got no host capacity. */
export function skipWithoutCapacity(context: SkippableContext, output: string): void {
    const reason = noCapacityReason(output);
    if (reason) context.skip(`NOT RUN: the nested run got no host capacity (${reason})`);
}

/** Skip the running case as NOT RUN before it starts when the host governor would refuse a nested test worker. */
export function requireTestWorker(context: SkippableContext): void {
    if (testWorkerBudget(1) < 1) context.skip("NOT RUN: the host governor would refuse a nested test worker (Host CPU or memory capacity unavailable)");
}
