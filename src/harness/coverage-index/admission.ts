import { currentProcessSignal } from "../check-engine/process-cancellation.js";
import { acquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { readResourceBudget, type ResourceBudget } from "../resource-budget.js";
import { acquireTestCapacity } from "../test-capacity.js";

/**
 * Host admission for an indexed coverage run: the SAME managed path the test scheduler takes before it spawns a
 * runner — the project's heavy-process lease, then the foreground host slot, then a memory budget the capture's
 * child tree is supervised against. A worker cap is a size, not an admission: without this, two index runs (or an
 * index run beside a scheduled test run) shared one host unsupervised (review 2026-09-30). `release` gives both
 * leases back; the budget outlives nothing.
 */
export type IndexedRunAdmission =
    | { admitted: true; resourceBudget: ResourceBudget; release: () => void; wait_ms: number }
    | { admitted: false; reason: string; wait_ms: number };

export async function admitIndexedRun(root: string, deadline: number): Promise<IndexedRunAdmission> {
    const signal = currentProcessSignal() ?? new AbortController().signal;
    const started = Date.now();
    const waited = (): number => Date.now() - started;
    const project = await acquireProjectHeavyProcessLease(root, deadline, signal);
    if (!project) return { admitted: false, reason: "Project check capacity busy; coverage index unavailable", wait_ms: waited() };
    let capacity: Awaited<ReturnType<typeof acquireTestCapacity>> = null;
    try { capacity = await acquireTestCapacity("foreground", deadline, signal); }
    finally { if (!capacity) project(); }
    if (!capacity) return { admitted: false, reason: "Host test capacity busy; coverage index unavailable", wait_ms: waited() };
    const held = capacity;
    const release = (): void => { held.release(); project(); };
    const resourceBudget = readResourceBudget();
    if (!resourceBudget) {
        release();
        return { admitted: false, reason: "Host memory reserve unavailable; coverage index unavailable", wait_ms: waited() };
    }
    return { admitted: true, resourceBudget, release, wait_ms: waited() };
}
