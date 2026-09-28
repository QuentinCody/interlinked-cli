import { appendFileSync, mkdirSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";

/**
 * Stage-timing ledger: one row per verification check per stage, answering
 * "where did the time go and why could this result not be reused".
 *
 * Writers: the test executor (`test-execution.ts`), the test scheduler
 * (`test-scheduler.ts`), the resource-bounded command runner
 * (`resource-command.ts`), `scripts/e2e-run.mjs` (through
 * `scripts/e2e-stage-ledger.mjs`, the script-side mirror of this module) and
 * the pre-push hook, which sets `INTERLINKED_STAGE=push` and points
 * `INTERLINKED_STAGES_LEDGER` at the source checkout so rows written inside a
 * disposable export survive it. Read with `interlinked query stages`.
 *
 * Telemetry only: every write is fail-open, and a dry run never writes.
 */
export const VERIFICATION_STAGES_FILE = "verification-stages.jsonl";
export const VERIFICATION_STAGES_SCHEMA = "verification-stages.v1";
export const STAGE_ENV = "INTERLINKED_STAGE";
export const STAGES_LEDGER_ENV = "INTERLINKED_STAGES_LEDGER";

const VERIFICATION_STAGES = ["edit", "commit", "push", "ci", "cli"] as const;
export type VerificationStage = (typeof VERIFICATION_STAGES)[number];

/** Why a check ran (or did not run) instead of consuming an existing result. */
export type ReuseDeniedReason =
    | "no-receipt"
    | `plan-not-reusable:${string}`
    | "stale-inputs"
    | "budget-exceeded"
    | "capacity-timeout"
    | "memory-budget-unavailable"
    | "worker-budget-unavailable"
    | "interrupted"
    | "empty-selection";

export interface VerificationStageInput {
    stage: VerificationStage;
    /** Stable check label, e.g. `vitest:selected`, `npm run typecheck:stable`, `e2e-merge`. */
    check: string;
    /** Content identity of the check (receipt key) when one exists; null until Unit 5 widens it. */
    identity: string | null;
    status: string;
    reused: boolean;
    reuse_denied_reason?: ReuseDeniedReason;
    queue_ms?: number;
    wait_capacity_ms?: number;
    /** Runtime snapshot + hash work that decides whether any result can be reused (paid on hits, misses and early stale returns alike). */
    validate_ms?: number;
    lookup_ms?: number;
    exec_ms?: number;
    post_ms?: number;
    run_id?: string;
    session?: string;
}

export interface VerificationStageRow extends VerificationStageInput {
    schema: typeof VERIFICATION_STAGES_SCHEMA;
    ts: string;
    platform: string;
    node: string;
    pid: number;
    dry_run: boolean;
}

export function isVerificationStage(value: unknown): value is VerificationStage {
    // SAFETY: widening the literal tuple to readonly string[] only relaxes `includes`'s argument type; membership is still checked at runtime.
    return typeof value === "string" && (VERIFICATION_STAGES as readonly string[]).includes(value);
}

/** The stage the surrounding process declared, else the caller's default. */
export function stageFromEnvironment(fallback: VerificationStage, env: NodeJS.ProcessEnv = process.env): VerificationStage {
    const declared = env[STAGE_ENV];
    return isVerificationStage(declared) ? declared : fallback;
}

/** The ledger path: the explicit override when set, else `<root>/.interlinked/verification-stages.jsonl`. */
export function verificationStagesPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
    const override = env[STAGES_LEDGER_ENV];
    return override && override.length > 0 ? override : join(root, ".interlinked", VERIFICATION_STAGES_FILE);
}

/** Same platform identity the test receipts key on, as one comparable string. */
export function platformIdentity(): string {
    return `${process.platform}-${process.arch}-${release()}`;
}

export function buildVerificationStageRow(input: VerificationStageInput, dryRun: boolean, clock: () => Date = () => new Date()): VerificationStageRow {
    return { schema: VERIFICATION_STAGES_SCHEMA, ts: clock().toISOString(), ...input, platform: platformIdentity(), node: process.versions.node, pid: process.pid, dry_run: dryRun };
}

/** Appends one row. Returns true when a row was written; false for a dry run or any I/O failure. */
export function recordVerificationStage(root: string, input: VerificationStageInput, options: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
    if (options.dryRun) return false;
    const row = buildVerificationStageRow(input, false);
    try {
        const path = verificationStagesPath(root, options.env ?? process.env);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(row)}\n`);
        return true;
    } catch {
        return false;
    }
}

/** Whole milliseconds elapsed since a `Date.now()` mark; never negative. */
export function elapsedMs(since: number, clock: () => number = Date.now): number {
    return Math.max(0, Math.round(clock() - since));
}
