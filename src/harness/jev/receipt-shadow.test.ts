import { describe, expect, it } from "vitest";
import { observeReceiptClaims } from "./receipt-shadow.js";

describe("default-off receipt shadow", () => {
    const claim = "All 3 executed tests passed.";
    const link = { claim, family: "tests", scope: { receiptId: "r1", sourceIdentity: "rev1", selection: ["suite"], cwd: "/p" },
        receipt: { id: "r1", sourceIdentity: "rev1", selection: ["suite"], completion: "completed",
            runner: { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 } } };
    it("does no work by default; enabled observation cannot alter the caller's decision", () => {
        const rows: unknown[] = []; const write = (r: unknown) => { rows.push(r); };
        observeReceiptClaims([claim], new Map([[claim, false]]), { links: [link], write });
        expect(rows).toEqual([]);
        observeReceiptClaims([claim], new Map([[claim, false]]), { enabled: true, links: [link], write });
        expect(rows).toMatchObject([{ status: "supported", disagrees: true, jevSupported: false }]);
    });
    it("keeps missing linkage and malformed/ambiguous receipt data unsettled", () => {
        const rows: unknown[] = []; const write = (r: unknown) => { rows.push(r); };
        observeReceiptClaims([claim, "Other claim."], new Map(), { enabled: true, links: [link, link], write });
        expect(rows).toMatchObject([{ status: "not_assessable", reason: "ambiguous_link" }, { status: "not_assessable", reason: "missing_link" }]);
        expect(() => observeReceiptClaims([claim], new Map(), { enabled: true, links: [link], write: () => { throw new Error("disk full"); } })).not.toThrow();
    });
    const operation = { ...link.receipt, cwd: "/p", runner: "typescript", directInvocation: true, outputComplete: true,
        sourceUnchanged: true, exitCode: 0, signal: null };
    function observeOperation(claim: string, extra: Record<string, unknown> = {}) {
        const rows: unknown[] = [];
        observeReceiptClaims([claim], new Map(), { enabled: true, links: [{ claim, scope: link.scope, family: "operational",
            receipt: { ...operation, ...extra } }], write: row => { rows.push(row); } });
        return rows;
    }
    it("keeps completed compiler and observed empty-file writes assessable", () => {
        expect(observeOperation("Typecheck completed cleanly.")).toMatchObject([{ status: "supported" }]);
        const fileWrite = { path: "x", observedByCall: "r1", afterSha256: "a".repeat(64), bytesWritten: 0 };
        expect(observeOperation("File `x` was written.", { exitCode: null, completion: "running", fileWrite }))
            .toMatchObject([{ status: "supported", reason: "matching_observed_write" }]);
    });
    it.each([
        [{ runner: ["typescript"] }, "invalid_operational_receipt"],
        [{ completion: ["completed"] }, "invalid_scope_or_completion"],
        [{ exitCode: "0" }, "invalid_operational_receipt"],
        [{ signal: 0 }, "invalid_operational_receipt"],
        [{ fileWrite: { path: "x", observedByCall: "r1", afterSha256: "a".repeat(64), bytesWritten: "0" } }, "invalid_write_observation"],
    ] as const)("rejects malformed capture values (%j)", (extra, reason) => {
        expect(observeOperation("Command completed.", extra)).toMatchObject([{ status: "not_assessable", reason }]);
    });
});
