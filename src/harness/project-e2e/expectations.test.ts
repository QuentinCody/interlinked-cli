import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptExpectation, disputeExpectation, expectationDiff, expectationRevision, inspectExpectationSources, proposeExpectation, replaceExpectation, type ExpectationDraft } from "./expectations.js";
import { digestOf, parseE2ePolicy, type E2ePolicy } from "./policy.js";
import { minimalPolicy } from "./__tests__/policy-fixture.js";

const REQ = "Cancelling an unshipped order must preserve its audit record.";
function draft(extra: Partial<ExpectationDraft> = {}): ExpectationDraft {
    return {
        id: "cancel-keeps-audit", projectId: "orders", scenarioIds: ["order-persists"], statement: "cancelling an unshipped order keeps its audit record",
        origin: "user-requirement", sources: [{ kind: "requirement", path: "REQ.md", sha256: digestOf(REQ), quote: "preserve its audit record" }],
        assumptions: ["orders are unshipped at cancellation"], questions: ["Are refunds automatic after cancellation?"],
        examples: { positive: ["cancel #1 then read audit #1"], negative: ["cancel #1 then audit #1 absent"] }, contractIds: ["orders.create"], ...extra,
    };
}
function policy(): E2ePolicy { return parseE2ePolicy(JSON.stringify(minimalPolicy())); }
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("propose — positive (must record)", () => {
    it("P1: a proposal starts proposed with a revision digest and a propose review", () => {
        const next = proposeExpectation(policy(), draft(), 10);
        const row = next.expectations[0]!;
        expect(row.lifecycle).toBe("proposed");
        expect(row.revision).toBe(expectationRevision(draft()));
        expect(row.history).toEqual([{ atMs: 10, action: "propose", revision: row.revision, rationale: "proposed", authority: "configured" }]);
        expect(() => parseE2ePolicy(JSON.stringify(next))).not.toThrow();
    });
    it("P2: the revision ignores lifecycle and history but changes with the statement", () => {
        expect(expectationRevision(draft())).toBe(expectationRevision(draft()));
        expect(expectationRevision(draft({ statement: "other" }))).not.toBe(expectationRevision(draft()));
    });
});
describe("propose — negative (must refuse)", () => {
    it("N1: refuses a duplicate id and an unknown scenario", () => {
        const once = proposeExpectation(policy(), draft(), 10);
        expect(() => proposeExpectation(once, draft(), 11)).toThrow(/already exists/);
        expect(() => proposeExpectation(policy(), draft({ scenarioIds: ["ghost"] }), 10)).toThrow(/unknown scenario/);
    });
});

describe("accept — positive", () => {
    it("P3: acceptance binds the exact revision and records configured authority only", () => {
        const proposed = proposeExpectation(policy(), draft(), 10);
        const revision = proposed.expectations[0]!.revision;
        const { policy: accepted, contractIds } = acceptExpectation(proposed, { expectationId: "cancel-keeps-audit", revision, rationale: "matches REQ.md" }, 20);
        expect(accepted.expectations[0]?.lifecycle).toBe("accepted");
        expect(accepted.expectations[0]?.history.at(-1)).toMatchObject({ action: "accept", authority: "configured", rationale: "matches REQ.md" });
        expect(contractIds).toEqual(["orders.create"]);
    });
});
describe("accept — negative", () => {
    it("N2: a stale before-digest is refused atomically (PE-60)", () => {
        const proposed = proposeExpectation(policy(), draft(), 10);
        expect(() => acceptExpectation(proposed, { expectationId: "cancel-keeps-audit", revision: "f".repeat(64), rationale: "x" }, 20)).toThrow(/revision .* does not match/);
        expect(proposed.expectations[0]?.lifecycle).toBe("proposed");
    });
    it("N3: an unknown expectation or an already superseded one cannot be accepted", () => {
        expect(() => acceptExpectation(policy(), { expectationId: "ghost", revision: "a".repeat(64), rationale: "x" }, 1)).toThrow(/unknown expectation/);
        const proposed = proposeExpectation(policy(), draft(), 10);
        const replaced = replaceExpectation(proposed, { expectationId: "cancel-keeps-audit", revision: proposed.expectations[0]!.revision, rationale: "refunds decided", replacement: draft({ id: "cancel-keeps-audit-v2", questions: [] }) }, 30).policy;
        expect(() => acceptExpectation(replaced, { expectationId: "cancel-keeps-audit", revision: proposed.expectations[0]!.revision, rationale: "x" }, 40)).toThrow(/superseded/);
    });
});

describe("replace and dispute", () => {
    it("P4: replacement supersedes the old record, keeps its history and proposes the new one (PE-61)", () => {
        const proposed = proposeExpectation(policy(), draft(), 10);
        const revision = proposed.expectations[0]!.revision;
        const { policy: replaced, affectedScenarioIds } = replaceExpectation(proposed, { expectationId: "cancel-keeps-audit", revision, rationale: "user corrected the refund assumption", replacement: draft({ id: "cancel-keeps-audit-v2", questions: [] }) }, 30);
        const old = replaced.expectations.find(row => row.id === "cancel-keeps-audit")!;
        expect(old.lifecycle).toBe("superseded");
        expect(old.supersededBy).toBe("cancel-keeps-audit-v2");
        expect(old.history.map(row => row.action)).toEqual(["propose", "replace"]);
        expect(replaced.expectations.find(row => row.id === "cancel-keeps-audit-v2")?.lifecycle).toBe("proposed");
        expect(affectedScenarioIds).toEqual(["order-persists"]);
    });
    it("P5: dispute keeps the record but removes its authority", () => {
        const accepted = acceptExpectation(proposeExpectation(policy(), draft(), 10), { expectationId: "cancel-keeps-audit", revision: expectationRevision(draft()), rationale: "ok" }, 20).policy;
        const disputed = disputeExpectation(accepted, { expectationId: "cancel-keeps-audit", revision: expectationRevision(draft()), rationale: "refund semantics contradict" }, 30).policy;
        expect(disputed.expectations[0]?.lifecycle).toBe("disputed");
    });
    it("N4: replacement with a stale revision or a clashing new id is refused", () => {
        const proposed = proposeExpectation(policy(), draft(), 10);
        expect(() => replaceExpectation(proposed, { expectationId: "cancel-keeps-audit", revision: "0".repeat(64), rationale: "x", replacement: draft({ id: "v2" }) }, 30)).toThrow(/does not match/);
        expect(() => replaceExpectation(proposed, { expectationId: "cancel-keeps-audit", revision: proposed.expectations[0]!.revision, rationale: "x", replacement: draft() }, 30)).toThrow(/already exists/);
    });
});

describe("review diff and source provenance", () => {
    it("P6: expectationDiff lists changed fields with before/after values", () => {
        const before = proposeExpectation(policy(), draft(), 10).expectations[0]!;
        const after = proposeExpectation(policy(), draft({ statement: "cancelling keeps audit and refunds", questions: [] }), 10).expectations[0]!;
        const diff = expectationDiff(before, after);
        expect(diff.map(row => row.field).sort()).toEqual(["questions", "statement"]);
        expect(diff.find(row => row.field === "statement")).toMatchObject({ before: before.statement, after: after.statement });
    });
    it("P7/N5: source provenance is matched for exact bytes, stale for changed bytes and unavailable for a missing file (PE-59)", () => {
        const root = mkdtempSync(join(tmpdir(), "e2e-exp-")); roots.push(root);
        writeFileSync(join(root, "REQ.md"), REQ);
        const row = proposeExpectation(policy(), draft(), 10).expectations[0]!;
        expect(inspectExpectationSources(root, row)).toEqual([{ path: "REQ.md", provenance: "matched" }]);
        writeFileSync(join(root, "REQ.md"), `${REQ} Refunds are automatic.`);
        expect(inspectExpectationSources(root, row)[0]?.provenance).toBe("stale");
        rmSync(join(root, "REQ.md"));
        expect(inspectExpectationSources(root, row)[0]?.provenance).toBe("unavailable");
    });
});
