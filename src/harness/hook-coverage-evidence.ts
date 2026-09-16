import { wireAbsentOptional, wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";
import type { BatchCheckScope } from "./quality-checks/change-set-evidence.js";

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
