import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCiBase, resolveCiCandidate, runCi } from "../../harness/project-e2e/ci.js";
import { qualifyStability } from "../../harness/project-e2e/cohort.js";
import { evaluateE2e } from "../../harness/project-e2e/evaluate.js";
import { gateDecision, gateHookStatus, installGateHooks, uninstallGateHooks } from "../../harness/project-e2e/gate.js";
import { recordPolicyReplacement } from "../../harness/project-e2e/policy-base.js";
import { runProjectE2e } from "../../harness/project-e2e/run.js";
import { scaffoldScenario, writeScaffold } from "../../harness/project-e2e/scaffold.js";
import { acceptExpectationInStore, disputeExpectationInStore, proposeExpectationInStore, replaceExpectationInStore, reviewExpectations } from "../../harness/project-e2e/store.js";
import { output, outputError } from "../../lib/output.js";
import { testsE2eCiCommand, testsE2eCommand, testsE2eExpectationsCommand, testsE2eGateCommand, testsE2ePolicyCommand, testsE2eScaffoldCommand } from "../tests-e2e.js";

vi.mock("../../harness/project-e2e/evaluate.js", () => ({ evaluateE2e: vi.fn(), formatEvaluation: () => ["formatted"] }));
vi.mock("../../harness/project-e2e/run.js", () => ({ runProjectE2e: vi.fn() }));
vi.mock("../../harness/project-e2e/ci.js", () => ({ resolveCiBase: vi.fn(), resolveCiCandidate: vi.fn(), runCi: vi.fn() }));
vi.mock("../../harness/project-e2e/gate.js", () => ({ gateDecision: vi.fn(), gateHookStatus: vi.fn(), installGateHooks: vi.fn(), uninstallGateHooks: vi.fn() }));
vi.mock("../../harness/project-e2e/cohort.js", () => ({ qualifyStability: vi.fn() }));
vi.mock("../../harness/project-e2e/policy-base.js", () => ({ recordPolicyReplacement: vi.fn() }));
vi.mock("../../harness/project-e2e/scaffold.js", () => ({ scaffoldScenario: vi.fn(), writeScaffold: vi.fn() }));
vi.mock("../../harness/project-e2e/store.js", () => ({ proposeExpectationInStore: vi.fn(), acceptExpectationInStore: vi.fn(), replaceExpectationInStore: vi.fn(), disputeExpectationInStore: vi.fn(), reviewExpectations: vi.fn() }));
vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: vi.fn() }));

const savedExit = process.exitCode;
const savedAuto = process.env.INTERLINKED_AUTO_RUN;
const dirs: string[] = [];
beforeEach(() => { vi.clearAllMocks(); process.exitCode = undefined; delete process.env.INTERLINKED_AUTO_RUN; });
afterEach(() => {
    process.exitCode = savedExit;
    if (savedAuto === undefined) delete process.env.INTERLINKED_AUTO_RUN; else process.env.INTERLINKED_AUTO_RUN = savedAuto;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmp(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-mut-"))); dirs.push(dir); return dir; }
const base = { version: 1 as const, status: "configured" as const, root: "/r", scope: { requested: "all" as const }, verdicts: [], mappingGaps: [], exitCode: 1 as const, target: { mode: "working-tree" as const }, projects: [] };
const verdict = (over: Record<string, unknown>) => ({ key: "p/s", projectId: "p", scenarioId: "s", required: true, satisfied: false, generation: "0123456789abcdefXYZ", ...over }) as never;
/** The rendered `normal` text of the most recent output() call. */
function normalText(): string { const call = vi.mocked(output).mock.calls.at(-1)!; return (call[2] as { normal: () => string }).normal(); }
function evalArg(): Record<string, unknown> { return vi.mocked(evaluateE2e).mock.calls.at(-1)![0] as unknown as Record<string, unknown>; }

describe("selection and timeout", () => {
    it("without --project/--scenario the engine receives no project or scenario filter", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(base);
        await testsE2eCommand("status", { cwd: tmp(), json: true });
        expect(evalArg()).not.toHaveProperty("projectId");
        expect(evalArg()).not.toHaveProperty("scenarioIds");
    });
    it("an empty --scenario list is treated as no scenario filter", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(base);
        await testsE2eCommand("status", { cwd: tmp(), scenario: [], json: true });
        expect(evalArg()).not.toHaveProperty("scenarioIds");
    });
    it("--project and --scenario are forwarded to the engine", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(base);
        await testsE2eCommand("status", { cwd: tmp(), project: "p", scenario: ["s"], json: true });
        expect(evalArg()).toMatchObject({ projectId: "p", scenarioIds: ["s"] });
    });
    it("a timeout of 1 ms and of 600000 ms are accepted; 600001 is refused", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...base, exitCode: 0, receipts: [], messages: [] });
        await testsE2eCommand("run", { cwd: tmp(), timeout: "1" });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).toMatchObject({ timeoutMs: 1 });
        await testsE2eCommand("run", { cwd: tmp(), timeout: "600000" });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).toMatchObject({ timeoutMs: 600000 });
        expect(outputError).not.toHaveBeenCalled();
        vi.mocked(runProjectE2e).mockClear();
        await testsE2eCommand("run", { cwd: tmp(), timeout: "600001" });
        expect(runProjectE2e).not.toHaveBeenCalled();
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/Timeout/));
        expect(process.exitCode).toBe(2);
    });
    it("fractional, non-numeric and negative timeouts are refused", async () => {
        for (const timeout of ["1.5", "abc", "-5"]) {
            vi.mocked(outputError).mockClear();
            await testsE2eCommand("run", { cwd: tmp(), timeout });
            expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/Timeout/));
        }
    });
    it("the default timeout is 120000 ms", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...base, exitCode: 0, receipts: [], messages: [] });
        await testsE2eCommand("run", { cwd: tmp() });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).toMatchObject({ timeoutMs: 120000 });
    });
    it("a non-Error throw is reported as its string form", async () => {
        vi.mocked(evaluateE2e).mockImplementation(() => { throw "plain string failure"; });
        await testsE2eCommand("check", { cwd: tmp() });
        expect(outputError).toHaveBeenCalledWith("json", "plain string failure");
    });
});

describe("run", () => {
    it("INTERLINKED_AUTO_RUN=1 marks the run automatic; otherwise it is not automatic", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...base, exitCode: 0, receipts: [], messages: [] });
        await testsE2eCommand("run", { cwd: tmp() });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).not.toHaveProperty("automatic");
        process.env.INTERLINKED_AUTO_RUN = "1";
        await testsE2eCommand("run", { cwd: tmp() });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).toMatchObject({ automatic: true });
        process.env.INTERLINKED_AUTO_RUN = "0";
        await testsE2eCommand("run", { cwd: tmp() });
        expect(vi.mocked(runProjectE2e).mock.calls.at(-1)![0]).not.toHaveProperty("automatic");
    });
    it("a failing run sets the process exit code to the run's exit code", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...base, exitCode: 1, receipts: [], messages: [] });
        await testsE2eCommand("run", { cwd: tmp() });
        expect(process.exitCode).toBe(1);
    });
    it("run output lists the messages then one receipt line per receipt with its scenario ids", async () => {
        vi.mocked(runProjectE2e).mockResolvedValue({ ...base, exitCode: 0, receipts: [{ path: "/x/receipt.json", scenarioIds: ["a", "b"] }], messages: ["note one"] } as never);
        await testsE2eCommand("run", { cwd: tmp() });
        expect(normalText().split("\n")).toEqual(["formatted", "note one", "receipt /x/receipt.json (a, b)"]);
    });
});

describe("status, plan, check", () => {
    it("check passes no base unless --base is given and forwards it when given", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp() });
        expect(evalArg()).not.toHaveProperty("base");
        await testsE2eCommand("check", { cwd: tmp(), base: "main" });
        expect(evalArg()).toMatchObject({ base: "main" });
    });
    it("an empty-string --base is still forwarded (it is not the same as absent)", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), base: "" });
        expect(evalArg()).toMatchObject({ base: "" });
    });
    it("--base is refused for status and plan, and evaluates nothing", async () => {
        for (const action of ["status", "plan"] as const) {
            process.exitCode = undefined;
            await testsE2eCommand(action, { cwd: tmp(), base: "main" });
            expect(process.exitCode).toBe(2);
        }
        expect(evaluateE2e).not.toHaveBeenCalled();
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--base applies to `tests e2e check` only/));
    });
    it("--staged judges the index and --revision judges that revision", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), staged: true });
        expect(evalArg()).toMatchObject({ target: { mode: "index" } });
        await testsE2eCommand("check", { cwd: tmp(), revision: "abc123" });
        expect(evalArg()).toMatchObject({ target: { mode: "revision", revision: "abc123" } });
        await testsE2eCommand("check", { cwd: tmp() });
        expect(evalArg()).toMatchObject({ target: { mode: "working-tree" } });
    });
    it("an empty-string --revision is a revision target, not the working tree", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), revision: "" });
        expect(evalArg()).toMatchObject({ target: { mode: "revision", revision: "" } });
    });
    it("--staged and --revision are refused for status and plan", async () => {
        for (const options of [{ staged: true }, { revision: "r" }]) {
            for (const action of ["status", "plan"] as const) {
                process.exitCode = undefined;
                vi.mocked(outputError).mockClear();
                await testsE2eCommand(action, { cwd: tmp(), ...options });
                expect(process.exitCode).toBe(2);
                expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/apply to `tests e2e check` only/));
            }
        }
    });
    it("--staged together with --revision is refused", async () => {
        await testsE2eCommand("check", { cwd: tmp(), staged: true, revision: "r" });
        expect(process.exitCode).toBe(2);
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/not both/));
        expect(evaluateE2e).not.toHaveBeenCalled();
    });
    it("plan prints one line per verdict: required/advisory, 12-char generation, and the next run command or satisfied", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, verdicts: [verdict({}), verdict({ key: "p/t", scenarioId: "t", required: false, satisfied: true })] });
        await testsE2eCommand("plan", { cwd: tmp() });
        expect(normalText().split("\n")).toEqual([
            "formatted",
            "p/s: required; generation 0123456789ab; next: interlinked tests e2e run --project p --scenario s",
            "p/t: advisory; generation 0123456789ab; next: nothing (satisfied)",
        ]);
    });
    it("status adds no plan lines", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, verdicts: [verdict({})] });
        await testsE2eCommand("status", { cwd: tmp() });
        expect(normalText()).toBe("formatted");
    });
    it("check without --gate keeps the evaluation exit code and prints no gate line", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 2 });
        await testsE2eCommand("check", { cwd: tmp() });
        expect(process.exitCode).toBe(2);
        expect(normalText()).toBe("formatted");
    });
    it("a passing check leaves the exit code unset", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp() });
        expect(process.exitCode).toBeUndefined();
    });
});

describe("--gate", () => {
    const failing = { ...base, exitCode: 1 as const, verdicts: [verdict({}), verdict({ key: "q/s", projectId: "q", satisfied: true }), verdict({ key: "r/s", projectId: "r", required: false })], mappingGaps: [{ projectId: "m" }], projects: [{ id: "p" }, { id: "q" }, { id: "r" }, { id: "m" }, { id: "z" }] } as unknown as typeof base;
    it("--gate is refused for actions other than check", async () => {
        await testsE2eCommand("status", { cwd: tmp(), gate: "commit" });
        expect(process.exitCode).toBe(2);
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--gate commit\|ci applies to `tests e2e check` only/));
    });
    it("--gate values other than commit and ci are refused", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), gate: "push" });
        expect(process.exitCode).toBe(2);
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--gate commit\|ci/));
    });
    it("--gate ci is accepted for check", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), gate: "ci" });
        expect(outputError).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
    });
    it("a passing evaluation under --gate exits 0 without consulting the gate", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, exitCode: 0 });
        await testsE2eCommand("check", { cwd: tmp(), gate: "commit" });
        expect(gateDecision).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
        expect(normalText()).toBe("formatted");
    });
    it("a non-configured evaluation (unconfigured) keeps its exit code under --gate and is not waived", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...base, status: "unconfigured", exitCode: 2 });
        await testsE2eCommand("check", { cwd: tmp(), gate: "commit" });
        expect(gateDecision).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(2);
    });
    it("POLICY_WEAKENED is never waived: the exit code stays and the weakening line is printed without consulting the gate", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...failing, policy: { weakening: [{ kind: "x" }] } } as never);
        await testsE2eCommand("check", { cwd: tmp(), gate: "commit" });
        expect(gateDecision).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(normalText()).toMatch(/gate commit: POLICY_WEAKENED is never waived/);
    });
    it("an empty weakening list does not trigger the weakened path", async () => {
        vi.mocked(evaluateE2e).mockReturnValue({ ...failing, policy: { weakening: [] } } as never);
        vi.mocked(gateDecision).mockReturnValue({ enforced: false, projects: [] } as never);
        await testsE2eCommand("check", { cwd: tmp(), gate: "ci" });
        expect(gateDecision).toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
    });
    it("the gate decision is made over exactly the projects with an unsatisfied required verdict or a mapping gap", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(failing);
        vi.mocked(gateDecision).mockReturnValue({ enforced: true, projects: ["p", "m"] } as never);
        await testsE2eCommand("check", { cwd: tmp(), gate: "commit" });
        const [arg, which] = vi.mocked(gateDecision).mock.calls[0]!;
        expect(which).toBe("commit");
        expect((arg as unknown as { projects: Array<{ id: string }> }).projects.map(project => project.id).sort()).toEqual(["m", "p"]);
    });
    it("an enforced gate keeps the exit code and names the projects and exit code", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(failing);
        vi.mocked(gateDecision).mockReturnValue({ enforced: true, projects: ["p", "m"] } as never);
        await testsE2eCommand("check", { cwd: tmp(), gate: "ci" });
        expect(process.exitCode).toBe(1);
        expect(normalText()).toContain("gate ci is required by project(s) p, m: exit 1.");
    });
    it("a non-enforced gate reports only: exit 0, obligation stays open", async () => {
        vi.mocked(evaluateE2e).mockReturnValue(failing);
        vi.mocked(gateDecision).mockReturnValue({ enforced: false, projects: [] } as never);
        await testsE2eCommand("check", { cwd: tmp(), gate: "commit" });
        expect(process.exitCode).toBeUndefined();
        expect(normalText()).toMatch(/gate commit is warn\/off .* reported only, exit 0/);
    });
});

describe("qualify", () => {
    it("qualify needs exactly one --scenario", async () => {
        for (const scenario of [undefined, [], ["a", "b"]]) {
            process.exitCode = undefined;
            vi.mocked(outputError).mockClear();
            await testsE2eCommand("qualify", { cwd: tmp(), ...(scenario ? { scenario } : {}) });
            expect(process.exitCode).toBe(2);
            expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/exactly one --scenario/));
        }
        expect(qualifyStability).not.toHaveBeenCalled();
    });
    it("--runs accepts 1 and 5 and rejects 0, 6, fractions and text", async () => {
        vi.mocked(qualifyStability).mockResolvedValue({ evaluation: base, messages: [], exitCode: 0 } as never);
        for (const runs of ["1", "5"]) {
            vi.mocked(outputError).mockClear();
            await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"], runs });
            expect(outputError).not.toHaveBeenCalled();
            expect(vi.mocked(qualifyStability).mock.calls.at(-1)![0]).toMatchObject({ runs: Number(runs) });
        }
        vi.mocked(qualifyStability).mockClear();
        for (const runs of ["0", "6", "2.5", "x"]) {
            vi.mocked(outputError).mockClear();
            await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"], runs });
            expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--runs must be an integer from 1 to 5/));
        }
        expect(qualifyStability).not.toHaveBeenCalled();
    });
    it("qualify forwards the scenario, project, timeout and omits runs/project when absent", async () => {
        vi.mocked(qualifyStability).mockResolvedValue({ evaluation: base, messages: ["m1"], exitCode: 1 } as never);
        await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"], timeout: "777" });
        const bare = vi.mocked(qualifyStability).mock.calls[0]![0] as unknown as Record<string, unknown>;
        expect(bare).toMatchObject({ scenarioId: "s", timeoutMs: 777 });
        expect(bare).not.toHaveProperty("runs");
        expect(bare).not.toHaveProperty("projectId");
        await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"], project: "p", runs: "3" });
        expect(vi.mocked(qualifyStability).mock.calls[1]![0]).toMatchObject({ projectId: "p", runs: 3 });
    });
    it("qualify exits with the cohort verdict and prints the evaluation then messages", async () => {
        vi.mocked(qualifyStability).mockResolvedValue({ evaluation: base, messages: ["m1"], exitCode: 1 } as never);
        await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"] });
        expect(process.exitCode).toBe(1);
        expect(normalText().split("\n")).toEqual(["formatted", "m1"]);
        process.exitCode = undefined;
        vi.mocked(qualifyStability).mockResolvedValue({ evaluation: base, messages: [], exitCode: 0 } as never);
        await testsE2eCommand("qualify", { cwd: tmp(), scenario: ["s"] });
        expect(process.exitCode).toBeUndefined();
    });
});

describe("gate install/status/uninstall", () => {
    const hook = (over: Record<string, unknown> = {}) => ({ installed: false, backedUp: null, removed: false, restored: false, ...over });
    it("a directory that is not a git repository root is refused with exit 2", async () => {
        await testsE2eGateCommand("status", { cwd: tmp() });
        expect(process.exitCode).toBe(2);
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/is not a git repository root/));
        expect(gateHookStatus).not.toHaveBeenCalled();
    });
    function repo(): string { const dir = tmp(); mkdirSync(join(dir, ".git")); return dir; }
    it("install enables both hooks by default and each can be switched off", async () => {
        vi.mocked(installGateHooks).mockReturnValue({ preCommit: hook(), prePush: hook() } as never);
        const dir = repo();
        await testsE2eGateCommand("install", { cwd: dir });
        expect(installGateHooks).toHaveBeenLastCalledWith(dir, { commit: true, push: true });
        await testsE2eGateCommand("install", { cwd: dir, commit: false });
        expect(installGateHooks).toHaveBeenLastCalledWith(dir, { commit: false, push: true });
        await testsE2eGateCommand("install", { cwd: dir, push: false });
        expect(installGateHooks).toHaveBeenLastCalledWith(dir, { commit: true, push: false });
    });
    it("install text distinguishes installed, already installed and skipped, and shows backup chaining", async () => {
        const dir = repo();
        vi.mocked(installGateHooks).mockReturnValue({ preCommit: hook({ installed: true, backedUp: "pre-commit.bak" }), prePush: hook() } as never);
        await testsE2eGateCommand("install", { cwd: dir });
        let lines = normalText().split("\n");
        expect(lines[0]).toBe("pre-commit: installed (original chained from pre-commit.bak)");
        expect(lines[1]).toBe("pre-push: already installed");
        vi.mocked(installGateHooks).mockReturnValue({ preCommit: hook(), prePush: hook({ installed: true, backedUp: "pp.bak" }) } as never);
        await testsE2eGateCommand("install", { cwd: dir, commit: false });
        lines = normalText().split("\n");
        expect(lines[0]).toBe("pre-commit: skipped");
        expect(lines[1]).toBe("pre-push: installed (original chained from pp.bak)");
        vi.mocked(installGateHooks).mockReturnValue({ preCommit: hook(), prePush: hook() } as never);
        await testsE2eGateCommand("install", { cwd: dir, push: false });
        lines = normalText().split("\n");
        expect(lines[0]).toBe("pre-commit: already installed");
        expect(lines[1]).toBe("pre-push: skipped");
        expect(lines).toHaveLength(3);
    });
    it("uninstall text reports removed / not ours and restored originals per hook", async () => {
        const dir = repo();
        vi.mocked(uninstallGateHooks).mockReturnValue({ preCommit: hook({ removed: true, restored: true }), prePush: hook() } as never);
        await testsE2eGateCommand("uninstall", { cwd: dir });
        expect(uninstallGateHooks).toHaveBeenCalledWith(dir);
        expect(normalText()).toBe("pre-commit: removed (original restored)\npre-push: not ours");
        vi.mocked(uninstallGateHooks).mockReturnValue({ preCommit: hook(), prePush: hook({ removed: true }) } as never);
        await testsE2eGateCommand("uninstall", { cwd: dir });
        expect(normalText()).toBe("pre-commit: not ours\npre-push: removed");
        expect(gateHookStatus).not.toHaveBeenCalled();
    });
    it("status reports installed or absent per hook and does not install", async () => {
        const dir = repo();
        vi.mocked(gateHookStatus).mockReturnValue({ preCommit: true, prePush: false } as never);
        await testsE2eGateCommand("status", { cwd: dir });
        expect(gateHookStatus).toHaveBeenCalledWith(dir);
        expect(normalText()).toBe("pre-commit: installed\npre-push: absent");
        vi.mocked(gateHookStatus).mockReturnValue({ preCommit: false, prePush: true } as never);
        await testsE2eGateCommand("status", { cwd: dir });
        expect(normalText()).toBe("pre-commit: absent\npre-push: installed");
        expect(installGateHooks).not.toHaveBeenCalled();
        expect(uninstallGateHooks).not.toHaveBeenCalled();
    });
    it("an engine failure during install is reported with exit 2 and a non-Error is stringified", async () => {
        vi.mocked(installGateHooks).mockImplementation(() => { throw "boom"; });
        await testsE2eGateCommand("install", { cwd: repo() });
        expect(outputError).toHaveBeenCalledWith("json", "boom");
        expect(process.exitCode).toBe(2);
    });
});

describe("ci", () => {
    const result = (over: Record<string, unknown> = {}) => ({ evaluation: base, messages: ["ci message"], trust: ["trust note"], exitCode: 0, ...over });
    it("ci forwards the explicit base and revision and resolves the candidate revision", async () => {
        vi.mocked(resolveCiBase).mockReturnValue("BASE" as never);
        vi.mocked(resolveCiCandidate).mockReturnValue({ revision: "CAND" } as never);
        vi.mocked(runCi).mockResolvedValue(result() as never);
        await testsE2eCiCommand({ cwd: tmp(), base: "b1", revision: "r1", timeout: "4321", project: "p", scenario: ["s"] });
        expect(resolveCiBase).toHaveBeenCalledWith(expect.objectContaining({ explicit: "b1", env: process.env }));
        expect(resolveCiCandidate).toHaveBeenCalledWith(expect.objectContaining({ explicit: "r1", env: process.env }));
        expect(runCi).toHaveBeenCalledWith(expect.objectContaining({ base: "BASE", candidate: "CAND", timeoutMs: 4321, projectId: "p", scenarioIds: ["s"] }));
    });
    it("ci omits explicit base and revision when not given", async () => {
        vi.mocked(resolveCiCandidate).mockReturnValue({ revision: "CAND" } as never);
        vi.mocked(runCi).mockResolvedValue(result() as never);
        await testsE2eCiCommand({ cwd: tmp() });
        expect(vi.mocked(resolveCiBase).mock.calls[0]![0]).not.toHaveProperty("explicit");
        expect(vi.mocked(resolveCiCandidate).mock.calls[0]![0]).not.toHaveProperty("explicit");
        expect(vi.mocked(runCi).mock.calls[0]![0]).toMatchObject({ timeoutMs: 120000 });
    });
    it("ci prints the evaluation, then messages, then trust notes, and exits with the CI verdict", async () => {
        vi.mocked(resolveCiCandidate).mockReturnValue({ revision: "CAND" } as never);
        vi.mocked(runCi).mockResolvedValue(result({ exitCode: 1 }) as never);
        await testsE2eCiCommand({ cwd: tmp() });
        expect(normalText().split("\n")).toEqual(["formatted", "ci message", "trust note"]);
        expect(process.exitCode).toBe(1);
        process.exitCode = undefined;
        vi.mocked(runCi).mockResolvedValue(result({ exitCode: 0 }) as never);
        await testsE2eCiCommand({ cwd: tmp() });
        expect(process.exitCode).toBeUndefined();
    });
    it("ci reports a resolver failure with exit 2 and runs nothing", async () => {
        vi.mocked(resolveCiBase).mockImplementation(() => { throw new Error("no base"); });
        await testsE2eCiCommand({ cwd: tmp() });
        expect(outputError).toHaveBeenCalledWith("json", "no base");
        expect(process.exitCode).toBe(2);
        expect(runCi).not.toHaveBeenCalled();
    });
    it("ci stringifies a non-Error failure", async () => {
        vi.mocked(resolveCiBase).mockImplementation(() => { throw "weird"; });
        await testsE2eCiCommand({ cwd: tmp() });
        expect(outputError).toHaveBeenCalledWith("json", "weird");
    });
});

describe("policy replace", () => {
    const record = { projectId: "p", scenarioId: "s", baseDigest: "a".repeat(40), headDigest: "b".repeat(40) };
    it("requires --base, --project and --rationale", async () => {
        for (const options of [{ project: "p", rationale: "r" }, { base: "b", rationale: "r" }, { base: "b", project: "p" }, { base: "", project: "p", rationale: "r" }]) {
            process.exitCode = undefined;
            vi.mocked(outputError).mockClear();
            await testsE2ePolicyCommand("replace", { cwd: tmp(), ...options });
            expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/needs --base <rev>, --project <id> and --rationale <text>/));
            expect(process.exitCode).toBe(2);
        }
        expect(recordPolicyReplacement).not.toHaveBeenCalled();
    });
    it("covers at most one scenario", async () => {
        await testsE2ePolicyCommand("replace", { cwd: tmp(), base: "b", project: "p", rationale: "r", scenario: ["a", "b"] });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/one scenario/));
        expect(process.exitCode).toBe(2);
        expect(recordPolicyReplacement).not.toHaveBeenCalled();
    });
    it("an unknown action is refused", async () => {
        await testsE2ePolicyCommand("revoke" as never, { cwd: tmp(), base: "b", project: "p", rationale: "r" });
        expect(outputError).toHaveBeenCalledWith("json", "unknown policy action revoke");
        expect(process.exitCode).toBe(2);
    });
    it("records a project-wide replacement without a scenario and forwards a single scenario when given", async () => {
        vi.mocked(recordPolicyReplacement).mockReturnValue({ ...record, scenarioId: undefined } as never);
        const dir = tmp();
        await testsE2ePolicyCommand("replace", { cwd: dir, base: "b", project: "p", rationale: "why" });
        const first = vi.mocked(recordPolicyReplacement).mock.calls[0]![0] as unknown as Record<string, unknown>;
        expect(first).toMatchObject({ root: dir, base: "b", projectId: "p", rationale: "why" });
        expect(first).not.toHaveProperty("scenarioId");
        expect(normalText().split("\n")[0]).toBe(`recorded reviewed replacement for p: base ${"a".repeat(12)} → head ${"b".repeat(12)}`);
        await testsE2ePolicyCommand("replace", { cwd: dir, base: "b", project: "p", rationale: "why", scenario: ["s"] });
        expect(vi.mocked(recordPolicyReplacement).mock.calls[1]![0]).toMatchObject({ scenarioId: "s" });
        vi.mocked(recordPolicyReplacement).mockReturnValue(record as never);
        await testsE2ePolicyCommand("replace", { cwd: dir, base: "b", project: "p", rationale: "why", scenario: ["s"] });
        expect(normalText().split("\n")[0]).toBe(`recorded reviewed replacement for p/s: base ${"a".repeat(12)} → head ${"b".repeat(12)}`);
        expect(process.exitCode).toBeUndefined();
    });
    it("an empty --scenario list means the whole project", async () => {
        vi.mocked(recordPolicyReplacement).mockReturnValue({ ...record, scenarioId: undefined } as never);
        await testsE2ePolicyCommand("replace", { cwd: tmp(), base: "b", project: "p", rationale: "r", scenario: [] });
        expect(vi.mocked(recordPolicyReplacement).mock.calls[0]![0]).not.toHaveProperty("scenarioId");
    });
    it("a store failure is reported with exit 2", async () => {
        vi.mocked(recordPolicyReplacement).mockImplementation(() => { throw new Error("bad base"); });
        await testsE2ePolicyCommand("replace", { cwd: tmp(), base: "b", project: "p", rationale: "r" });
        expect(outputError).toHaveBeenCalledWith("json", "bad base");
        expect(process.exitCode).toBe(2);
    });
});

describe("scaffold", () => {
    const scaffolded = { project: { id: "proj" }, suite: { id: "suite" }, scenario: { id: "scn" }, files: [{ path: "a.test.ts", content: "CONTENT" }], notes: ["assume X"] };
    it("scaffold prints the scenario, each file with a pass --write hint, and notes; nothing is written without --write", async () => {
        vi.mocked(scaffoldScenario).mockReturnValue(scaffolded as never);
        const dir = tmp();
        await testsE2eScaffoldCommand("orders", { cwd: dir });
        expect(scaffoldScenario).toHaveBeenCalledWith({ root: dir, name: "orders" });
        expect(writeScaffold).not.toHaveBeenCalled();
        const lines = normalText().split("\n");
        expect(lines).toContain("--- a.test.ts (pass --write to create)");
        expect(lines).toContain("CONTENT");
        expect(lines).toContain("note: assume X");
        expect(normalText()).toContain(JSON.stringify(scaffolded.scenario, null, 2));
        expect(normalText()).toContain("(never written by this command)");
        expect(vi.mocked(output).mock.calls.at(-1)![1]).toMatchObject({ project: "proj", suite: "suite", written: [] });
    });
    it("--write writes the files, marks them written and records the written paths", async () => {
        vi.mocked(scaffoldScenario).mockReturnValue(scaffolded as never);
        vi.mocked(writeScaffold).mockReturnValue(["a.test.ts"]);
        const dir = tmp();
        await testsE2eScaffoldCommand("orders", { cwd: dir, write: true });
        expect(writeScaffold).toHaveBeenCalledWith(dir, scaffolded);
        expect(normalText()).toContain("--- a.test.ts (written)");
        expect(vi.mocked(output).mock.calls.at(-1)![1]).toMatchObject({ written: ["a.test.ts"] });
    });
    it("--project and --suite are forwarded only when given", async () => {
        vi.mocked(scaffoldScenario).mockReturnValue(scaffolded as never);
        await testsE2eScaffoldCommand("orders", { cwd: tmp(), project: "p", suite: "s" });
        expect(vi.mocked(scaffoldScenario).mock.calls[0]![0]).toMatchObject({ projectId: "p", suiteId: "s" });
        await testsE2eScaffoldCommand("orders", { cwd: tmp() });
        const bare = vi.mocked(scaffoldScenario).mock.calls[1]![0] as unknown as Record<string, unknown>;
        expect(bare).not.toHaveProperty("projectId");
        expect(bare).not.toHaveProperty("suiteId");
    });
    it("a refused scaffold is reported with exit 2", async () => {
        vi.mocked(scaffoldScenario).mockImplementation(() => { throw new Error("refused here"); });
        await testsE2eScaffoldCommand("orders", { cwd: tmp() });
        expect(outputError).toHaveBeenCalledWith("json", "refused here");
        expect(process.exitCode).toBe(2);
    });
});

describe("expectations", () => {
    function file(content: unknown): string { const dir = tmp(); const path = join(dir, "in.json"); writeFileSync(path, JSON.stringify(content)); return path; }
    const stored = (over: Record<string, unknown> = {}) => ({ expectation: { id: "x", lifecycle: "proposed", origin: "agent", revision: "r".repeat(20), statement: "stmt", questions: [], ...over }, sources: [{ path: "doc.md", provenance: "cited" }] });
    it("dispute forwards the decision to the dispute store only", async () => {
        vi.mocked(disputeExpectationInStore).mockReturnValue(stored() as never);
        const decision = { expectationId: "x", revision: "r", rationale: "no" };
        await testsE2eExpectationsCommand("dispute", { cwd: process.cwd(), from: file(decision) });
        expect(disputeExpectationInStore).toHaveBeenCalledWith(process.cwd(), decision, expect.any(Number));
        expect(acceptExpectationInStore).not.toHaveBeenCalled();
        expect(replaceExpectationInStore).not.toHaveBeenCalled();
        expect(proposeExpectationInStore).not.toHaveBeenCalled();
    });
    it("a decision result prints id, lifecycle, full revision and each source's provenance", async () => {
        vi.mocked(proposeExpectationInStore).mockReturnValue(stored() as never);
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: file({ id: "x" }) });
        expect(normalText()).toBe(`x: proposed rev ${"r".repeat(20)}\n  source doc.md: cited`);
    });
    it("a decision with the wrong-action store untouched: accept uses accept, replace uses replace", async () => {
        vi.mocked(acceptExpectationInStore).mockReturnValue(stored() as never);
        vi.mocked(replaceExpectationInStore).mockReturnValue(stored() as never);
        await testsE2eExpectationsCommand("accept", { cwd: process.cwd(), from: file({ a: 1 }) });
        expect(disputeExpectationInStore).not.toHaveBeenCalled();
        expect(replaceExpectationInStore).not.toHaveBeenCalled();
        await testsE2eExpectationsCommand("replace", { cwd: process.cwd(), from: file({ a: 1 }) });
        expect(replaceExpectationInStore).toHaveBeenCalledTimes(1);
        expect(disputeExpectationInStore).not.toHaveBeenCalled();
    });
    it("an interchange-file error names which record kind is needed", async () => {
        for (const [action, what] of [["propose", "proposal"], ["accept", "decision"], ["replace", "replacement decision"], ["dispute", "decision"]] as const) {
            vi.mocked(outputError).mockClear();
            await testsE2eExpectationsCommand(action, { cwd: process.cwd() });
            expect(outputError).toHaveBeenCalledWith("json", `--from <file> is required: a validated ${what} interchange record`);
            expect(process.exitCode).toBe(2);
        }
    });
    it("an empty --from path counts as missing", async () => {
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: "" });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringMatching(/--from/));
    });
    it("an unreadable interchange file (ENOENT) exits 2, malformed JSON exits 2, an engine refusal exits 1", async () => {
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: join(tmp(), "missing.json") });
        expect(process.exitCode).toBe(2);
        process.exitCode = undefined;
        const dir = tmp(); const bad = join(dir, "bad.json"); writeFileSync(bad, "{not json");
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: bad });
        expect(process.exitCode).toBe(2);
        process.exitCode = undefined;
        vi.mocked(proposeExpectationInStore).mockImplementation(() => { throw new Error("duplicate expectation"); });
        await testsE2eExpectationsCommand("propose", { cwd: process.cwd(), from: file({ id: "x" }) });
        expect(process.exitCode).toBe(1);
    });
    it("UNCONFIGURED and policy-invalid engine errors exit 2", async () => {
        for (const message of ["e2e: UNCONFIGURED", "e2e: policy invalid: x"]) {
            process.exitCode = undefined;
            vi.mocked(acceptExpectationInStore).mockImplementation(() => { throw new Error(message); });
            await testsE2eExpectationsCommand("accept", { cwd: process.cwd(), from: file({ a: 1 }) });
            expect(process.exitCode).toBe(2);
        }
    });
    it("a non-Error throw is stringified", async () => {
        vi.mocked(reviewExpectations).mockImplementation(() => { throw "odd"; });
        await testsE2eExpectationsCommand("review", { cwd: process.cwd() });
        expect(outputError).toHaveBeenCalledWith("json", "odd");
        expect(process.exitCode).toBe(1);
    });
    it("review with no rows says there are no live expectations", async () => {
        vi.mocked(reviewExpectations).mockReturnValue([]);
        await testsE2eExpectationsCommand("review", { cwd: process.cwd() });
        expect(normalText()).toBe("no live expectations");
    });
    it("review prints each expectation head with a 12-char revision, then sources, questions and diffs", async () => {
        vi.mocked(reviewExpectations).mockReturnValue([
            { expectation: { id: "a", lifecycle: "proposed", origin: "agent", revision: "0123456789abcdef", statement: "S1", questions: ["why?"] }, sources: [{ path: "p.md", provenance: "cited" }], diff: [{ field: "statement", before: "old", after: "new" }] },
            { expectation: { id: "b", lifecycle: "accepted", origin: "human", revision: "fedcba9876543210", statement: "S2", questions: [] }, sources: [] },
        ] as never);
        await testsE2eExpectationsCommand("review", { cwd: process.cwd() });
        expect(normalText().split("\n")).toEqual([
            "a: proposed [agent] rev 0123456789ab — S1",
            "  source p.md: cited",
            "  question: why?",
            '  changed statement: "old" → "new"',
            "b: accepted [human] rev fedcba987654 — S2",
        ]);
    });
});
