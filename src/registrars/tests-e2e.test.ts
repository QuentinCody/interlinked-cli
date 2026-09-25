import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { testsE2eCommand, testsE2eExpectationsCommand } from "../commands/tests-e2e.js";
import { testsE2eAdoptionCommand } from "../commands/tests-e2e-adopt.js";
import { registerTestsCommands } from "./tests.js";
vi.mock("../commands/tests-e2e.js", () => ({ testsE2eCommand: vi.fn(), testsE2eExpectationsCommand: vi.fn() }));
vi.mock("../commands/tests-e2e-adopt.js", () => ({ testsE2eAdoptionCommand: vi.fn() }));

describe("tests e2e registrar", () => {
    it("routes the adoption workflow: discover --out, surfaces --write, adopt --from with repeatable selection, doctor", async () => {
        const program = new Command();
        registerTestsCommands(program);
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "discover", "--cwd", "/tmp/x", "--out", "report.json", "--json"]);
        expect(testsE2eAdoptionCommand).toHaveBeenCalledWith("discover", expect.objectContaining({ cwd: "/tmp/x", out: "report.json", json: true }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "surfaces", "--write"]);
        expect(testsE2eAdoptionCommand).toHaveBeenCalledWith("surfaces", expect.objectContaining({ write: true }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "adopt", "--from", "report.json", "--project", "a", "--project", "b", "--scenario", "s", "--mode", "required", "--replace"]);
        expect(testsE2eAdoptionCommand).toHaveBeenCalledWith("adopt", expect.objectContaining({ from: "report.json", project: ["a", "b"], scenario: ["s"], mode: "required", replace: true }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "doctor", "--project", "a"]);
        expect(testsE2eAdoptionCommand).toHaveBeenCalledWith("doctor", expect.objectContaining({ project: ["a"] }));
    });
    it("routes status/plan/run/check with shared selection options", async () => {
        const program = new Command();
        registerTestsCommands(program);
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "run", "--project", "orders", "--scenario", "a", "--scenario", "b", "--timeout", "5000", "--json"]);
        expect(testsE2eCommand).toHaveBeenCalledWith("run", expect.objectContaining({ project: "orders", scenario: ["a", "b"], timeout: "5000", json: true }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "check", "--cwd", "/tmp/x"]);
        expect(testsE2eCommand).toHaveBeenCalledWith("check", expect.objectContaining({ cwd: "/tmp/x" }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "status"]);
        expect(testsE2eCommand).toHaveBeenCalledWith("status", expect.any(Object));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "plan"]);
        expect(testsE2eCommand).toHaveBeenCalledWith("plan", expect.any(Object));
    });
    it("routes the expectations subgroup with --from", async () => {
        const program = new Command();
        registerTestsCommands(program);
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "expectations", "propose", "--from", "evidence.json"]);
        expect(testsE2eExpectationsCommand).toHaveBeenCalledWith("propose", expect.objectContaining({ from: "evidence.json" }));
        await program.parseAsync(["node", "interlinked", "tests", "e2e", "expectations", "review", "--json"]);
        expect(testsE2eExpectationsCommand).toHaveBeenCalledWith("review", expect.objectContaining({ json: true }));
        for (const action of ["accept", "replace", "dispute"]) {
            await program.parseAsync(["node", "interlinked", "tests", "e2e", "expectations", action, "--from", "decision.json"]);
            expect(testsE2eExpectationsCommand).toHaveBeenCalledWith(action, expect.objectContaining({ from: "decision.json" }));
        }
    });
});
