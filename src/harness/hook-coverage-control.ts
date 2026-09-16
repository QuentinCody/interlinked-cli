import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
import type { LedgerState } from "./hook-coverage-ledger.js";
import type { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { isHookCheckReceipt } from "./hook-coverage-evidence.js";
import { isHookVerificationProgress, isHookVerificationStatus, type HookVerificationProgress, type HookVerificationStatus } from "./hook-coverage-verification.js";

export type HookCoverageRequest = { operation: "status"; detail?: "progress" } | { operation: "verify" } | { operation: "accept_policy"; digest: string } | { operation: "acknowledge"; id: string; generation: number; identity: string; evidence: string };
export interface HookCoverageProgress {
    observedAt: string | null;
    pendingCount: number;
    verification?: HookVerificationProgress | undefined;
}
export interface HookCoverageReport {
    readiness: "ready" | "unmeasured";
    reason?: string | undefined;
    generation?: number;
    policyDigest?: string;
    acceptedPolicy?: string | undefined;
    pending?: LedgerState["pending"];
    reviews?: LedgerState["reviews"];
    checks?: LedgerState["checks"];
    verification?: HookVerificationStatus | undefined;
    watchPaths?: string[];
    changed?: boolean;
    /** Cached observation only; never a fresh file/check verdict. */
    progress?: HookCoverageProgress;
}
const statusRequest = wireObject({ operation: wireLiteral("status"), detail: wireAbsentOptional(wireLiteral("progress")) });
const verifyRequest = wireObject({ operation: wireLiteral("verify") });
const acceptRequest = wireObject({ operation: wireLiteral("accept_policy"), digest: wireString });
const acknowledgeRequest = wireObject({ operation: wireLiteral("acknowledge"), id: wireString, generation: wireNumber, identity: wireString, evidence: wireString });
export function isHookCoverageRequest(raw: unknown): raw is HookCoverageRequest {
    return statusRequest(raw) || verifyRequest(raw) || acceptRequest(raw) || acknowledgeRequest(raw);
}
export const isHookCoverageReport = wireObject<HookCoverageReport>({
    readiness: wireLiteral("ready", "unmeasured"), reason: wireAbsentOptional(wireOptional(wireString)), generation: wireAbsentOptional(wireNumber), policyDigest: wireAbsentOptional(wireString), acceptedPolicy: wireAbsentOptional(wireOptional(wireString)), changed: wireAbsentOptional(wireBoolean), watchPaths: wireAbsentOptional(wireArray(wireString)),
    pending: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, scope: wireLiteral("policy", "reservation"), writer: wireLiteral("unknown") }))),
    reviews: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, evidence: wireString, reviewedAt: wireString, kind: wireLiteral("manual_review") }))),
    checks: wireAbsentOptional(wireArray(isHookCheckReceipt)), verification: wireAbsentOptional(wireOptional(isHookVerificationStatus)),
    progress: wireAbsentOptional(wireObject<HookCoverageProgress>({ observedAt: wireNullable(wireString), pendingCount: wireNumber,
        verification: wireAbsentOptional(wireOptional(isHookVerificationProgress)) })),
});

function coverageProgress(watcher: ReturnType<typeof startHookFilesystemWatch>): HookCoverageReport {
    const status = watcher.status(), summary = watcher.ledger.summary();
    return { readiness: status.readiness === "ready" ? "ready" : "unmeasured",
        reason: status.unmeasured.slice(0, 3).join("; ") || undefined, generation: summary.generation,
        progress: { observedAt: status.lastReconciled, pendingCount: summary.pendingCount, verification: watcher.verification?.progress() } };
}

/** Only the daemon mutates its ledger. Every mutation reconciles before CAS. */
export function controlHookCoverage(watcher: ReturnType<typeof startHookFilesystemWatch> | undefined, request: HookCoverageRequest): HookCoverageReport {
    if (!watcher) return { readiness: "unmeasured", reason: "Daemon filesystem observer unavailable" };
    if (request.operation === "status" && request.detail === "progress") return coverageProgress(watcher);
    watcher.reconcile();
    const status = watcher.status();
    let changed: boolean | undefined;
    if (status.readiness === "ready") {
        if (request.operation === "accept_policy") changed = watcher.ledger.acceptPolicy(request.digest);
        if (request.operation === "acknowledge") changed = watcher.ledger.acknowledge(request);
        if (request.operation === "verify") { watcher.verification?.start(); changed = watcher.verification !== undefined; }
    }
    const snapshot = watcher.ledger.snapshot();
    return {
        readiness: status.readiness === "ready" ? "ready" : "unmeasured", reason: status.unmeasured.join("; ") || undefined,
        generation: snapshot.generation, policyDigest: watcher.ledger.policyDigest(), acceptedPolicy: snapshot.acceptedPolicy ?? undefined,
        pending: snapshot.pending, reviews: snapshot.reviews, checks: snapshot.checks, verification: watcher.verification?.status(), watchPaths: watcher.watchPaths(), ...(changed === undefined ? {} : { changed }),
    };
}
