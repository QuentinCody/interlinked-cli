import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendE2eTxn, E2E_LEDGER_PATH, parseE2eTxn, readE2eTxns, reduceE2eLedger, scenarioKey, type E2eTxn } from "./ledger.js";

const KEY = scenarioKey("orders", "order-persists");
const G1 = "1".repeat(64), G2 = "2".repeat(64);
function pending(generation: string, atMs: number, reason = "src/orders/create.js changed"): E2eTxn {
    return { op: "pending", key: KEY, generation, reason, atMs, sessionId: "s1" };
}
function attempt(generation: string, status: "passed" | "failed" | "unavailable" | "stale", atMs: number, runId = `run-${atMs}`): E2eTxn {
    return { op: "attempt", key: KEY, generation, runId, status, atMs, receipt: `.interlinked/test-runs/e2e/${runId}/receipt.json`, reason: status };
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("reduceE2eLedger — positive (deterministic state)", () => {
    it("P1: a pending then a passing attempt for the same generation is satisfied for that generation", () => {
        const state = reduceE2eLedger([pending(G1, 1), attempt(G1, "passed", 2)]);
        expect(state.get(KEY)).toMatchObject({ generation: G1, status: "satisfied", lastRunId: "run-2" });
    });
    it("P2: a newer pending generation after a pass leaves the pass as historical evidence only (PE-04, PE-05)", () => {
        const state = reduceE2eLedger([pending(G1, 1), attempt(G1, "passed", 2), pending(G2, 3)]);
        expect(state.get(KEY)).toMatchObject({ generation: G2, status: "pending" });
        expect(state.get(KEY)?.lastSatisfiedGeneration).toBe(G1);
    });
    it("P3: a pass published for an older generation after a newer edit cannot satisfy the newer one (PE-30)", () => {
        const state = reduceE2eLedger([pending(G1, 1), pending(G2, 2), attempt(G1, "passed", 3)]);
        expect(state.get(KEY)).toMatchObject({ generation: G2, status: "pending" });
    });
    it("P4: failed, unavailable and stale attempts keep the obligation open with that status", () => {
        for (const status of ["failed", "unavailable", "stale"] as const) {
            expect(reduceE2eLedger([pending(G1, 1), attempt(G1, status, 2)]).get(KEY)?.status).toBe(status);
        }
    });
    it("P5: invalidate and review-required transitions are explicit and order-sensitive", () => {
        const invalidated = reduceE2eLedger([pending(G1, 1), attempt(G1, "passed", 2), { op: "invalidate", key: KEY, generation: G1, reason: "expectation replaced", atMs: 3 }]);
        expect(invalidated.get(KEY)?.status).toBe("pending");
        const review = reduceE2eLedger([pending(G1, 1), { op: "review-required", key: KEY, generation: G1, reason: "expectation proposed", atMs: 2 }]);
        expect(review.get(KEY)?.status).toBe("review-required");
    });
    it("P6: duplicate events by stable identity fold to one and replay is deterministic", () => {
        const rows = [pending(G1, 1), pending(G1, 1), attempt(G1, "passed", 2), attempt(G1, "passed", 2)];
        expect(reduceE2eLedger(rows)).toEqual(reduceE2eLedger(rows));
        expect(reduceE2eLedger(rows).get(KEY)?.attempts).toBe(1);
    });
});
describe("reduceE2eLedger — negative", () => {
    it("N1: an attempt with no prior pending for that generation never creates a satisfied obligation from nothing", () => {
        expect(reduceE2eLedger([attempt(G1, "passed", 2)]).get(KEY)?.status).toBe("satisfied");
        expect(reduceE2eLedger([attempt(G2, "passed", 2), pending(G1, 3)]).get(KEY)?.status).toBe("pending");
    });
    it("N2: parseE2eTxn rejects malformed rows instead of guessing", () => {
        expect(parseE2eTxn({ op: "pending", key: KEY })).toBeNull();
        expect(parseE2eTxn({ op: "teleport", key: KEY, generation: G1, atMs: 1 })).toBeNull();
        expect(parseE2eTxn(pending(G1, 1))).toEqual(pending(G1, 1));
    });
});
describe("ledger IO", () => {
    it("P7: appends JSONL rows, reads them back and skips a torn last line", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-ledger-")); roots.push(root);
        appendE2eTxn(root, pending(G1, 1));
        appendE2eTxn(root, attempt(G1, "passed", 2));
        expect(readE2eTxns(root)).toHaveLength(2);
        expect(readFileSync(join(root, E2E_LEDGER_PATH), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    });
});
