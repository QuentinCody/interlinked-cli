// Unit A acceptance (plan 31 §16 steps 1–8) over the three external fixture
// projects. Every step goes through the public engine surfaces a host project
// would use; nothing here imports Interlinked's own e2e boundary list.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { fixtureProject, injectPersistenceDefect, touchSource, type FixtureLanguage, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { expectationRevision, type ExpectationDraft } from "./expectations.js";
import { collectProjectE2eWarnings } from "./hooks.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { digestOf } from "./policy.js";
import { runProjectE2e } from "./run.js";
import { acceptExpectationInStore, proposeExpectationInStore, replaceExpectationInStore, reviewExpectations } from "./store.js";

const TIMEOUT = 120_000;
const KEY = "orders/order-persists";
const cargoPresent = spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;

function draft(root: string, extra: Partial<ExpectationDraft> = {}): ExpectationDraft {
    return {
        id: "persist-order", projectId: "orders", scenarioIds: ["order-persists"], statement: "add persists the order so a later invocation reads it back", origin: "user-requirement",
        sources: [{ kind: "requirement", path: "REQUIREMENTS.md", sha256: digestOf(readFileSync(join(root, "REQUIREMENTS.md"), "utf8")), quote: "persists the order so a later invocation can read it back" }],
        assumptions: ["a single order per invocation"], questions: [], examples: { positive: ["add widget → data lists widget"], negative: ["add widget → data absent"] }, contractIds: ["orders.create", "orders.invalid"], ...extra,
    };
}
function edit(project: FixtureProject): string[] {
    const event: HarnessEvent = { hook_event: "PostToolUse", session_id: "agent-1", agent_source: "claude", tool_name: "Edit", cwd: project.root, timestamp: new Date().toISOString(), tool_input: { file_path: join(project.root, project.sourceFile) } };
    return collectProjectE2eWarnings(event);
}
function codes(root: string): string[] {
    return evaluateE2e({ root, atMs: Date.now() }).verdicts[0]!.reasons.map(row => row.code);
}

for (const language of ["ts", "py"] as FixtureLanguage[]) {
    describe(`Unit A lifecycle — ${language} fixture`, () => {
        let project: FixtureProject;
        let revision = "";
        beforeAll(() => { project = fixtureProject(language); });
        afterAll(() => { rmSync(project.root, { recursive: true, force: true }); });

        it("step 1a: an agent-authored expectation starts proposed with sources and assumptions; a green run cannot accept it", () => {
            const proposed = proposeExpectationInStore(project.root, draft(project.root), 1);
            revision = proposed.expectation.revision;
            expect(proposed.expectation.lifecycle).toBe("proposed");
            expect(proposed.sources).toEqual([{ path: "REQUIREMENTS.md", provenance: "matched" }]);
            const verdict = evaluateE2e({ root: project.root, atMs: Date.now() }).verdicts[0]!;
            expect(verdict.reasons.map(row => row.code)).toEqual(["NO_EVIDENCE"]);
            expect(verdict.dimensions.authority).toBe("proposed");
            expect(verdict.advisories[0]).toMatch(/persist-order is proposed/);
        });
        it("step 1b: a configured decision accepts the exact digest without claiming a human identity; a product edit opens the obligation", () => {
            const accepted = acceptExpectationInStore(project.root, { expectationId: "persist-order", revision, rationale: "matches REQUIREMENTS.md R1" }, 2);
            expect(accepted.expectation.history.at(-1)).toMatchObject({ action: "accept", authority: "configured" });
            touchSource(project);
            const warnings = edit(project);
            expect(warnings[0]).toMatch(/order-persists needs current e2e evidence/);
            expect(reduceE2eLedger(readE2eTxns(project.root)).get(KEY)?.status).toBe("pending");
        });
        it("step 2: a unit-only run does not satisfy the scenario (PE-02)", () => {
            if (language === "py") {
                const unit = spawnSync("python3", ["-m", "unittest", "discover", "-s", "tests"], { cwd: project.root, encoding: "utf8", env: { ...process.env, PYTHONPATH: project.root } });
                expect(unit.status, unit.stderr).toBe(0);
            }
            const evaluation = evaluateE2e({ root: project.root, atMs: Date.now() });
            expect(evaluation.verdicts[0]?.status).toBe("pending");
            expect(evaluation.exitCode).toBe(1);
        });
        it("step 3/4: a supervised process-contract run invokes the current CLI, checks output plus the saved file, and clears exactly this generation (PE-03)", async () => {
            const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, sessionId: "agent-1" });
            expect(result.verdicts[0]?.satisfied).toBe(true);
            expect(result.exitCode).toBe(0);
            expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).toBe(0);
        }, TIMEOUT);
        it("step 5: another relevant edit makes the result stale (PE-04)", () => {
            touchSource(project);
            expect(edit(project)).toHaveLength(1);
            expect(codes(project.root)).toContain("STALE_GENERATION");
            expect(evaluateE2e({ root: project.root, atMs: Date.now() }).exitCode).toBe(1);
        });
        it("step 6: an intentional persistence defect fails the scenario (PE-20, PE-23)", async () => {
            injectPersistenceDefect(project);
            edit(project);
            const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
            expect(result.verdicts[0]?.status).toBe("failed");
            expect(result.exitCode).toBe(1);
        }, TIMEOUT);
        it("step 7a: a zero-exit executable that prints invented pass text does not clear it (PE-09)", async () => {
            const path = join(project.root, project.sourceFile);
            writeFileSync(path, language === "py" ? "print('all tests passed')\n" : "console.log('all tests passed');\n");
            edit(project);
            const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
            expect(result.verdicts[0]?.status).toBe("failed");
            expect(result.verdicts[0]?.reasons.map(row => row.code)).toContain("CASE_FAILED");
        }, TIMEOUT);
        it("step 7b: an old receipt copied into a new run directory is rejected by run identity (PE-10)", async () => {
            cpSync(join(project.root, "REQUIREMENTS.md"), join(project.root, "REQUIREMENTS.md.bak"));
            const restore = fixtureProject(language);
            cpSync(join(restore.root, project.sourceFile), join(project.root, project.sourceFile));
            rmSync(restore.root, { recursive: true, force: true });
            edit(project);
            const good = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
            expect(good.exitCode).toBe(0);
            touchSource(project);
            edit(project);
            const state = reduceE2eLedger(readE2eTxns(project.root)).get(KEY)!;
            const forgedDirectory = join(project.root, ".interlinked/test-runs/e2e/forged-run");
            mkdirSync(forgedDirectory, { recursive: true });
            cpSync(join(project.root, good.receipts[0]!.path), join(forgedDirectory, "receipt.json"));
            appendE2eTxn(project.root, { op: "attempt", key: KEY, generation: state.generation, runId: "forged-run", status: "passed", atMs: Date.now(), receipt: ".interlinked/test-runs/e2e/forged-run/receipt.json", reason: "forged" });
            const verdict = evaluateE2e({ root: project.root, atMs: Date.now() }).verdicts[0]!;
            expect(verdict.satisfied).toBe(false);
            expect(verdict.reasons.map(row => row.code)).toEqual(expect.arrayContaining(["RECEIPT_MISMATCH", "STALE_GENERATION"]));
        }, TIMEOUT);
        it("step 8: a green run does not accept a second proposed expectation (visible, not mandatory); a corrected expectation invalidates the result and keeps the history (PE-58, PE-61, PE-62, R11)", async () => {
            proposeExpectationInStore(project.root, draft(project.root, { id: "cancel-refund", statement: "cancelling an order refunds it automatically", origin: "agent-inference", questions: ["Are refunds automatic after cancellation?"] }), 3);
            const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
            expect(result.verdicts[0]?.dimensions.execution).toBe("passed");
            expect(result.verdicts[0]?.dimensions.authority).toBe("proposed");
            expect(result.verdicts[0]?.satisfied).toBe(true); // settled work proceeds; the proposal stays visible as an advisory
            expect(result.verdicts[0]?.advisories[0]).toMatch(/cancel-refund is proposed/);
            expect(reviewExpectations(project.root).find(row => row.expectation.id === "cancel-refund")?.expectation.questions).toEqual(["Are refunds automatic after cancellation?"]);
            const replaced = replaceExpectationInStore(project.root, { expectationId: "cancel-refund", revision: expectationRevision(draft(project.root, { id: "cancel-refund", statement: "cancelling an order refunds it automatically", origin: "agent-inference", questions: ["Are refunds automatic after cancellation?"] })), rationale: "user: refunds are manual; cancellation must keep the audit record", replacement: draft(project.root, { id: "cancel-keeps-audit", statement: "cancelling an unshipped order keeps its audit record", questions: [] }) }, 4);
            expect(replaced.expectation.lifecycle).toBe("proposed");
            const review = reviewExpectations(project.root).find(row => row.expectation.id === "cancel-keeps-audit");
            expect(review?.diff?.map(row => row.field)).toEqual(expect.arrayContaining(["statement", "questions"]));
            expect(reduceE2eLedger(readE2eTxns(project.root)).get(KEY)?.status).toBe("pending");
            expect(existsSync(join(project.root, "REQUIREMENTS.md.bak"))).toBe(true);
        }, TIMEOUT);
    });
}

describe("Unit A lifecycle — rust fixture (compiled route)", () => {
    let project: FixtureProject;
    beforeAll(() => { project = fixtureProject("rust", { accept: true }); });
    afterAll(() => { rmSync(project.root, { recursive: true, force: true }); });
    it(cargoPresent ? "builds a current binary, exercises it and qualifies; a defect fails (PE-51)" : "reports the missing cargo toolchain as unavailable with the failed step named, never as a pass (PE-24)", async () => {
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        if (!cargoPresent) {
            expect(result.verdicts[0]?.status).toBe("unavailable");
            expect(result.verdicts[0]?.reasons.map(row => row.code)).toContain("PREPARE_FAILED");
            expect(result.exitCode).toBe(1);
            return;
        }
        expect(result.verdicts[0]?.satisfied).toBe(true);
        injectPersistenceDefect(project);
        const failed = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(failed.verdicts[0]?.status).toBe("failed");
    }, TIMEOUT);
});
