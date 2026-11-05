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
/**
 * One correlation identifier for one verification request: the daemon mints it when it judges a push and
 * carries it into the native command's environment, the Git hook exports it (or mints its own when none is
 * inherited), and every writer below inherits it from the environment. `interlinked tests trace` joins on it.
 */
export const TRACE_ENV = "INTERLINKED_VERIFICATION_TRACE";
/** Which process owns the check a row describes: `daemon` (pre-tool gate), `git-hook` (the pinned pre-push gate), `cli`, `scheduler`. */
export const OWNER_ENV = "INTERLINKED_VERIFICATION_OWNER";
const TRACE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

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
    | "empty-selection"
    /** A recognized push stayed on the legacy checks; the suffix is a `ManagedPushFallbackCause` (`managed-push.ts`). */
    | `handoff-fallback:${string}`;

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
    /** Peak sampled RSS (bytes) of the bounded child tree; null for an unsampled legacy check. Older writers may omit it. */
    peak_rss_bytes?: number | null;
    /** Resident-memory budget (bytes) the command was admitted under; compare with `peak_rss_bytes` for headroom. */
    rss_budget_bytes?: number;
    /** V8 heap limit (MiB) the bounded command was started with (`--max-old-space-size`). */
    heap_limit_mb?: number;
    run_id?: string;
    session?: string;
    /** Correlation identifier (see `TRACE_ENV`); defaults to the environment's when the writer passes none. */
    trace?: string;
    /** Executing owner of the check (see `OWNER_ENV`); defaults to the environment's. */
    owner?: string;
    /** Test files the attempt executed and reused; absent for checks that are not test runs. */
    tests_executed?: number;
    tests_reused?: number;
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

/** The inherited correlation identifier, when the environment carries a well-formed one. */
export function traceFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const declared = env[TRACE_ENV];
    return declared && TRACE_PATTERN.test(declared) ? declared : undefined;
}

/** `trace` and `owner` from the input, else from the environment; absent when neither names one. */
function correlation(input: VerificationStageInput, env: NodeJS.ProcessEnv): Pick<VerificationStageInput, "trace" | "owner"> {
    const trace = input.trace ?? traceFromEnvironment(env);
    const owner = input.owner ?? (env[OWNER_ENV] && /^[a-z-]{1,32}$/.test(env[OWNER_ENV]) ? env[OWNER_ENV] : undefined);
    return { ...(trace === undefined ? {} : { trace }), ...(owner === undefined ? {} : { owner }) };
}

export function buildVerificationStageRow(input: VerificationStageInput, dryRun: boolean, clock: () => Date = () => new Date(), env: NodeJS.ProcessEnv = process.env): VerificationStageRow {
    return { schema: VERIFICATION_STAGES_SCHEMA, ts: clock().toISOString(), ...input, ...correlation(input, env), platform: platformIdentity(), node: process.versions.node, pid: process.pid, dry_run: dryRun };
}

/** Appends one row. Returns true when a row was written; false for a dry run or any I/O failure. */
export function recordVerificationStage(root: string, input: VerificationStageInput, options: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): boolean {
    if (options.dryRun) return false;
    const row = buildVerificationStageRow(input, false, undefined, options.env ?? process.env);
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
