import { realpathSync } from "node:fs";
import { explainVerificationTrace, latestPushTrace, renderVerificationTrace, type TraceRow } from "../harness/verification-trace.js";
import { verificationStagesPath } from "../harness/verification-stages.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { scanJsonlTail, type TailScanStats } from "./query/reverse-reader.js";

/** Bounded tail read: the newest rows of the ledger, which is where the push being explained lives. */
const SCAN_BUDGET = { maxRecords: 50_000, maxBytes: 64 * 1024 * 1024 };
const TRACE_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

interface TraceOptions { cwd?: string; trace?: string; json?: boolean; short?: boolean; full?: boolean; }

function isTraceRow(record: Record<string, unknown>): record is Record<string, unknown> & TraceRow {
    return typeof record.ts === "string" && typeof record.check === "string" && typeof record.status === "string" && typeof record.stage === "string";
}

/** Read the ledger's newest rows; when a trace is named, only its rows are kept. */
function readRows(path: string, trace: string | undefined): { rows: TraceRow[]; scan: TailScanStats } {
    const rows: TraceRow[] = [];
    const scan = scanJsonlTail(path, SCAN_BUDGET, record => {
        if (isTraceRow(record) && (trace === undefined || record.trace === trace)) rows.push(record);
        return true;
    });
    return { rows, scan };
}

/**
 * `interlinked tests trace [--trace <id>]`: explain one verification request (a push by default) from the stage
 * ledger — owners, phases, the wall-clock wait, the handoff fallback cause and every check that ran fresh or
 * produced no verdict. Exit 2 when the ledger holds no such trace.
 */
export function testsTraceCommand(options: TraceOptions): void {
    const mode = getOutputMode(options);
    try {
        if (options.trace !== undefined && !TRACE_SHAPE.test(options.trace)) { outputError(mode, "--trace must be 8–64 letters, digits or dashes"); process.exitCode = 2; return; }
        const root = realpathSync(options.cwd ?? process.cwd());
        const { rows, scan } = readRows(verificationStagesPath(root), options.trace);
        const trace = options.trace ?? latestPushTrace(rows);
        if (!trace) { outputError(mode, `no traced push in ${verificationStagesPath(root)} (${scan.recordsParsed} row(s) scanned${scan.truncated ? ", scan truncated" : ""})`); process.exitCode = 2; return; }
        const summary = explainVerificationTrace(rows, trace);
        if (summary.rows === 0) { outputError(mode, `no rows for trace ${trace} (${scan.recordsParsed} row(s) scanned${scan.truncated ? ", scan truncated" : ""})`); process.exitCode = 2; return; }
        const note = scan.truncated ? `scan truncated after ${scan.recordsParsed} row(s); older rows of this trace may be missing` : null;
        output(mode, { ...summary, scan, note }, { normal: () => `${renderVerificationTrace(summary)}${note ? `\n  note: ${note}` : ""}` });
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "verification trace unavailable"); process.exitCode = 2; }
}
