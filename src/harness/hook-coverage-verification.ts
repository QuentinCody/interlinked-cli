import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import type { HookCoverageLedger, HookPendingCheck } from "./hook-coverage-ledger.js";
import type { HookCheckReceipt } from "./hook-coverage-evidence.js";
import { isLikelyTestFile } from "./quality-checks/test-classifier.js";
import { withProcessCancellation } from "./check-engine/process-cancellation.js";
import type { BatchCheckScope } from "./quality-checks/change-set-evidence.js";
import type { HookVerificationCheckpoint, HookVerificationStatus } from "./hook-coverage-job.js";
export { isHookVerificationStatus, type HookVerificationStatus } from "./hook-coverage-job.js";

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
    /** One job-owned test scope, shared across its receipt batches. */
    prepare?(entries: readonly HookPendingCheck[], deadlineAt: number): void;
}
export type HookVerificationProgress = Omit<HookVerificationStatus, "unmeasured"> & { unmeasuredCount: number };
export const isHookVerificationProgress = wireObject<HookVerificationProgress>({
    id: wireString, status: wireLiteral("running", "complete"), total: wireNumber,
    processed: wireNumber, checked: wireNumber, findings: wireNumber, unmeasuredCount: wireNumber,
});

interface VerificationOwner {
    ledger: HookCoverageLedger;
    reconcile: () => void;
    ready: () => boolean;
    unavailableReason?: () => string;
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
    private checkpoint: HookVerificationCheckpoint | undefined;
    private stopped = false;
    private readonly cancellation = new AbortController();
    constructor(private readonly owner: VerificationOwner, private readonly checker: HookCoverageChecker) {
        const checkpoint = owner.ledger.recovery();
        if (checkpoint) {
            this.checkpoint = checkpoint;
            this.current = checkpoint.job;
            if (checkpoint.job.status === "running") this.launch(checkpoint);
        }
    }

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
        const batches = this.checker.batches?.(entries) ?? Array.from(
            { length: Math.ceil(entries.length / BATCH_SIZE) },
            (_, index) => entries.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
        );
        const checkpoint: HookVerificationCheckpoint = { schema: 1, job, batches, nextBatch: 0, deadlineAt: Date.now() + JOB_BUDGET_MS };
        this.persist(checkpoint);
        this.launch(checkpoint);
    }

    stop(): void {
        this.stopped = true;
        this.cancellation.abort();
        // The durable job remains resumable. This process must never publish late results.
        if (this.current?.status === "running") this.current = { ...this.current, status: "complete",
            unmeasured: [...this.current.unmeasured, "Daemon stopped; the successor will resume the durable verification job"] };
    }

    private persist(checkpoint: HookVerificationCheckpoint): void {
        this.owner.ledger.saveRecovery(checkpoint);
        this.checkpoint = checkpoint;
        this.current = checkpoint.job;
    }

    private launch(checkpoint: HookVerificationCheckpoint): void {
        void this.run(checkpoint).catch(error => {
            if (this.stopped) return;
            const saved = this.checkpoint ?? checkpoint;
            const job: HookVerificationStatus = { ...saved.job, status: "complete", unmeasured: [...saved.job.unmeasured, `Verification failed: ${String(error)}`] };
            try { this.persist({ ...saved, job }); }
            catch (failure) {
                this.current = { ...job, unmeasured: [...job.unmeasured, `Verification checkpoint could not be saved: ${String(failure)}`] };
            }
        });
    }

    private async run(checkpoint: HookVerificationCheckpoint): Promise<void> {
        const remaining = Math.max(1, checkpoint.deadlineAt - Date.now());
        const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(remaining)]);
        let prepared = false;
        while (checkpoint.nextBatch < checkpoint.batches.length) {
            // A resolved checker promise only yields to microtasks. Let socket
            // requests and shutdown timers run even when every batch defers.
            await setImmediate();
            if (this.stopped) return;
            if (signal.aborted || Date.now() >= checkpoint.deadlineAt) throw new Error("Recovery's original 30-minute job budget exhausted; unchecked versions remain pending");
            if (!prepared) {
                this.checker.prepare?.(checkpoint.batches.slice(checkpoint.nextBatch).flat(), checkpoint.deadlineAt);
                prepared = true;
            }
            checkpoint = await withProcessCancellation(signal, () => this.checkBatch(checkpoint));
            this.checkpoint = checkpoint;
            this.current = checkpoint.job;
        }
        if (!this.stopped && checkpoint.job.status !== "complete") this.persist({ ...checkpoint, job: { ...checkpoint.job, status: "complete" } });
    }

    private async checkBatch(checkpoint: HookVerificationCheckpoint): Promise<HookVerificationCheckpoint> {
        const entries = checkpoint.batches[checkpoint.nextBatch]!;
        this.owner.reconcile();
        if (!this.owner.ready()) throw this.observationError("before checks");
        const policyDigest = this.owner.ledger.policyDigest();
        const policyGeneration = this.owner.ledger.summary().policyGeneration;
        const currentIds = new Set(this.owner.ledger.observation().pending.map(entry => entry.id));
        const current = entries.filter(entry => currentIds.has(entry.id));
        const evidence = await this.checker(current);
        this.owner.reconcile();
        if (this.stopped || !this.owner.ready()) throw this.observationError("after checks");
        const job = structuredClone(checkpoint.job);
        const receipts = entries.flatMap(entry => {
            const receipt = this.receipt(entry, evidence.get(entry.id), { policyDigest, policyGeneration }, job);
            return receipt ? [receipt] : [];
        });
        const next = { ...checkpoint, nextBatch: checkpoint.nextBatch + 1, job };
        job.processed += entries.length;
        if (next.nextBatch === next.batches.length) job.status = "complete";
        this.owner.ledger.recordChecks(receipts, recorded => {
            for (const [index, receipt] of receipts.entries()) {
                if (!recorded[index]) { job.unmeasured.push(`${receipt.path}: file/policy changed or no completed checks`); continue; }
                if (!receipt.unavailable?.length) job.checked++;
                job.findings += receipt.findings.length;
            }
            return next;
        });
        return next;
    }

    private observationError(phase: string): Error {
        const reason = this.owner.unavailableReason?.();
        return new Error(`Filesystem observations unavailable ${phase}${reason ? `: ${reason}` : ""}`);
    }

    private receipt(entry: HookPendingCheck, evidence: HookCheckEvidence | undefined, policy: { policyDigest: string; policyGeneration: number }, job: HookVerificationStatus): HookCheckReceipt | undefined {
        if (!evidence) { job.unmeasured.push(`${entry.path}: version changed or no check evidence`); return; }
        if (evidence.unavailable.length) {
            job.unmeasured.push(...evidence.unavailable.map(reason => `${entry.path}: ${reason}`));
            if (!evidence.checks.length) return;
        }
        return { ...entry, ...policy, checks: evidence.checks,
            findings: evidence.findings, unavailable: evidence.unavailable,
            ...(evidence.scopes ? { scopes: evidence.scopes } : {}),
            checkedAt: new Date().toISOString(), kind: "automated_check" };
    }
}
