import { parseWire, wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import type { HookPendingCheck } from "./hook-coverage-ledger.js";

export interface HookVerificationStatus {
    id: string;
    status: "running" | "complete";
    total: number;
    processed: number;
    checked: number;
    findings: number;
    unmeasured: string[];
}
export const isHookVerificationStatus = wireObject<HookVerificationStatus>({
    id: wireString, status: wireLiteral("running", "complete"), total: wireNumber,
    processed: wireNumber, checked: wireNumber, findings: wireNumber, unmeasured: wireArray(wireString),
});

/** One plan and deadline across daemon processes; committed with its batch receipts. */
export interface HookVerificationCheckpoint {
    schema: 1;
    job: HookVerificationStatus;
    batches: HookPendingCheck[][];
    nextBatch: number;
    deadlineAt: number;
}
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCheckpoint = wireObject<HookVerificationCheckpoint>({
    schema: wireLiteral(1), job: isHookVerificationStatus, nextBatch: natural, deadlineAt: natural,
    batches: wireArray(wireArray(wireObject<HookPendingCheck>({ id: wireString, path: wireString, identity: wireString,
        scope: wireLiteral("policy", "reservation"), writer: wireLiteral("unknown") }))),
});

export function parseHookVerificationCheckpoint(value: unknown): HookVerificationCheckpoint {
    const checkpoint = parseWire(value, isCheckpoint, "hook verification checkpoint");
    const { job, batches, nextBatch } = checkpoint;
    const entries = batches.flat();
    const processed = batches.slice(0, nextBatch).reduce((count, batch) => count + batch.length, 0);
    if (!job.id || ![job.total, job.processed, job.checked, job.findings].every(natural)
        || nextBatch > batches.length || job.total !== entries.length || job.processed !== processed
        || job.checked > job.processed || new Set(entries.map(entry => entry.id)).size !== entries.length) {
        throw new Error("Invalid hook verification checkpoint progress");
    }
    return checkpoint;
}
