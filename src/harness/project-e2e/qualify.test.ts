import { describe, expect, it } from "vitest";
import { minimalPolicy } from "./__tests__/policy-fixture.js";
import { expectationRevision, proposeExpectation } from "./expectations.js";
import type { E2eObligationState } from "./ledger.js";
import { parseE2ePolicy, type E2ePolicy } from "./policy.js";
import { exitCodeFor, qualifyScenario, type QualifyInput, type ScenarioVerdict } from "./qualify.js";
import { emptyReceipt, type E2eReceipt, type ReceiptCase } from "./receipt.js";

const G = "1".repeat(64), G2 = "2".repeat(64), P = "p".repeat(64);
function policyWith(expectation = false): E2ePolicy {
    const policy = parseE2ePolicy(JSON.stringify(minimalPolicy()));
    if (!expectation) return policy;
    const next = proposeExpectation(policy, { id: "exp-1", projectId: "orders", scenarioIds: ["order-persists"], statement: "orders persist", origin: "user-requirement", sources: [], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create"] }, 1);
    next.projects[0]!.scenarios[0]!.expectationIds = ["exp-1"];
    return next;
}
function caseRow(extra: Partial<ReceiptCase> = {}): ReceiptCase {
    return { id: "orders.create", digest: "d".repeat(64), authority: "configured", provenance: "matched", state: "passed", runnerKind: "process", details: [], ...extra };
}
function receiptWith(extra: Partial<E2eReceipt> = {}, cases: ReceiptCase[] = [caseRow()]): E2eReceipt {
    const base = emptyReceipt({ runId: "run-1", project: { id: "orders", root: ".", canonicalRoot: "/repo" }, scenarioIds: ["order-persists"], policyDigest: P, generation: G });
    return { ...base, cases, selection: { required: ["orders.create"], observed: cases.map(row => row.id) }, completion: { ...base.completion, generationAfter: G, complete: true }, ...extra };
}
function state(extra: Partial<E2eObligationState> = {}): E2eObligationState {
    return { key: "orders/order-persists", generation: G, status: "satisfied", reason: "", updatedAtMs: 2, attempts: 1, lastRunId: "run-1", lastReceipt: ".interlinked/test-runs/e2e/run-1/receipt.json", ...extra };
}
function input(extra: Partial<QualifyInput> = {}): QualifyInput {
    const policy = policyWith();
    return { policy, project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]!, policyDigest: P, generation: { generation: G, gaps: [] }, state: state(), receipt: receiptWith(), ...extra };
}
function reasons(verdict: ScenarioVerdict): string[] { return verdict.reasons.map(row => row.code); }

describe("qualifyScenario — positive (must satisfy)", () => {
    it("P1: accepted contract, passing case, matching generation and complete run is satisfied", () => {
        const verdict = qualifyScenario(input());
        expect(verdict.satisfied).toBe(true);
        expect(verdict.status).toBe("satisfied");
        expect(verdict.dimensions).toEqual({ authority: "accepted", execution: "passed", boundary: "process-driver", provenance: "matched", scope: "complete", completion: "complete", sensitivity: "not-required", stability: "not-required", observations: "not-required" });
    });
    it("P2: an accepted expectation bound to the scenario satisfies the authority dimension", () => {
        const policy = policyWith(true);
        const revision = expectationRevision(policy.expectations[0]!);
        policy.expectations[0]!.lifecycle = "accepted";
        const verdict = qualifyScenario(input({ policy, project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]!, receipt: receiptWith({ authority: [{ expectationId: "exp-1", lifecycle: "accepted", origin: "user-requirement", revision }] }) }));
        expect(verdict.satisfied).toBe(true);
    });
    it("P3: a non-required scenario reports its dimensions but never gates (exit 0 for NOT_APPLICABLE)", () => {
        const policy = policyWith();
        policy.projects[0]!.scenarios[0]!.required = false;
        const verdict = qualifyScenario(input({ policy, project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]!, state: undefined, receipt: null }));
        expect(verdict.required).toBe(false);
        expect(exitCodeFor([verdict])).toBe(0);
    });
});

describe("qualifyScenario — negative (must not satisfy)", () => {
    it("N1: no evidence at all is pending with NO_EVIDENCE (exit 1)", () => {
        const verdict = qualifyScenario(input({ state: undefined, receipt: null }));
        expect(verdict.satisfied).toBe(false);
        expect(reasons(verdict)).toEqual(["NO_EVIDENCE"]);
        expect(exitCodeFor([verdict])).toBe(1);
    });
    it("N2: a receipt for an older generation is STALE_GENERATION (PE-04)", () => {
        const verdict = qualifyScenario(input({ generation: { generation: G2, gaps: [] }, state: state({ generation: G2, status: "pending" }) }));
        expect(reasons(verdict)).toContain("STALE_GENERATION");
    });
    it("N3: a receipt whose runId differs from the ledger's attempt is RECEIPT_MISMATCH (PE-10)", () => {
        const verdict = qualifyScenario(input({ receipt: receiptWith({ runId: "run-copied" }) }));
        expect(reasons(verdict)).toContain("RECEIPT_MISMATCH");
    });
    it("N4: a receipt from another project or worktree is rejected (PE-11)", () => {
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({ project: { id: "billing", root: ".", canonicalRoot: "/repo" } }) })))).toContain("RECEIPT_MISMATCH");
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({ policyDigest: "q".repeat(64) }) })))).toContain("STALE_POLICY");
    });
    it("N5: failed, unavailable, stale, and not-run cases each keep the obligation open with their own code (PE-07, PE-08)", () => {
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ state: "failed" })]) })))).toContain("CASE_FAILED");
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ state: "unavailable" })]) })))).toContain("CASE_UNAVAILABLE");
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ state: "stale" })]) })))).toContain("CASE_STALE");
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({}, []) })))).toContain("CASE_NOT_RUN");
    });
    it("N6: a proposed (unaccepted) CONTRACT passes execution but stays review-required (PE-58)", () => {
        const proposedCase = qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ authority: "proposed" })]) }));
        expect(proposedCase.satisfied).toBe(false);
        expect(reasons(proposedCase)).toEqual(["EXPECTATION_PROPOSED"]);
        expect(proposedCase.dimensions.execution).toBe("passed");
        expect(proposedCase.status).toBe("review-required");
    });
    it("N6b: a bound proposed EXPECTATION is an advisory note by default and blocks only under gates.review require (§6.4, R11)", () => {
        const policy = policyWith(true);
        const advisory = qualifyScenario(input({ policy, project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]! }));
        expect(advisory.satisfied).toBe(true);
        expect(advisory.dimensions.authority).toBe("proposed");
        expect(advisory.advisories[0]).toMatch(/expectation exp-1 is proposed/);
        policy.projects[0]!.gates = { review: "require" };
        const gated = qualifyScenario(input({ policy, project: policy.projects[0]!, scenario: policy.projects[0]!.scenarios[0]! }));
        expect(reasons(gated)).toEqual(["EXPECTATION_PROPOSED"]);
        expect(gated.status).toBe("review-required");
    });
    it("N6c: a receipt from another worktree root is rejected even when everything else matches (R4)", () => {
        expect(reasons(qualifyScenario(input({ canonicalRoot: "/other/worktree" })))).toContain("RECEIPT_MISMATCH");
        expect(qualifyScenario(input({ canonicalRoot: "/repo" })).satisfied).toBe(true);
    });
    it("N6d: a receipt the reader could not validate is RECEIPT_INVALID (unavailable), not NO_EVIDENCE and never green (R5)", () => {
        const verdict = qualifyScenario(input({ receipt: null, receiptIssue: "receipt.cases[0].state must be one of passed, failed, unavailable, stale, not-run; got \"skipped\"" }));
        expect(reasons(verdict)).toEqual(["RECEIPT_INVALID"]);
        expect(verdict.status).toBe("unavailable");
        expect(exitCodeFor([verdict])).toBe(2);
    });
    it("N7: a contract whose expectation contradicts its cited example is CONTRACT_CONFLICT (PE-32)", () => {
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ provenance: "conflict", state: "not-run" })]) })))).toContain("CONTRACT_CONFLICT");
    });
    it("N8: incomplete scope, failed preparation, inputs changed during the run, and an incomplete run each refuse (PE-05, PE-26)", () => {
        expect(reasons(qualifyScenario(input({ generation: { generation: G, gaps: ["contract manifest x is absent"] } })))).toContain("SCOPE_INCOMPLETE");
        expect(reasons(qualifyScenario(input({ receipt: receiptWith({ prepare: [{ argv: ["node", "build.mjs"], exitCode: 1, ok: false, durationMs: 1, stdoutSha256: "", stderrSha256: "", preview: "" }] }) })))).toContain("PREPARE_FAILED");
        const changed = receiptWith();
        changed.completion = { ...changed.completion, generationAfter: G2, inputsChangedDuringRun: true };
        expect(reasons(qualifyScenario(input({ receipt: changed })))).toContain("INPUTS_CHANGED_DURING_RUN");
        const incomplete = receiptWith();
        incomplete.completion = { ...incomplete.completion, complete: false };
        expect(reasons(qualifyScenario(input({ receipt: incomplete })))).toContain("RUN_INCOMPLETE");
    });
    it("N9: an HTTP-runner case cannot certify any boundary until a managed service adapter ships (R3)", () => {
        const verdict = qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ runnerKind: "http" })]) }));
        expect(reasons(verdict)).toContain("BOUNDARY_UNSUPPORTED");
        expect(verdict.dimensions.boundary).toBe("unsupported");
        expect(exitCodeFor([verdict])).toBe(2);
    });
    it("N10: exit contract — unavailable evidence is 2, a measured failure is 1, satisfied is 0", () => {
        const unavailable = qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ state: "unavailable" })]) }));
        expect(exitCodeFor([unavailable])).toBe(2);
        const failed = qualifyScenario(input({ receipt: receiptWith({}, [caseRow({ state: "failed" })]) }));
        expect(exitCodeFor([failed, qualifyScenario(input())])).toBe(1);
        expect(exitCodeFor([qualifyScenario(input())])).toBe(0);
    });
});
