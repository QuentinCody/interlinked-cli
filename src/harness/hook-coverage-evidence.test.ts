import { describe, expect, it } from "vitest";
import { isHookCheckReceipt, parseHookCheckReceipts } from "./hook-coverage-evidence.js";

describe("persisted hook check evidence", () => {
    it("reads older ledgers without inventing completed checks", () => {
        expect(parseHookCheckReceipts(undefined)).toEqual([]);
    });

    it("preserves findings and the policy generation of a completed check", () => {
        const receipt = { id: "observation", path: "/repo/a.ts", identity: "sha256", policyDigest: "policy", policyGeneration: 3,
            checks: ["typescript"], findings: ["type mismatch"], checkedAt: "2026-09-08T00:00:00Z", kind: "automated_check" };
        expect(isHookCheckReceipt(receipt)).toBe(true);
        expect(parseHookCheckReceipts([receipt])).toEqual([receipt]);
    });

    it.each([null, {}, [null], [{ kind: "manual_review" }], [{ kind: "automated_check", checks: "typescript" }]])("refuses corrupt history instead of replacing it with clean state: %j", value => {
        expect(() => parseHookCheckReceipts(value)).toThrow("Invalid hook check receipts");
    });
});
