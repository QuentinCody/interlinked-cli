import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_POLICY } from "../contracts/paths.js";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { expectationRevision, type ExpectationDraft } from "./expectations.js";
import { readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { digestOf, loadE2ePolicy } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { acceptExpectationInStore, proposeExpectationInStore, replaceExpectationInStore, reviewExpectations } from "./store.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 60_000;
function draft(root: string, extra: Partial<ExpectationDraft> = {}): ExpectationDraft {
    const requirement = readFileSync(join(root, "REQUIREMENTS.md"), "utf8");
    return {
        id: "persist-order", projectId: "orders", scenarioIds: ["order-persists"], statement: "add persists the order so a later invocation reads it back", origin: "user-requirement",
        sources: [{ kind: "requirement", path: "REQUIREMENTS.md", sha256: digestOf(requirement), quote: "persists the order so a later invocation can read it back" }],
        assumptions: ["one order per invocation"], questions: [], examples: { positive: ["add widget → data file lists widget"], negative: ["add widget → data file absent"] }, contractIds: ["orders.create", "orders.invalid"], ...extra,
    };
}

describe("expectation store — lifecycle over real files", () => {
    it("P1: propose writes the record proposed and binds it to the scenario; nothing is accepted in contract-policy", () => {
        const project = fixtureProject("py"); projects.push(project);
        const result = proposeExpectationInStore(project.root, draft(project.root), 10);
        expect(result.expectation.lifecycle).toBe("proposed");
        expect(result.sources).toEqual([{ path: "REQUIREMENTS.md", provenance: "matched" }]);
        const loaded = loadE2ePolicy(project.root);
        expect(loaded.status === "configured" && loaded.policy.projects[0]?.scenarios[0]?.expectationIds).toEqual(["persist-order"]);
        expect(readFileSync(join(project.root, CONTRACT_POLICY), "utf8")).toMatch(/"accepted":\s*\{\}/);
    });
    it("P2: accept binds the exact revision, records the linked contract digests as configured acceptance, and a green run then satisfies (PE-60 positive)", async () => {
        const project = fixtureProject("py"); projects.push(project);
        const proposed = proposeExpectationInStore(project.root, draft(project.root), 10);
        const accepted = acceptExpectationInStore(project.root, { expectationId: "persist-order", revision: proposed.expectation.revision, rationale: "matches R1" }, 20);
        expect(accepted.expectation.lifecycle).toBe("accepted");
        expect(Object.keys(accepted.acceptedContractDigests)).toHaveLength(2);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.satisfied).toBe(true);
    }, TIMEOUT);
    it("N1: a stale before-digest is refused atomically — neither policy nor contract-policy changes (PE-60)", () => {
        const project = fixtureProject("py"); projects.push(project);
        proposeExpectationInStore(project.root, draft(project.root), 10);
        const policyBefore = readFileSync(join(project.root, ".interlinked/e2e-policy.json"), "utf8");
        expect(() => acceptExpectationInStore(project.root, { expectationId: "persist-order", revision: "0".repeat(64), rationale: "x" }, 20)).toThrow(/does not match/);
        expect(readFileSync(join(project.root, ".interlinked/e2e-policy.json"), "utf8")).toBe(policyBefore);
        expect(readFileSync(join(project.root, CONTRACT_POLICY), "utf8")).toMatch(/"accepted":\s*\{\}/);
    });
    it("P3: replace supersedes, re-binds the scenario to the replacement and invalidates the scenario's satisfied result (PE-61)", async () => {
        const project = fixtureProject("py"); projects.push(project);
        const proposed = proposeExpectationInStore(project.root, draft(project.root), 10);
        acceptExpectationInStore(project.root, { expectationId: "persist-order", revision: proposed.expectation.revision, rationale: "ok" }, 20);
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")?.status).toBe("satisfied");
        const replaced = replaceExpectationInStore(project.root, { expectationId: "persist-order", revision: expectationRevision(draft(project.root)), rationale: "user corrected: refunds are manual", replacement: draft(project.root, { id: "persist-order-v2", assumptions: ["refunds are manual"] }) }, 30);
        expect(replaced.expectation.lifecycle).toBe("proposed");
        const loaded = loadE2ePolicy(project.root);
        expect(loaded.status === "configured" && loaded.policy.projects[0]?.scenarios[0]?.expectationIds).toEqual(["persist-order-v2"]);
        expect(loaded.status === "configured" && loaded.policy.expectations.find(row => row.id === "persist-order")?.lifecycle).toBe("superseded");
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")?.status).toBe("pending");
    }, TIMEOUT);
    it("P4: review lists proposed records with questions, source provenance and a diff against the superseded record (PE-62 shape)", () => {
        const project = fixtureProject("py"); projects.push(project);
        proposeExpectationInStore(project.root, draft(project.root, { id: "cancel-refund", questions: ["Are refunds automatic after cancellation?"], statement: "cancelling refunds automatically", origin: "agent-inference" }), 10);
        writeFileSync(join(project.root, "REQUIREMENTS.md"), "changed\n");
        const review = reviewExpectations(project.root);
        expect(review.map(row => [row.expectation.id, row.expectation.lifecycle, row.sources[0]?.provenance])).toEqual([["cancel-refund", "proposed", "stale"]]);
        expect(review[0]?.expectation.questions).toEqual(["Are refunds automatic after cancellation?"]);
    });
});
