import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import type { HookCoverageLedger, HookPendingCheck } from "./hook-coverage-ledger.js";
import { isLikelyTestFile } from "./quality-checks/test-classifier.js";
import { withProcessCancellation } from "./check-engine/process-cancellation.js";
import type { BatchCheckScope } from "./quality-checks/change-set-evidence.js";

export interface HookCheckEvidence {
    checks: string[];
    findings: string[];
    unavailable: string[];
    scopes?: BatchCheckScope[];
}
export interface HookCoverageChecker {
    (entries: readonly HookPendingCheck[]): Promise<ReadonlyMap<string, HookCheckEvidence>>;
    /** Recovery can group compatible scopes before imposing its process caps. */
    batches?(entries: readonly HookPendingCheck[]): HookPendingCheck[][];
}
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

export type HookVerificationProgress = Omit<HookVerificationStatus, "unmeasured"> & { unmeasuredCount: number };
export const isHookVerificationProgress = wireObject<HookVerificationProgress>({
    id: wireString, status: wireLiteral("running", "complete"), total: wireNumber,
    processed: wireNumber, checked: wireNumber, findings: wireNumber, unmeasuredCount: wireNumber,
});

interface VerificationOwner {
    ledger: HookCoverageLedger;
    reconcile: () => void;
    ready: () => boolean;
}
// Stay within the ordinary external batch and related-test source caps.
const BATCH_SIZE = 8;
const JOB_BUDGET_MS = 30 * 60 * 1000;

function sourceOrder(entry: HookPendingCheck): number {
    return isLikelyTestFile(basename(entry.path, extname(entry.path)), entry.path) ? 0 : 1;
}

/** One explicit recovery run at a time. Socket calls only start/poll the job;
 * checks yield between files and never hold a hook request open for minutes. */
export class HookCoverageVerification {
    private current: HookVerificationStatus | undefined;
    private stopped = false;
    private readonly cancellation = new AbortController();
    constructor(private readonly owner: VerificationOwner, private readonly checker: HookCoverageChecker) {}

    status(): HookVerificationStatus | undefined {
        return this.current ? structuredClone(this.current) : undefined;
    }

    progress(): HookVerificationProgress | undefined {
        if (!this.current) return undefined;
        const { unmeasured, ...counts } = this.current;
        return { ...counts, unmeasuredCount: unmeasured.length };
    }

    isRunning(): boolean { return !this.stopped && this.current?.status === "running"; }

    start(): void {
        if (this.stopped || this.current?.status === "running") return;
        this.owner.reconcile();
        // Related-test batches operate on source files. Group test files first
        // so a source's deferred related suite does not hold unrelated tests.
        const entries = this.owner.ledger.observation().pending.sort((a, b) => sourceOrder(a) - sourceOrder(b));
        const job: HookVerificationStatus = { id: randomUUID(), status: "running", total: entries.length, processed: 0, checked: 0, findings: 0, unmeasured: [] };
        this.current = job;
        void this.run(entries, job).catch(error => {
            job.unmeasured.push(`Verification failed: ${String(error)}`);
            job.status = "complete";
        });
    }

    stop(): void { this.stopped = true; this.cancellation.abort(); }

    private async run(entries: HookPendingCheck[], job: HookVerificationStatus): Promise<void> {
        const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(JOB_BUDGET_MS)]);
        const batches = this.checker.batches?.(entries) ?? Array.from(
            { length: Math.ceil(entries.length / BATCH_SIZE) },
            (_, index) => entries.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
        );
        for (const batch of batches) {
            // A resolved checker promise only yields to microtasks. Let socket
            // requests and shutdown timers run even when every batch defers.
            await setImmediate();
            if (signal.aborted) { job.unmeasured.push("Recovery cancelled or its 30-minute job budget exhausted; unchecked versions remain pending"); break; }
            await withProcessCancellation(signal, () => this.checkBatch(batch, job));
            job.processed += batch.length;
        }
        job.status = "complete";
    }

    private async checkBatch(entries: HookPendingCheck[], job: HookVerificationStatus): Promise<void> {
        this.owner.reconcile();
        if (!this.owner.ready()) throw new Error("Filesystem observations unavailable");
        const policyDigest = this.owner.ledger.policyDigest();
        const policyGeneration = this.owner.ledger.summary().policyGeneration;
        const currentIds = new Set(this.owner.ledger.observation().pending.map(entry => entry.id));
        const current = entries.filter(entry => currentIds.has(entry.id));
        const evidence = await this.checker(current);
        this.owner.reconcile();
        if (this.stopped || !this.owner.ready()) throw new Error("Filesystem observations unavailable after checks");
        for (const entry of entries) this.record(entry, evidence.get(entry.id), { policyDigest, policyGeneration }, job);
    }

    private record(entry: HookPendingCheck, evidence: HookCheckEvidence | undefined, policy: { policyDigest: string; policyGeneration: number }, job: HookVerificationStatus): void {
        if (!evidence) { job.unmeasured.push(`${entry.path}: version changed or no check evidence`); return; }
        if (evidence.unavailable.length) {
            job.unmeasured.push(...evidence.unavailable.map(reason => `${entry.path}: ${reason}`));
            if (!evidence.checks.length) return;
        }
        const recorded = this.owner.ledger.recordCheck({ ...entry, ...policy, checks: evidence.checks,
            findings: evidence.findings, unavailable: evidence.unavailable,
            ...(evidence.scopes ? { scopes: evidence.scopes } : {}),
            checkedAt: new Date().toISOString(), kind: "automated_check" });
        if (!recorded) { job.unmeasured.push(`${entry.path}: file/policy changed or no completed checks`); return; }
        if (!evidence.unavailable.length) job.checked++;
        job.findings += evidence.findings.length;
    }
}
