import type { RunProcessResult } from "../spawn-async.js";

export function incompleteProcessReason(result: RunProcessResult): string | undefined {
	if (result.timedOut) return "deadline expired";
	if (result.stdoutTruncated || result.stderrTruncated) {
		const streams = [result.stdoutTruncated && "stdout", result.stderrTruncated && "stderr"].filter(Boolean);
		return `captured ${streams.join(" and ")} was truncated`;
	}
	if (result.killed) return "process was interrupted";
	if (result.code === null) return "process ended without an exit status";
	return undefined;
}

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
