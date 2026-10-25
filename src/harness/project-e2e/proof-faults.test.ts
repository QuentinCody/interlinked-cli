// Several recorded faults per controlled-fault proof (2026-10-21). One violation under-samples a requirement: in
// E64, 174 of 296 killed (requirement, test) pairs failed on only one of two blind violations of the same
// requirement. A proof with `faults` is demonstrated only when the designated cases fail under EACH fault, and the
// receipt records every fault's own comparison plus the kill fraction.
import { describe, expect, it } from "vitest";
import { minimalPolicy, type RawPolicy as Raw } from "./__tests__/policy-fixture.js";
import { parseE2ePolicy, proofFaults, type E2eProof } from "./policy.js";
import { emptyReceipt, parseE2eReceipt } from "./receipt.js";
import { aggregateFaultProofs, type SensitivityRecord } from "./sensitivity.js";

function scen(raw: Raw): Raw { return ((raw.projects as Raw[])[0]!.scenarios as Raw[])[0]!; } // SAFETY: minimalPolicy's shape
function withProof(proof: Raw) {
    const raw = minimalPolicy();
    scen(raw).proof = proof;
    return parseE2ePolicy(JSON.stringify(raw)).projects[0]!.scenarios[0]!.proof;
}
const F1 = { id: "drop-save", path: "src/a.js", find: "save()", replace: "", rationale: "persistence is the requirement" };
const F2 = { id: "wrong-row", path: "src/a.js", find: "row", replace: "rows[0]", rationale: "the stored row is the requirement" };
const DESIGNATED = [{ id: "orders.create", outcome: ["files"] }];

function record(identity: string, verdict: SensitivityRecord["verdict"], category: SensitivityRecord["category"], reason: string): SensitivityRecord {
    return {
        mode: "controlled-fault", verdict, category, reasons: [reason], comparison: { kind: "fault", identity, description: `fault ${identity}` },
        designated: [{ id: "orders.create", outcome: ["files"] }], candidate: [{ id: "orders.create", state: "passed" }],
        compared: [{ id: "orders.create", state: verdict === "demonstrated" ? "failed" : "passed" }], lifecycle: { complete: true, reasons: [] },
    };
}

describe("controlled-fault with several faults — policy (positive: accepted)", () => {
    it("P1: `faults` lists 1 to 8 distinct recorded faults; proofFaults reads `fault` and `faults` alike", () => {
        const several = withProof({ mode: "controlled-fault", faults: [F1, F2], designated: DESIGNATED });
        expect(several?.faults?.map(fault => fault.id)).toEqual(["drop-save", "wrong-row"]);
        expect(proofFaults(several as E2eProof).map(fault => fault.id)).toEqual(["drop-save", "wrong-row"]);
        const single = withProof({ mode: "controlled-fault", fault: F1, designated: DESIGNATED });
        expect(proofFaults(single as E2eProof).map(fault => fault.id)).toEqual(["drop-save"]);
        expect(proofFaults({ mode: "old-new", revision: "HEAD" })).toEqual([]);
    });
});

describe("controlled-fault with several faults — policy (negative: refused)", () => {
    it("N1: exactly one of fault / faults; never empty, duplicated, unbounded, or outside controlled-fault", () => {
        expect(() => withProof({ mode: "controlled-fault", fault: F1, faults: [F2], designated: DESIGNATED })).toThrow(/declare fault or faults, not both/);
        expect(() => withProof({ mode: "controlled-fault", faults: [], designated: DESIGNATED })).toThrow(/faults must list 1 to 8 faults/);
        expect(() => withProof({ mode: "controlled-fault", faults: Array.from({ length: 9 }, (_, n) => ({ ...F1, id: `f${n}` })), designated: DESIGNATED })).toThrow(/faults must list 1 to 8 faults/);
        expect(() => withProof({ mode: "controlled-fault", faults: [F1, { ...F2, id: "drop-save" }], designated: DESIGNATED })).toThrow(/faults ids must be unique/);
        expect(() => withProof({ mode: "controlled-fault", faults: [{ ...F1, find: "" }], designated: DESIGNATED })).toThrow(/faults\[0\]\.find must be a non-empty string/);
        expect(() => withProof({ mode: "old-new", revision: "HEAD", faults: [F1], designated: DESIGNATED })).toThrow(/faults is not used for mode old-new/);
        expect(() => withProof({ mode: "controlled-fault", designated: DESIGNATED })).toThrow(/fault is required for mode controlled-fault/);
    });
});

describe("aggregateFaultProofs — the proof needs every fault", () => {
    it("P2: every fault demonstrated ⇒ demonstrated, kill fraction n/n, each fault's identity kept", () => {
        const merged = aggregateFaultProofs([
            record("drop-save@1", "demonstrated", "designated-expectation-mismatch", "a"),
            record("wrong-row@2", "demonstrated", "designated-expectation-mismatch", "b"),
        ]);
        expect(merged).toMatchObject({ mode: "controlled-fault", verdict: "demonstrated", category: "designated-expectation-mismatch", killFraction: { demonstrated: 2, total: 2 } });
        expect(merged.comparison).toEqual({ kind: "fault", identity: "drop-save@1,wrong-row@2", description: "2 recorded faults" });
        expect(merged.faults?.map(row => row.comparison.identity)).toEqual(["drop-save@1", "wrong-row@2"]);
    });

    it("N2: one fault the designated case does not notice ⇒ not demonstrated, the fault named, kill fraction 1/2", () => {
        const merged = aggregateFaultProofs([
            record("drop-save@1", "demonstrated", "designated-expectation-mismatch", "a"),
            record("usage-text@2", "not-demonstrated", "comparison-passes", "both sides pass"),
        ]);
        expect(merged).toMatchObject({ verdict: "not-demonstrated", category: "comparison-passes", killFraction: { demonstrated: 1, total: 2 } });
        expect(merged.reasons).toEqual(["fault usage-text@2 not-demonstrated (comparison-passes): both sides pass", "1 of 2 recorded faults demonstrated"]);
    });

    it("N3: an inconclusive fault with no undemonstrated one ⇒ inconclusive; an incomplete lifecycle stays visible", () => {
        const broken = { ...record("crash@2", "inconclusive", "setup-build-dependency-failure", "import failed"), lifecycle: { complete: false, reasons: ["port still answers"] } };
        const merged = aggregateFaultProofs([record("drop-save@1", "demonstrated", "designated-expectation-mismatch", "a"), broken]);
        expect(merged).toMatchObject({ verdict: "inconclusive", category: "setup-build-dependency-failure", killFraction: { demonstrated: 1, total: 2 } });
        expect(merged.lifecycle).toEqual({ complete: false, reasons: ["fault crash@2: port still answers"] });
    });
});

describe("receipt — the per-fault records survive a read", () => {
    it("P3: a receipt with an aggregated sensitivity record round-trips its faults and kill fraction", () => {
        const receipt = emptyReceipt({ runId: "r1", project: { id: "orders", root: ".", canonicalRoot: "/tmp/x" }, scenarioIds: ["order-persists"], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        receipt.sensitivity = { "order-persists": aggregateFaultProofs([record("drop-save@1", "demonstrated", "designated-expectation-mismatch", "a"), record("wrong-row@2", "not-demonstrated", "comparison-passes", "b")]) };
        const read = parseE2eReceipt(JSON.parse(JSON.stringify(receipt)));
        expect(read.sensitivity?.["order-persists"]?.killFraction).toEqual({ demonstrated: 1, total: 2 });
        expect(read.sensitivity?.["order-persists"]?.faults?.map(row => row.verdict)).toEqual(["demonstrated", "not-demonstrated"]);
    });

    it("N4: a kill fraction that does not add up is refused, never trusted", () => {
        const receipt = emptyReceipt({ runId: "r1", project: { id: "orders", root: ".", canonicalRoot: "/tmp/x" }, scenarioIds: ["order-persists"], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        receipt.sensitivity = { "order-persists": { ...aggregateFaultProofs([record("drop-save@1", "demonstrated", "designated-expectation-mismatch", "a")]), killFraction: { demonstrated: 3, total: 1 } } };
        expect(() => parseE2eReceipt(JSON.parse(JSON.stringify(receipt)))).toThrow(/killFraction/);
    });
});
