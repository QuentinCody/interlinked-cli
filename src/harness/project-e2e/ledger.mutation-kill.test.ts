import { describe, expect, it } from "vitest";
import { reduceE2eLedger, scenarioKey, type E2eTxn } from "./ledger.js";

const KEY = scenarioKey("orders", "order-persists");
const G1 = "1".repeat(64), G2 = "2".repeat(64);
const pending = (generation: string, atMs: number): E2eTxn => ({ op: "pending", key: KEY, generation, reason: "src/orders/create.js changed", atMs });
const cohort = (generation: string, atMs: number): E2eTxn => ({ op: "cohort", key: KEY, generation, cohortId: "c-1", verdict: "qualified", record: ".interlinked/test-runs/e2e/cohorts/c-1.json", reason: "3/3 passed", atMs });

// Census fault: `applyCohort` dropped its `row.generation !== txn.generation` guard
// and survived the companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("reduceE2eLedger — cohort rows bind to their own generation", () => {
    // test-contract: invariant — a stability cohort qualified for an OLDER generation is historical evidence; it never attaches to the obligation a newer edit opened
    it("does not attach a cohort verdict recorded for an older generation to the current obligation", () => {
        const state = reduceE2eLedger([pending(G1, 1), pending(G2, 2), cohort(G1, 3)]);
        expect(state.get(KEY)).toMatchObject({ generation: G2, status: "pending" });
        expect(state.get(KEY)?.cohort).toBeUndefined();
    });
    // test-contract: public-api — a cohort row for the CURRENT generation is the one qualification reads
    it("attaches a cohort verdict recorded for the current generation", () => {
        const state = reduceE2eLedger([pending(G1, 1), pending(G2, 2), cohort(G2, 3)]);
        expect(state.get(KEY)?.cohort).toEqual({ cohortId: "c-1", verdict: "qualified", record: ".interlinked/test-runs/e2e/cohorts/c-1.json" });
    });
});
