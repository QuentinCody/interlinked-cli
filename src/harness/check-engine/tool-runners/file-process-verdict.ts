import type { RunProcessResult } from "../spawn-async.js";

/** A missing, incomplete or unparsed failing process is not a clean check.
 * Throwing lets the async engine retain an explicit no-verdict skip. */
export function requireFileProcessVerdict(tool: string, result: RunProcessResult, findingCount: number): void {
    if (result.timedOut || result.killed || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error(`${tool}: incomplete process execution or output; no check verdict`);
    }
    if (result.code !== 0 && result.code !== 1) {
        throw new Error(`${tool}: process exited ${result.code ?? "without status"}; no check verdict`);
    }
    if (result.code === 1 && findingCount === 0) {
        throw new Error(`${tool}: nonzero exit with no diagnostics parsed; no check verdict`);
    }
}
