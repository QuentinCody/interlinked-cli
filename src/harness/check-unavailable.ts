import { appendCheckResults } from "./check-results-sink.js";
import type { HarnessEvent } from "./types.js";

/** Instrumentation failure is execution evidence, never a source violation. */
export function recordUnavailableCheck(args: {
    cwd: string;
    event: HarnessEvent;
    check: string;
    error: unknown;
}): void {
    const reason = (args.error instanceof Error ? args.error.message : String(args.error)).slice(0, 500);
    appendCheckResults(args.cwd, args.event, {
        decision: "allow",
        checks_skipped: [{ check: args.check, category: "error", reason }],
    });
}
