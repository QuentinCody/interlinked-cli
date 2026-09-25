import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateE2e } from "../../harness/project-e2e/evaluate.js";
import { runProjectE2e } from "../../harness/project-e2e/run.js";
import { acceptExpectationInStore, proposeExpectationInStore, replaceExpectationInStore, reviewExpectations } from "../../harness/project-e2e/store.js";
import { output, outputError } from "../../lib/output.js";
import { testsE2eCommand, testsE2eExpectationsCommand } from "../tests-e2e.js";

vi.mock("../../harness/project-e2e/evaluate.js", () => ({ evaluateE2e: vi.fn(), formatEvaluation: () => ["formatted"] }));
vi.mock("../../harness/project-e2e/run.js", () => ({ runProjectE2e: vi.fn() }));
vi.mock("../../harness/project-e2e/store.js", () => ({ proposeExpectationInStore: vi.fn(), acceptExpectationInStore: vi.fn(), replaceExpectationInStore: vi.fn(), disputeExpectationInStore: vi.fn(), reviewExpectations: vi.fn() }));
vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: vi.fn() }));

const exitCode = process.exitCode;
const roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });
afterEach(() => { process.exitCode = exitCode; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const evaluation = { version: 1 as const, status: "configured" as const, root: "/r", scope: { requested: "all" as const }, verdicts: [], mappingGaps: [], exitCode: 1 as const, target: { mode: "working-tree" as const }, projects: [] };

describe("tests e2e — inspection versus verification exit codes", () => {
    it("status and plan inspect: exit stays 0 even with open obligations", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(evaluation);
        await testsE2eCommand("status", { cwd: process.cwd(), json: true });
        expect(process.exitCode).toBeUndefined();
        expect(evaluateE2e).toHaveBeenCalledWith(expect.objectContaining({ root: process.cwd() }));
        await testsE2eCommand("plan", { cwd: process.cwd(), json: true });
        expect(process.exitCode).toBeUndefined();
    });
    it("check returns the evaluation's exit contract (1 open requirement, 2 unconfigured)", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(evaluation);
        await testsE2eCommand("check", { cwd: process.cwd(), json: true });
        expect(process.exitCode).toBe(1);
        vi.mocked(evaluateE2e).mockReturnValue({ ...evaluation, status: "unconfigured", exitCode: 2 });
        await testsE2eCommand("check", { cwd: process.cwd(), json: true });
        expect(process.exitCode).toBe(2);
    });
    it("run forwards project/scenario/timeout and exits with the post-run verdict", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...evaluation, exitCode: 0, receipts: [], messages: [] });
        await testsE2eCommand("run", { cwd: process.cwd(), project: "orders", scenario: ["a", "b"], timeout: "1234", json: true });
        expect(runProjectE2e).toHaveBeenCalledWith(expect.objectContaining({ root: process.cwd(), projectId: "orders", scenarioIds: ["a", "b"], timeoutMs: 1234 }));
        expect(process.exitCode).toBeUndefined();
        expect(output).toHaveBeenCalledWith("json", expect.objectContaining({ exitCode: 0 }), expect.any(Object));
    });
    it("an invalid timeout or an engine error is reported, never swallowed into a pass", async () => {
        await testsE2eCommand("run", { cwd: process.cwd(), timeout: "0", json: true });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/Timeout/));
        expect(process.exitCode).toBe(2);
        vi.mocked(evaluateE2e).mockImplementation(() => { throw new Error("e2e: unknown project ghost"); });
        await testsE2eCommand("check", { cwd: process.cwd(), project: "ghost", json: true });
        expect(outputError).toHaveBeenCalledWith("json", "e2e: unknown project ghost");
        expect(process.exitCode).toBe(2);
    });
});
describe("tests e2e expectations", () => {
    function file(content: unknown): string {
        const root = mkdtempSync(join(tmpdir(), "e2e-cmd-")); roots.push(root);
        const path = join(root, "input.json");
        writeFileSync(path, JSON.stringify(content));
        return path;
    }
    it("propose validates the interchange file and forwards the draft; a missing --from is an error", async () => {
        vi.mocked(proposeExpectationInStore).mockReturnValue({ expectation: { id: "x" } as never, sources: [] });
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: file({ id: "x", statement: "s" }), json: true });
        expect(proposeExpectationInStore).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({ id: "x" }), expect.any(Number));
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), json: true });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--from/));
        expect(process.exitCode).toBe(2);
    });
    it("accept and replace forward decisions; review lists records", async () => {
        vi.mocked(acceptExpectationInStore).mockReturnValue({ expectation: { id: "x" } as never, sources: [], acceptedContractDigests: {} });
        await testsE2eExpectationsCommand("accept", { cwd: process.cwd(), from: file({ expectationId: "x", revision: "r", rationale: "ok" }), json: true });
        expect(acceptExpectationInStore).toHaveBeenCalledWith(process.cwd(), { expectationId: "x", revision: "r", rationale: "ok" }, expect.any(Number));
        vi.mocked(replaceExpectationInStore).mockReturnValue({ expectation: { id: "y" } as never, sources: [], affectedScenarioIds: [] });
        await testsE2eExpectationsCommand("replace", { cwd: process.cwd(), from: file({ expectationId: "x", revision: "r", rationale: "ok", replacement: { id: "y" } }), json: true });
        expect(replaceExpectationInStore).toHaveBeenCalled();
        vi.mocked(reviewExpectations).mockReturnValue([]);
        await testsE2eExpectationsCommand("review", { cwd: process.cwd(), json: true });
        expect(reviewExpectations).toHaveBeenCalledWith(process.cwd());
        expect(process.exitCode).toBeUndefined();
    });
    it("a refused decision (stale digest) exits 1 with the engine's reason", async () => {
        vi.mocked(acceptExpectationInStore).mockImplementation(() => { throw new Error("e2e expectation: revision a does not match current revision b"); });
        await testsE2eExpectationsCommand("accept", { cwd: process.cwd(), from: file({ expectationId: "x", revision: "a", rationale: "ok" }), json: true });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/does not match/));
        expect(process.exitCode).toBe(1);
    });
});
