import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { readE2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function fresh(language: "ts" | "py", accept = true): FixtureProject { const project = fixtureProject(language, { accept }); projects.push(project); return project; }
const TIMEOUT = 60_000;

describe("runProjectE2e — positive (must qualify)", () => {
    it("P1: builds the TypeScript CLI, drives its public executable, observes the saved file and publishes a satisfied receipt (PE-03, PE-51)", async () => {
        const project = fresh("ts");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, sessionId: "s1" });
        expect(result.status).toBe("configured");
        const verdict = result.verdicts[0]!;
        expect(verdict.reasons).toEqual([]);
        expect(verdict.satisfied).toBe(true);
        const receipt = readE2eReceipt(project.root, result.receipts[0]!.path)!;
        expect(receipt.prepare[0]).toMatchObject({ argv: ["node", "build.mjs"], ok: true });
        expect(receipt.artifacts.map(row => row.path)).toEqual(["dist/cli.js"]);
        expect(receipt.cases.map(row => [row.id, row.state])).toEqual([["orders.create", "passed"], ["orders.invalid", "passed"]]);
        expect(receipt.completion).toMatchObject({ complete: true, inputsChangedDuringRun: false });
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")).toMatchObject({ status: "satisfied", lastRunId: receipt.runId });
        expect(existsSync(join(project.root, "data"))).toBe(false); // the driver ran in a disposable workspace, never the project tree
    }, TIMEOUT);
    it("P2: the interpreted Python path qualifies through the same engine with no prepare step", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.satisfied).toBe(true);
        expect(readE2eReceipt(project.root, result.receipts[0]!.path)?.prepare).toEqual([]);
    }, TIMEOUT);
});
describe("runProjectE2e — negative (must not qualify)", () => {
    it("N1: a persistence defect (success printed, nothing saved) fails the scenario with the file difference named (PE-20, PE-23)", async () => {
        const project = fresh("ts");
        injectPersistenceDefect(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const verdict = result.verdicts[0]!;
        expect(verdict.status).toBe("failed");
        expect(verdict.reasons.map(row => row.code)).toContain("CASE_FAILED");
        expect(verdict.reasons.find(row => row.code === "CASE_FAILED")?.message).toMatch(/data\/orders\.json (differs|cannot be compared)/);
        expect(result.exitCode).toBe(1);
    }, TIMEOUT);
    it("N2: a failed prepare step leaves every case not-run and the run incomplete (PE-24 shape)", async () => {
        const project = fresh("ts");
        writeFileSync(join(project.root, "build.mjs"), "process.exit(3);\n");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.reasons.map(row => row.code)).toEqual(expect.arrayContaining(["PREPARE_FAILED", "RUN_INCOMPLETE", "CASE_NOT_RUN"]));
        expect(result.exitCode).toBe(1);
        const receipt = readE2eReceipt(project.root, result.receipts[0]!.path)!;
        expect(receipt.prepare[0]?.exitCode).toBe(3);
    }, TIMEOUT);
    it("N3: proposed contracts pass execution but the scenario stays review-required (PE-58)", async () => {
        const project = fresh("ts", false);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.verdicts[0]?.dimensions.execution).toBe("passed");
        expect(result.verdicts[0]?.status).toBe("review-required");
        expect(result.verdicts[0]?.reasons.map(row => row.code)).toEqual(["EXPECTATION_PROPOSED"]);
    }, TIMEOUT);
    it("N4: a scenario selection that names an unknown id is refused; unconfigured roots return unconfigured", async () => {
        const project = fresh("ts");
        await expect(runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, scenarioIds: ["ghost"] })).rejects.toThrow(/unknown scenario ghost/);
        rmSync(join(project.root, ".interlinked/e2e-policy.json"));
        expect((await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT })).status).toBe("unconfigured");
    }, TIMEOUT);
    it("N5: the receipt records the initiating session and never a copied report (runId matches ledger)", async () => {
        const project = fresh("py");
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, sessionId: "session-A" });
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.initiator).toBe("session-A");
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")?.lastRunId).toBe(receipt.runId);
    }, TIMEOUT);
});
