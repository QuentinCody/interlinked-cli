import { wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";

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
    checkedAt: string;
    kind: "automated_check";
}

export const isHookCheckReceipt = wireObject<HookCheckReceipt>({
    id: wireString, path: wireString, identity: wireString, policyDigest: wireString, policyGeneration: wireNumber,
    checks: wireArray(wireString), findings: wireArray(wireString), checkedAt: wireString,
    kind: wireLiteral("automated_check"),
});

export function parseHookCheckReceipts(raw: unknown): HookCheckReceipt[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every(isHookCheckReceipt)) throw new Error("Invalid hook check receipts");
    return raw;
}
