import { availableParallelism } from "node:os";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import type { CoverageSummary, FileCoverageEntry } from "../coverage-ratchet.js";
import { testWorkerBudget } from "../test-execution.js";
import { admitIndexedRun } from "./admission.js";
import { coverageIndexContext } from "./context.js";
import { runIndexedCoverage } from "./controller.js";
import { promoteMatchingProposal } from "./staged-state.js";
import type { DimensionCounts, FileCoverageMetrics } from "./types.js";

/**
 * The coverage index as a ratchet input (Unit 7). `runIndexedCoverage` re-runs only the test shards whose
 * transitive inputs changed, reuses every other shard's recorded contribution and keeps the zeroed
 * `@denominators` shard, so its per-file metrics span the FULL universe: untouched uncovered files stay in the
 * denominator and the ratchet sees a full-shaped report, not a partial one. Anything the index cannot certify
 * (a failed or unstable shard, a changed runtime, quarantine, a missing manifest that made this a full run
 * that then failed) is reported as a reason with NO summary — the caller runs the full route or records that
 * no verdict exists.
 */
export interface IndexedSummaryOptions {
    /** The measured checkout (a disposable export at pre-push, the working tree otherwise). */
    root: string;
    /** The checkout whose `.interlinked/coverage-index/` holds the index; defaults to `root`. */
    storeRoot?: string;
    timeoutMs: number;
    /**
     * Requested worker cap for the instrumented capture, clamped by the host governor (`testWorkerBudget`). Default 1:
     * an INSTRUMENTED worker is heavier than a plain one — three workers pushed this repository's capture tree past
     * the 4 GiB budget the same host runs the plain suite under (measured 2026-09-30), and the pre-push full route
     * runs one worker too.
     */
    workers?: number;
}
export type IndexedSummaryOutcome =
    | { indexed: true; summary: CoverageSummary; rerunTests: number; universeTests: number; validate_ms: number; exec_ms: number }
    | { indexed: false; reason: string; validate_ms: number; exec_ms: number };

function metric(counts: DimensionCounts): NonNullable<FileCoverageEntry["lines"]> {
    return { pct: counts.pct, covered: counts.covered, total: counts.total };
}

/** Per-file counts → the summary shape `compareCoverage` reads (repo-relative keys; statements only when reported). */
export function metricsToSummary(metrics: ReadonlyMap<string, FileCoverageMetrics>): CoverageSummary {
    const summary: CoverageSummary = {};
    for (const [path, counts] of metrics) {
        const entry: FileCoverageEntry = { lines: metric(counts.lines), branches: metric(counts.branches), functions: metric(counts.functions) };
        if (counts.statements) entry.statements = metric(counts.statements);
        summary[path] = entry;
    }
    return summary;
}

/**
 * Every failure to certify is an UNAVAILABLE outcome with its reason and the time it cost — including the ones the
 * index raises as exceptions (a runtime census past its deadline, a quarantined index, a corrupt contribution, a
 * discovered test outside the inventory): the caller records them all the same way, and none becomes a generic
 * command error without a stage row (found by review 2026-09-29).
 */
export async function indexedCoverageSummary(options: IndexedSummaryOptions): Promise<IndexedSummaryOutcome> {
    const started = Date.now();
    const deadline = started + options.timeoutMs;
    let validate_ms = 0;
    try {
        const context = await coverageIndexContext(collectRepositoryInventory(options.root), new Map(), { deadline, ...(options.storeRoot !== undefined ? { storeRoot: options.storeRoot } : {}) });
        validate_ms = Date.now() - started;
        const execStarted = Date.now();
        const unavailable = (reason: string): IndexedSummaryOutcome => ({ indexed: false, reason, validate_ms, exec_ms: Date.now() - execStarted });
        // The same host governor every test lane obeys: memory-bounded workers, never the runner's core count.
        const maxWorkers = testWorkerBudget(Math.min(options.workers ?? 1, availableParallelism()));
        if (maxWorkers < 1) return unavailable("Host CPU or memory capacity unavailable for a test worker");
        // Admission is the scheduler's: project lease + host slot + a supervised memory budget, held for the run only.
        const admission = await admitIndexedRun(options.root, deadline);
        if (!admission.admitted) return unavailable(admission.reason);
        let result: Awaited<ReturnType<typeof runIndexedCoverage>>;
        try { result = await runIndexedCoverage({ context, workspace: options.root, timeoutMs: options.timeoutMs, full: false, maxWorkers, resourceBudget: admission.resourceBudget }); }
        finally { admission.release(); }
        if (!result.indexed) return unavailable(result.reason ?? "Index unavailable");
        if (!result.metrics || result.metrics.size === 0) return unavailable("Index produced no per-file metrics");
        const rerunTests = result.selectedTests?.length ?? context.testFiles.length;
        // A run that captured shards left a PROPOSAL; accept it now, while the measured revision is still the current
        // one. Left staged, the next run (a different revision) can never match it and re-runs everything; a proposal
        // the current bytes no longer match is no verdict either (review 2026-09-30). A reuse run staged nothing.
        if (rerunTests > 0 && !(await promoteMatchingProposal(context))) return unavailable("Measured coverage index was not accepted: inputs changed after the run");
        return { indexed: true, summary: metricsToSummary(result.metrics), rerunTests, universeTests: context.testFiles.length, validate_ms, exec_ms: Date.now() - execStarted };
    } catch (error) {
        const elapsed = Date.now() - started;
        return { indexed: false, reason: error instanceof Error ? error.message : String(error), validate_ms, exec_ms: Math.max(0, elapsed - validate_ms) };
    }
}
