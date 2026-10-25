import { realpathSync } from "node:fs";
import { callCoverage, type SessionCallCoverage } from "../harness/call-coverage.js";
import { parseDuration } from "../lib/activity-utils.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const TOP = 3;

function ranked(counts: Record<string, number>, noun: string): string {
    const rows = Object.entries(counts).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
    const shown = rows.slice(0, TOP).map(([key, n]) => `${key} ${n}`);
    return rows.length > TOP ? `${shown.join(", ")}, +${rows.length - TOP} more ${noun}(s)` : shown.join(", ");
}

/** Totals, then every session with unjudged calls (most first): tools, working folders and time span. */
export function renderCallCoverage(rows: readonly SessionCallCoverage[], since: string): string {
    const head = `tool calls the daemon judged since ${since}`;
    if (!rows.length) return `${head}: no tool calls in the timeline for this window (no evidence)`;
    const calls = rows.reduce((sum, row) => sum + row.calls, 0), judged = rows.reduce((sum, row) => sum + row.judged, 0);
    const holed = rows.filter(row => row.judged < row.calls).sort((a, b) => (b.calls - b.judged) - (a.calls - a.judged));
    const lines = [`${head}: ${judged} of ${calls} (${((100 * judged) / calls).toFixed(1)}%) in ${rows.length} session(s); ${rows.length - holed.length} session(s) fully judged`];
    for (const row of holed) {
        lines.push(`  ${row.session.slice(0, 8)} ${row.provider}: ${row.judged} of ${row.calls} judged, ${row.calls - row.judged} not — ${ranked(row.byTool, "tool")}`);
        lines.push(`    ran from: ${ranked(row.byFolder, "folder")}`);
        lines.push(`    between ${row.firstUnjudged ?? "?"} and ${row.lastUnjudged ?? "?"}`);
    }
    return lines.join("\n");
}

/** 0 = reported; 1 = --strict and some call went unjudged; 2 = no calls in the window (no evidence). */
export function callCoverageExitCode(rows: readonly SessionCallCoverage[], strict: boolean): number {
    if (!rows.length) return 2;
    return strict && rows.some(row => row.judged < row.calls) ? 1 : 0;
}

export async function harnessCallsCommand(options: { cwd?: string; since?: string; session?: string; strict?: boolean; json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        const since = new Date(Date.now() - parseDuration(options.since ?? "7d")).toISOString();
        const rows = await callCoverage({ root, since, ...(options.session ? { session: options.session } : {}) });
        output(mode, { since, sessions: rows }, { normal: () => renderCallCoverage(rows, since) });
        process.exitCode = callCoverageExitCode(rows, options.strict === true);
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "call coverage unavailable"); process.exitCode = 2; }
}
