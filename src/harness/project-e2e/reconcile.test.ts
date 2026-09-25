import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { minimalPolicy, type RawPolicy } from "./__tests__/policy-fixture.js";
import { readE2eTxns, reduceE2eLedger, scenarioKey } from "./ledger.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { formatReconcileMessages, reconcileChanges } from "./reconcile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(patch: (raw: RawPolicy) => void = () => {}): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-reconcile-"))); roots.push(root);
    mkdirSync(join(root, "src/orders"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    writeFileSync(join(root, "src/orders/create.js"), "1\n");
    writeFileSync(join(root, "src/unmapped.js"), "2\n");
    writeFileSync(join(root, "docs/README.md"), "docs\n");
    const raw = minimalPolicy();
    ((raw.projects as RawPolicy[])[0]!.scenarios as RawPolicy[])[0]!.affects = ["src/orders/**"];
    patch(raw);
    writeFileSync(join(root, E2E_POLICY_PATH), JSON.stringify(raw));
    writeFileSync(join(root, ".interlinked/behavioral-contracts.json"), JSON.stringify({ version: 1, cases: [{ id: "orders.create", description: "d", source: { kind: "example", path: "docs/README.md", sha256: "a".repeat(64), quote: "docs" }, inputs: [], runner: { kind: "process", argv: ["node", "-e", "1"] }, expect: { exitCode: 0 } }] }));
    return root;
}
const KEY = scenarioKey("orders", "order-persists");

describe("reconcileChanges — positive (must open obligations)", () => {
    it("P1: a relevant edit opens a pending obligation at the current generation and writes the ledger", () => {
        const root = setup();
        const result = reconcileChanges({ root, changedPaths: ["src/orders/create.js"], sessionId: "s1", atMs: 10 });
        expect(result.status).toBe("configured");
        expect(result.pending.map(row => row.key)).toEqual([KEY]);
        expect(reduceE2eLedger(readE2eTxns(root)).get(KEY)?.status).toBe("pending");
        expect(formatReconcileMessages(result)[0]).toMatch(/orders: order-persists needs current e2e evidence after src\/orders\/create\.js changed/);
        expect(formatReconcileMessages(result)[0]).toContain("interlinked tests e2e run --project orders --scenario order-persists");
    });
    it("P2: an edit made through any tool is the same obligation; an unchanged generation is not re-opened (PE-17)", () => {
        const root = setup();
        reconcileChanges({ root, changedPaths: ["src/orders/create.js"], atMs: 10 });
        const again = reconcileChanges({ root, changedPaths: ["src/orders/create.js"], atMs: 11 });
        expect(again.pending).toEqual([]);
        expect(readE2eTxns(root)).toHaveLength(1);
    });
    it("P3: a policy or contract-manifest change re-evaluates every scenario of the project (PE-06)", () => {
        const root = setup();
        const result = reconcileChanges({ root, changedPaths: [".interlinked/behavioral-contracts.json"], atMs: 10 });
        expect(result.pending.map(row => row.key)).toEqual([KEY]);
    });
    it("P4: a shared input invalidates all scenarios of the project (PE-45)", () => {
        const root = setup(raw => { (raw.projects as RawPolicy[])[0]!.sharedInputs = ["package.json"]; });
        writeFileSync(join(root, "package.json"), "{}\n");
        expect(reconcileChanges({ root, changedPaths: ["package.json"], atMs: 10 }).pending.map(row => row.key)).toEqual([KEY]);
    });
    it("P5: changedPaths 'all' evaluates every scenario against the ledger (startup reconciliation, PE-18)", () => {
        const root = setup();
        expect(reconcileChanges({ root, changedPaths: "all", atMs: 10 }).pending.map(row => row.key)).toEqual([KEY]);
    });
});
describe("reconcileChanges — negative (must not open obligations)", () => {
    it("N1: a docs edit outside every declared input opens nothing (PE-16)", () => {
        const root = setup();
        const result = reconcileChanges({ root, changedPaths: ["docs/README.md"], atMs: 10 });
        expect(result.pending).toEqual([]);
        expect(result.mappingGaps).toEqual([]);
        expect(readE2eTxns(root)).toEqual([]);
    });
    it("N2: a protected file no scenario maps is a mapping gap, not a silent pass (PE-15)", () => {
        const root = setup();
        const result = reconcileChanges({ root, changedPaths: ["src/unmapped.js"], atMs: 10 });
        expect(result.mappingGaps).toEqual([{ projectId: "orders", path: "src/unmapped.js" }]);
        expect(formatReconcileMessages(result)[0]).toMatch(/needs-mapping/);
    });
    it("N3: without a policy the result is unconfigured and nothing is written", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "e2e-reconcile-"))); roots.push(root);
        expect(reconcileChanges({ root, changedPaths: ["src/x.js"], atMs: 1 }).status).toBe("unconfigured");
        expect(readE2eTxns(root)).toEqual([]);
    });
    it("N4: a dry run reports pending work but never writes the ledger", () => {
        const root = setup();
        const result = reconcileChanges({ root, changedPaths: ["src/orders/create.js"], atMs: 10, dryRun: true });
        expect(result.pending).toHaveLength(1);
        expect(readE2eTxns(root)).toEqual([]);
    });
});
