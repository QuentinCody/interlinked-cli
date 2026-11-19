/** Optional observation only. Supplied links do not authenticate receipt producers or infer claim scope. */
import { interpretOperationalClaim, interpretTestClaim, verifyOperationalClaim, verifyTestClaim,
    type OperationalReceipt, type TestReceipt } from "./receipt-verifiers.js";
import type { JevClient } from "./client.js";
import { isJsonObject as object, type JsonObject } from "../../lib/json-types.js";

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
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(v => typeof v === "string" && v.length > 0);
let observationFailures = 0;
export const receiptShadowFailures = () => observationFailures;

const missing = (reason: string) => ({ family: null, status: "not_assessable", reason, receiptId: null });

function isCompletion(value: unknown): value is OperationalReceipt["completion"] {
    return value === "completed" || value === "running" || value === "missing" || value === "cancelled";
}

function verifyLink(claim: string, value: unknown) {
    if (!object(value) || !object(value.scope) || !object(value.receipt)) return missing("invalid_link");
    const s = value.scope; const r = value.receipt;
    if (typeof s.receiptId !== "string" || typeof s.sourceIdentity !== "string" || !strings(s.selection) || typeof s.cwd !== "string"
        || typeof r.id !== "string" || typeof r.sourceIdentity !== "string" || !strings(r.selection)
        || !isCompletion(r.completion)) return missing("invalid_scope_or_completion");
    const scope = { receiptId: s.receiptId, sourceIdentity: s.sourceIdentity, selection: s.selection, cwd: s.cwd };
    if (value.family === "tests") {
        if (!object(r.runner) && r.runner !== null) return missing("invalid_runner");
        const parsed = interpretTestClaim(claim, scope);
        const receipt: TestReceipt = { id: r.id, sourceIdentity: r.sourceIdentity, selection: r.selection,
            completion: r.completion === "cancelled" ? "missing" : r.completion, runner: r.runner };
        return parsed ? { ...verifyTestClaim(parsed, receipt), family: "tests" } : missing("unsupported_claim_grammar");
    }
    return verifyOperationalLink(claim, scope, r, { id: r.id, sourceIdentity: r.sourceIdentity, selection: r.selection, completion: r.completion });
}

function parseExecution(r: JsonObject) {
    const { cwd, runner, directInvocation, outputComplete, sourceUnchanged, exitCode, signal } = r;
    if (typeof cwd !== "string" || (runner !== "command" && runner !== "typescript")) return null;
    if (typeof directInvocation !== "boolean" || typeof outputComplete !== "boolean") return null;
    if (sourceUnchanged !== null && typeof sourceUnchanged !== "boolean") return null;
    if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) return null;
    if (signal !== null && typeof signal !== "string") return null;
    return { cwd, runner, directInvocation, outputComplete, sourceUnchanged, exitCode, signal } as const;
}

function parseFileWrite(value: unknown): OperationalReceipt["fileWrite"] | null {
    if (value === undefined) return undefined;
    if (!object(value)) return null;
    const { path, observedByCall, afterSha256, bytesWritten } = value;
    if (typeof path !== "string" || typeof observedByCall !== "string" || typeof afterSha256 !== "string" || typeof bytesWritten !== "number") return null;
    return { path, observedByCall, afterSha256, bytesWritten };
}

function verifyOperationalLink(claim: string, scope: Parameters<typeof interpretOperationalClaim>[1],
    r: JsonObject, common: Pick<OperationalReceipt, "id" | "sourceIdentity" | "selection" | "completion">) {
    const execution = parseExecution(r);
    if (!execution) return missing("invalid_operational_receipt");
    const fileWrite = parseFileWrite(r.fileWrite);
    if (fileWrite === null) return missing("invalid_write_observation");
    const parsed = interpretOperationalClaim(claim, scope);
    if (!parsed) return missing("unsupported_claim_grammar");
    const receipt: OperationalReceipt = { ...common, ...execution, stdout: "", stderr: "" };
    if (fileWrite !== undefined) receipt.fileWrite = fileWrite;
    return { ...verifyOperationalClaim(parsed, receipt), family: parsed.family };
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
