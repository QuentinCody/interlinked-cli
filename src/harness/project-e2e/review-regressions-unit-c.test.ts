// Unit C6/C7 pins: cancellation is an explicit unavailable attempt; a receipt
// is published atomically and exactly once; the durability edges the plan
// lists for Unit C (crash, duplicate events, old receipt versions, two
// worktrees) each have a pin here or in the sibling suites they cite.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import { E2E_RUNS_DIRECTORY, emptyReceipt, readE2eReceiptDetailed, writeE2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;

describe("C6 cancellation — negative (an aborted run never passes)", () => {
    it("N1: aborting during a slow prepare step yields a failed prepare result, an unavailable attempt, and an open obligation", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "-e", "setTimeout(Function.prototype, 30000)"] }]; // no braces: `{…}` is the policy's placeholder syntax
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 300);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        expect(result.exitCode).not.toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.prepare[0]).toMatchObject({ ok: false, preview: expect.stringMatching(/^cancelled/) });
        expect(receipt.cases).toEqual([]);
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")?.status).toBe("unavailable");
        expect(evaluateE2e({ root: project.root, atMs: 9 }).verdicts[0]!.satisfied).toBe(false);
    }, TIMEOUT);
});
describe("C7 atomic publication and durability edges", () => {
    it("P1: a receipt is written through a temp file and renamed; no temp file survives and a second publication for the run is refused", () => {
        const project = fixtureProject("py"); projects.push(project);
        const receipt = emptyReceipt({ runId: "atomic-run", project: { id: "orders", root: ".", canonicalRoot: project.root }, scenarioIds: ["order-persists"], policyDigest: "a".repeat(64), generation: "b".repeat(64) });
        receipt.completion.generationAfter = "b".repeat(64);
        const path = writeE2eReceipt(project.root, receipt);
        expect(readE2eReceiptDetailed(project.root, path).receipt?.runId).toBe("atomic-run");
        expect(readdirSync(join(project.root, E2E_RUNS_DIRECTORY, "atomic-run")).filter(name => name.endsWith(".tmp"))).toEqual([]);
        expect(() => writeE2eReceipt(project.root, receipt)).toThrow(/publishes once/);
    });
    it("N1: a foreign receipt version, a torn receipt, and a receipt copied from another worktree are each unavailable, never green", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const receiptPath = join(project.root, result.receipts[0]!.path);
        const original = readFileSync(receiptPath, "utf8");
        writeFileSync(receiptPath, original.replace("\"version\": 1", "\"version\": 2"));
        expect(evaluateE2e({ root: project.root, atMs: 2 }).verdicts[0]!.reasons.map(reason => reason.code)).toContain("RECEIPT_INVALID");
        writeFileSync(receiptPath, original.slice(0, original.length / 2));
        expect(evaluateE2e({ root: project.root, atMs: 3 }).verdicts[0]!.reasons.map(reason => reason.code)).toContain("RECEIPT_INVALID");
        writeFileSync(receiptPath, original.replace(`"canonicalRoot": ${JSON.stringify(project.root)}`, "\"canonicalRoot\": \"/elsewhere/worktree\""));
        expect(evaluateE2e({ root: project.root, atMs: 4 }).verdicts[0]!.reasons.map(reason => reason.code)).toContain("RECEIPT_MISMATCH");
        expect(existsSync(receiptPath)).toBe(true);
    }, TIMEOUT);
});
