import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import type { BatchCheckScope } from "./quality-checks/change-set-evidence.js";

/** A manual review that cleared one pending version. Retained as history only. */
export interface HookReviewReceipt { id: string; path: string; identity: string; evidence: string; reviewedAt: string; kind: "manual_review" }

function reviewString(raw: Record<string, unknown>, key: string): string {
    const value = raw[key];
    if (typeof value !== "string") throw new Error(`Invalid hook review ${key}`);
    return value;
}

export function parseHookReviewReceipt(raw: unknown): HookReviewReceipt {
    if (!isJsonObject(raw) || raw.kind !== "manual_review") throw new Error("Invalid hook review receipt");
    return { id: reviewString(raw, "id"), path: reviewString(raw, "path"), identity: reviewString(raw, "identity"),
        evidence: reviewString(raw, "evidence"), reviewedAt: reviewString(raw, "reviewedAt"), kind: "manual_review" };
}

const isBatchCheckScope = wireObject<BatchCheckScope>({
    batchId: wireString, check: wireString, configurationHash: wireString,
    inputs: wireArray(wireObject({ path: wireString, identity: wireString })), kind: wireLiteral("request-inputs"),
});

/** Evidence of a completed check scope, including any findings it produced.
 * This is neither writer attribution nor acceptance of protected policy. */
export interface HookCheckReceipt {
    id: string;
    path: string;
    identity: string;
    policyDigest: string;
    policyGeneration: number;
    checks: string[];
    findings: string[];
    /** Nonempty means partial evidence: completed checks are retained, the version stays pending.
     * These receipts are historical execution evidence, not a reusable input-closure cache. */
    unavailable?: string[];
    scopes?: BatchCheckScope[];
    checkedAt: string;
    kind: "automated_check";
}

export const isHookCheckReceipt = wireObject<HookCheckReceipt>({
    id: wireString, path: wireString, identity: wireString, policyDigest: wireString, policyGeneration: wireNumber,
    checks: wireArray(wireString), findings: wireArray(wireString), checkedAt: wireString,
    unavailable: wireAbsentOptional(wireArray(wireString)),
    scopes: wireAbsentOptional(wireArray(isBatchCheckScope)),
    kind: wireLiteral("automated_check"),
});

export function parseHookCheckReceipts(raw: unknown): HookCheckReceipt[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every(isHookCheckReceipt)) throw new Error("Invalid hook check receipts");
    return raw;
}
