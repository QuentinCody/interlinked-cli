import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
import type { LedgerState } from "./hook-coverage-ledger.js";
import type { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { isHookCheckReceipt } from "./hook-coverage-evidence.js";
import { isHookVerificationProgress, isHookVerificationStatus, type HookVerificationProgress, type HookVerificationStatus } from "./hook-coverage-verification.js";
import { isHookCoverageHistory, type HookCoverageHistory } from "./hook-coverage-history.js";

export type HookCoverageRequest = { operation: "status"; detail?: "progress" | "verification" } | { operation: "verify"; detail?: "progress" } | { operation: "accept_policy"; digest: string } | { operation: "acknowledge"; id: string; generation: number; identity: string; evidence: string };
export interface HookCoverageProgress {
    observedAt: string | null;
    pendingCount: number;
    verification?: HookVerificationProgress | undefined;
}
export interface HookCoverageReport {
    readiness: "ready" | "unmeasured";
    reason?: string | undefined;
    /** False for a permanent control error, such as host socket permissions. */
    retryable?: boolean;
    generation?: number;
    policyDigest?: string;
    acceptedPolicy?: string | undefined;
    pending?: LedgerState["pending"];
    reviews?: LedgerState["reviews"];
    checks?: LedgerState["checks"];
    history?: HookCoverageHistory;
    verification?: HookVerificationStatus | undefined;
    watchPaths?: string[];
    changed?: boolean;
    /** Cached observation only; never a fresh file/check verdict. */
    progress?: HookCoverageProgress;
}
const statusRequest = wireObject({ operation: wireLiteral("status"), detail: wireAbsentOptional(wireLiteral("progress", "verification")) });
const verifyRequest = wireObject({ operation: wireLiteral("verify"), detail: wireAbsentOptional(wireLiteral("progress")) });
const acceptRequest = wireObject({ operation: wireLiteral("accept_policy"), digest: wireString });
const acknowledgeRequest = wireObject({ operation: wireLiteral("acknowledge"), id: wireString, generation: wireNumber, identity: wireString, evidence: wireString });
export function isHookCoverageRequest(raw: unknown): raw is HookCoverageRequest {
    return statusRequest(raw) || verifyRequest(raw) || acceptRequest(raw) || acknowledgeRequest(raw);
}
export const isHookCoverageReport = wireObject<HookCoverageReport>({
    readiness: wireLiteral("ready", "unmeasured"), reason: wireAbsentOptional(wireOptional(wireString)), retryable: wireAbsentOptional(wireBoolean), generation: wireAbsentOptional(wireNumber), policyDigest: wireAbsentOptional(wireString), acceptedPolicy: wireAbsentOptional(wireOptional(wireString)), changed: wireAbsentOptional(wireBoolean), watchPaths: wireAbsentOptional(wireArray(wireString)),
    pending: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, scope: wireLiteral("policy", "reservation"), writer: wireLiteral("unknown") }))),
    reviews: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, evidence: wireString, reviewedAt: wireString, kind: wireLiteral("manual_review") }))),
    checks: wireAbsentOptional(wireArray(isHookCheckReceipt)), history: wireAbsentOptional(isHookCoverageHistory), verification: wireAbsentOptional(wireOptional(isHookVerificationStatus)),
    progress: wireAbsentOptional(wireObject<HookCoverageProgress>({ observedAt: wireNullable(wireString), pendingCount: wireNumber,
        verification: wireAbsentOptional(wireOptional(isHookVerificationProgress)) })),
});

function coverageProgress(watcher: ReturnType<typeof startHookFilesystemWatch>): HookCoverageReport {
    const status = watcher.status(), summary = watcher.ledger.summary();
    return { readiness: status.readiness === "ready" ? "ready" : "unmeasured",
        reason: status.unmeasured.slice(0, 3).join("; ") || undefined, generation: summary.generation,
        progress: { observedAt: status.lastReconciled, pendingCount: summary.pendingCount, verification: watcher.verification?.progress() } };
}

/** Opt-out for the idle evidence drain (`=0`); the drain is on by default. */
export const AUTO_DRAIN_ENV = "INTERLINKED_HOOK_COVERAGE_AUTO_DRAIN";

/**
 * The idle drain: start the bounded verify job when versions are pending and none is running. Versions written
 * outside hook events stay pending until a check of that exact version runs, and only an explicit
 * `interlinked harness coverage verify` used to run one, so the backlog only grew (1,415 at 2026-10-02).
 * Returns whether a job started.
 */
export function startIdleEvidenceDrain(watcher: ReturnType<typeof startHookFilesystemWatch> | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    if (env[AUTO_DRAIN_ENV] === "0" || !watcher?.verification || watcher.verification.isRunning()) return false;
    watcher.reconcile();
    if (watcher.status().readiness !== "ready" || watcher.ledger.summary().pendingCount === 0) return false;
    watcher.verification.start();
    return watcher.verification.isRunning();
}

/** Only current pending versions and this job's results, without historical receipts. */
function verificationReport(watcher: ReturnType<typeof startHookFilesystemWatch>): HookCoverageReport {
    const status = watcher.status();
    return { readiness: status.readiness === "ready" ? "ready" : "unmeasured",
        reason: status.unmeasured.join("; ") || undefined, generation: watcher.ledger.summary().generation,
        pending: watcher.ledger.observation().pending, verification: watcher.verification?.status() };
}

function applyCoverageMutation(watcher: ReturnType<typeof startHookFilesystemWatch>, request: HookCoverageRequest): boolean | undefined {
    switch (request.operation) {
        case "accept_policy": return watcher.ledger.acceptPolicy(request.digest);
        case "acknowledge": return watcher.ledger.acknowledge(request);
        case "verify": watcher.verification?.start(); return watcher.verification !== undefined;
        case "status": return undefined;
    }
}

/** Only the daemon mutates its ledger. Every mutation reconciles before CAS. */
export function controlHookCoverage(watcher: ReturnType<typeof startHookFilesystemWatch> | undefined, request: HookCoverageRequest): HookCoverageReport {
    if (!watcher) return { readiness: "unmeasured", reason: "Daemon filesystem observer unavailable" };
    if (request.operation === "status" && request.detail === "progress") return coverageProgress(watcher);
    watcher.reconcile();
    const status = watcher.status();
    if (request.operation === "status" && request.detail === "verification") return verificationReport(watcher);
    const changed = status.readiness === "ready" ? applyCoverageMutation(watcher, request) : undefined;
    // Starting a job must not clone and transmit the entire retained history.
    // This acknowledgement identifies the job; it is not a completed check verdict.
    if (request.operation === "verify" && request.detail === "progress") return { ...coverageProgress(watcher), changed: changed === true };
    const snapshot = watcher.ledger.statusReport();
    return {
        readiness: status.readiness === "ready" ? "ready" : "unmeasured", reason: status.unmeasured.join("; ") || undefined,
        generation: snapshot.generation, policyDigest: watcher.ledger.policyDigest(), acceptedPolicy: snapshot.acceptedPolicy ?? undefined,
        pending: snapshot.pending, reviews: snapshot.reviews, checks: snapshot.checks, history: snapshot.history,
        verification: watcher.verification?.status(), watchPaths: watcher.watchPaths(), ...(changed === undefined ? {} : { changed }),
    };
}
