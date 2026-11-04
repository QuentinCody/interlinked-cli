import type { HookPendingCheck } from "./hook-coverage-ledger.js";
import type { HookVerificationCheckpoint } from "./hook-coverage-job.js";

export interface RemainingVersion { id: string; path: string; identity: string; reasons: string[]; }

/** Reasons belong to the planned version, never a newer file at the same path. */
export function remainingCoverageVersions(pending: readonly HookPendingCheck[], checkpoint: HookVerificationCheckpoint | undefined, blocked: readonly string[] = []): RemainingVersion[] {
    const planned = new Set(checkpoint?.batches.flat().map(entry => entry.id) ?? []);
    const plannedPaths = new Set(checkpoint?.batches.flat().map(entry => entry.path) ?? []);
    const byPath = new Map<string, Set<string>>();
    const global: string[] = [];
    for (const text of checkpoint?.job.unmeasured ?? []) {
        const split = text.indexOf(": ");
        const path = text.slice(0, split);
        if (split < 0 || !plannedPaths.has(path)) { global.push(text); continue; }
        const reasons = byPath.get(path) ?? new Set<string>();
        // Keep the actual reason, omit duplicated subprocess stack traces in this index.
        reasons.add(text.slice(split + 2).split("\n").slice(0, 2).join(" "));
        byPath.set(path, reasons);
    }
    const rows = pending.map(entry => ({ id: entry.id, path: entry.path, identity: entry.identity,
        reasons: !checkpoint ? ["No recovery job has examined this version"]
            : !planned.has(entry.id) ? ["This version was observed after the recovery plan; it needs a fresh check"]
            : byPath.has(entry.path) ? [...byPath.get(entry.path)!]
            : global.length ? global
            : [checkpoint.job.status === "running" ? "Recovery still running; no completed evidence for this version yet"
                : "Recovery completed without complete check evidence for this exact version"] }));
    return blocked.length ? rows.map(row => ({ ...row, reasons: [...new Set(blocked)].map(reason => `Current observation unavailable: ${reason}`)
        .concat(row.reasons.map(reason => `Previous recovery evidence: ${reason}`)) })) : rows;
}
