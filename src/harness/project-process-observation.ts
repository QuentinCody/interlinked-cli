import type { ResourceBudget } from "./resource-budget.js";

/** Process facts only; the caller still owns the check's verdict and ledger row. */
export interface ProjectProcessObservation {
    waitMs: number;
    execMs: number;
    resourceBudget?: ResourceBudget;
    heapLimitMb?: number;
    peakRssBytes?: number;
    resourceReason?: string;
}

export type ProjectProcessObserver = (observation: ProjectProcessObservation) => void;

/** Optional telemetry cannot change execution or turn a check into a failure. */
export function observeProjectProcess(observer: ProjectProcessObserver | undefined, observation: ProjectProcessObservation): void {
    try { observer?.(observation); }
    catch { /* Telemetry is fail-open because the process outcome remains authoritative; an observer error cannot change the verdict. */ }
}
