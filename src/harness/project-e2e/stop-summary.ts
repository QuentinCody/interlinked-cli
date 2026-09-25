// ===========================================
// Bounded Stop summary for project e2e obligations (Unit F6, plan §12, PE-39)
// ===========================================
// The Stop reminder is warn-only and must not nag: an unchanged set of open
// obligations is reminded MAX_STOP_REMINDERS times per session, then paused
// with one note until the set (keys, generations, statuses) changes. An
// obligation that cannot be cleared in this environment is a truthful
// handoff, never a "run it again" instruction; a quarantined required
// scenario stays visible with its repair path.

import type { ScenarioVerdict } from "./qualify.js";

export const MAX_STOP_REMINDERS = 3;
const MAX_STOP_SCENARIOS = 5;

/** Per-session reminder counts, daemon-lifetime (a restart starts the bound over — acceptable, it is a nudge). */
export class StopReminderMemory {
    private readonly rows = new Map<string, { signature: string; count: number }>();
    /** Increments and returns the count for this signature; a different signature restarts at 1. */
    observe(sessionId: string, signature: string): number {
        const previous = this.rows.get(sessionId);
        const count = previous?.signature === signature ? previous.count + 1 : 1;
        this.rows.set(sessionId, { signature, count });
        return count;
    }
    clear(sessionId: string): void { this.rows.delete(sessionId); }
    count(sessionId: string): number { return this.rows.get(sessionId)?.count ?? 0; }
}
function shownStatus(row: ScenarioVerdict): string {
    return row.dimensions.stability === "quarantined" ? "quarantined" : row.status;
}
function signatureOf(open: ScenarioVerdict[]): string {
    return open.map(row => `${row.key}@${row.generation}:${shownStatus(row)}`).sort().join("|");
}
function listing(open: ScenarioVerdict[]): string {
    const shown = open.slice(0, MAX_STOP_SCENARIOS).map(row => `${row.key} (${shownStatus(row)})`).join(", ");
    const more = open.length > MAX_STOP_SCENARIOS ? `, +${open.length - MAX_STOP_SCENARIOS} more` : "";
    return `${open.length} required scenario(s) unresolved: ${shown}${more}`;
}
/** The next action: a handoff when nothing here can clear it, the qualify path for a quarantine, else the run. */
function nextAction(open: ScenarioVerdict[]): string {
    const first = open[0]!;
    if (open.every(row => row.status === "unavailable")) {
        const reason = first.reasons[0]?.message ?? "no reason recorded";
        return `unavailable here (${reason}); no supervised run in this environment can clear it — hand off to an environment that can, and do not retry in a loop. Inspect: interlinked tests e2e status.`;
    }
    if (shownStatus(first) === "quarantined") return `quarantined: repair the scenario (a new generation), then interlinked tests e2e qualify --project ${first.projectId} --scenario ${first.scenarioId}.`;
    return `Run: interlinked tests e2e run --project ${first.projectId} --scenario ${first.scenarioId}; inspect: interlinked tests e2e status. Unresolved work stays visible to check/commit gates.`;
}
/** One bounded line for the open REQUIRED, non-silenced verdicts, or null. */
export function stopSummary(open: ScenarioVerdict[], memory: StopReminderMemory, sessionId: string): string | null {
    if (!open.length) { memory.clear(sessionId); return null; }
    const count = memory.observe(sessionId, signatureOf(open));
    if (count > MAX_STOP_REMINDERS + 1) return null;
    if (count === MAX_STOP_REMINDERS + 1) return `[interlinked:e2e] ${open.length} required scenario(s) still unresolved and unchanged since reminder ${MAX_STOP_REMINDERS}; reminders paused until the obligation changes. Inspect: interlinked tests e2e status.`;
    return `[interlinked:e2e] ${listing(open)}. ${nextAction(open)}`;
}
