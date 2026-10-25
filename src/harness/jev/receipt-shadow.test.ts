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
});
