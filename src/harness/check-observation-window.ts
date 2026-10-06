import { existsSync, statSync } from "node:fs";
import { scanFileLines } from "../lib/bounded-file-io.js";

export const OBSERVATION_READ_LIMITS = { bytes: 2 * 1024 * 1024, records: 2000, lineBytes: 128 * 1024 };
export interface ObservationWindow {
    lines: string[]; file_bytes: number; scanned_bytes: number; omitted_prefix: boolean;
    omitted_records: number; incomplete_lines: number; oversized_lines: number;
    limits: typeof OBSERVATION_READ_LIMITS;
}
/** The newest bounded byte range, then its newest bounded complete records. */
export function readObservationWindow(path: string, limits = OBSERVATION_READ_LIMITS): ObservationWindow {
    for (const n of Object.values(limits)) if (!Number.isSafeInteger(n) || n < 1) throw new Error("Invalid observation read budget");
    const size = existsSync(path) ? statSync(path).size : 0;
    const start = Math.max(0, size - limits.bytes);
    const out: ObservationWindow = { lines: [], file_bytes: size, scanned_bytes: size - start, omitted_prefix: start > 0,
        omitted_records: 0, incomplete_lines: 0, oversized_lines: 0, limits };
    if (size === 0) return out;
    scanFileLines(path, line => {
        if (start > 0 && line.start === start) { out.omitted_records++; return; }
        if (!line.complete) { out.incomplete_lines++; return; }
        if (line.oversized) { out.oversized_lines++; return; }
        if (!line.nonEmpty || line.text === undefined) return;
        out.lines.push(line.text);
        if (out.lines.length > limits.records) { out.lines.shift(); out.omitted_records++; out.omitted_prefix = true; }
    }, { startOffset: start, endExclusive: size, maxCapturedLineBytes: limits.lineBytes });
    return out;
}
