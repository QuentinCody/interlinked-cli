import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNumber, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
import type { LedgerState } from "./hook-coverage-ledger.js";
import type { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { isHookCheckReceipt } from "./hook-coverage-evidence.js";
import { isHookVerificationStatus, type HookVerificationStatus } from "./hook-coverage-verification.js";

export type HookCoverageRequest = { operation: "status" | "verify" } | { operation: "accept_policy"; digest: string } | { operation: "acknowledge"; id: string; generation: number; identity: string; evidence: string };
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
}
const statusRequest = wireObject({ operation: wireLiteral("status", "verify") });
const acceptRequest = wireObject({ operation: wireLiteral("accept_policy"), digest: wireString });
const acknowledgeRequest = wireObject({ operation: wireLiteral("acknowledge"), id: wireString, generation: wireNumber, identity: wireString, evidence: wireString });
export function isHookCoverageRequest(raw: unknown): raw is HookCoverageRequest {
    return statusRequest(raw) || acceptRequest(raw) || acknowledgeRequest(raw);
}
export const isHookCoverageReport = wireObject<HookCoverageReport>({
    readiness: wireLiteral("ready", "unmeasured"), reason: wireAbsentOptional(wireOptional(wireString)), generation: wireAbsentOptional(wireNumber), policyDigest: wireAbsentOptional(wireString), acceptedPolicy: wireAbsentOptional(wireOptional(wireString)), changed: wireAbsentOptional(wireBoolean), watchPaths: wireAbsentOptional(wireArray(wireString)),
    pending: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, scope: wireLiteral("policy", "reservation"), writer: wireLiteral("unknown") }))),
    reviews: wireAbsentOptional(wireArray(wireObject({ id: wireString, path: wireString, identity: wireString, evidence: wireString, reviewedAt: wireString, kind: wireLiteral("manual_review") }))),
    checks: wireAbsentOptional(wireArray(isHookCheckReceipt)), verification: wireAbsentOptional(wireOptional(isHookVerificationStatus)),
});

/** Only the daemon mutates its ledger. Every mutation reconciles before CAS. */
export function controlHookCoverage(watcher: ReturnType<typeof startHookFilesystemWatch> | undefined, request: HookCoverageRequest): HookCoverageReport {
    if (!watcher) return { readiness: "unmeasured", reason: "Daemon filesystem observer unavailable" };
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
