/** Optional observation only. Supplied links do not authenticate receipt producers or infer claim scope. */
import { interpretOperationalClaim, interpretTestClaim, verifyOperationalClaim, verifyTestClaim,
    type OperationalReceipt, type TestReceipt } from "./receipt-verifiers.js";
import type { JevClient } from "./client.js";

export interface ReceiptShadowOptions {
    enabled?: boolean;
    links: unknown[];
    write: (row: ReceiptShadowRow) => void;
    /** The shadow's OWN Jev client (own ledger). Absent: no shadow Jev call, grammar-line rows stay unmeasured. */
    client?: JevClient;
}
export interface ReceiptShadowRow {
    ts: string; claim: string; family: string | null; status: string; reason: string;
    jevSupported: boolean | null; disagrees: boolean | null; receiptId: string | null;
}
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(v => typeof v === "string" && v.length > 0);
let observationFailures = 0;
export const receiptShadowFailures = () => observationFailures;

const missing = (reason: string) => ({ family: null, status: "not_assessable", reason, receiptId: null });

function verifyLink(claim: string, value: unknown) {
    if (!object(value) || !object(value.scope) || !object(value.receipt)) return missing("invalid_link");
    const s = value.scope; const r = value.receipt;
    if (typeof s.receiptId !== "string" || typeof s.sourceIdentity !== "string" || !strings(s.selection) || typeof s.cwd !== "string"
        || typeof r.id !== "string" || typeof r.sourceIdentity !== "string" || !strings(r.selection)
        || !["completed", "running", "missing", "cancelled"].includes(String(r.completion))) return missing("invalid_scope_or_completion");
    const scope = { receiptId: s.receiptId, sourceIdentity: s.sourceIdentity, selection: s.selection, cwd: s.cwd };
    if (value.family === "tests") {
        if (!object(r.runner) && r.runner !== null) return missing("invalid_runner");
        const parsed = interpretTestClaim(claim, scope);
        const receipt: TestReceipt = { id: r.id, sourceIdentity: r.sourceIdentity, selection: r.selection,
            completion: r.completion === "completed" ? "completed" : r.completion === "running" ? "running" : "missing", runner: r.runner };
        return parsed ? { ...verifyTestClaim(parsed, receipt), family: "tests" } : missing("unsupported_claim_grammar");
    }
    return verifyOperationalLink(claim, scope, r, { id: r.id, sourceIdentity: r.sourceIdentity, selection: r.selection });
}

function verifyOperationalLink(claim: string, scope: Parameters<typeof interpretOperationalClaim>[1],
    r: Record<string, unknown>, common: Pick<OperationalReceipt, "id" | "sourceIdentity" | "selection">) {
    if (typeof r.cwd !== "string" || !["command", "typescript"].includes(String(r.runner)) || typeof r.directInvocation !== "boolean"
        || typeof r.outputComplete !== "boolean" || ![true, false, null].includes(r.sourceUnchanged as boolean | null)
        || !(r.exitCode === null || Number.isInteger(r.exitCode)) || !(r.signal === null || typeof r.signal === "string")) return missing("invalid_operational_receipt");
    if (r.fileWrite !== undefined && (!object(r.fileWrite) || typeof r.fileWrite.path !== "string" || typeof r.fileWrite.observedByCall !== "string"
        || typeof r.fileWrite.afterSha256 !== "string" || typeof r.fileWrite.bytesWritten !== "number")) return missing("invalid_write_observation");
    const parsed = interpretOperationalClaim(claim, scope);
    const receipt: OperationalReceipt = { ...common, cwd: r.cwd,
        completion: r.completion === "completed" ? "completed" : r.completion === "running" ? "running" : r.completion === "cancelled" ? "cancelled" : "missing",
        runner: r.runner === "typescript" ? "typescript" : "command", directInvocation: r.directInvocation, outputComplete: r.outputComplete,
        sourceUnchanged: r.sourceUnchanged === true ? true : r.sourceUnchanged === false ? false : null,
        exitCode: r.exitCode === null ? null : Number(r.exitCode), signal: typeof r.signal === "string" ? r.signal : null, stdout: "", stderr: "" };
    if (object(r.fileWrite)) receipt.fileWrite = { path: String(r.fileWrite.path), observedByCall: String(r.fileWrite.observedByCall),
        afterSha256: String(r.fileWrite.afterSha256), bytesWritten: Number(r.fileWrite.bytesWritten) };
    return parsed ? { ...verifyOperationalClaim(parsed, receipt), family: parsed.family } : missing("unsupported_claim_grammar");
}

/** Never throws into, modifies, or supplies a result to the existing judgment path. */
export function observeReceiptClaims(claims: string[], scores: Map<string, boolean | null>, options?: ReceiptShadowOptions): void {
    if (options?.enabled !== true) return;
    for (const claim of claims) {
        try {
            const links = options.links.filter(x => object(x) && x.claim === claim);
            const verdict = links.length === 1 ? verifyLink(claim, links[0])
                : { family: null, status: "not_assessable", reason: links.length ? "ambiguous_link" : "missing_link", receiptId: null };
            const jevSupported = scores.get(claim) ?? null;
            options.write({ ts: new Date().toISOString(), claim, ...verdict, jevSupported,
                disagrees: jevSupported === null || verdict.status === "not_assessable" ? null : (verdict.status === "supported") !== jevSupported });
        } catch { observationFailures++; }
    }
}
