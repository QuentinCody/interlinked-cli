import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testsCommand } from "../commands/tests.js";
import { registerTestsCommands } from "./tests.js";

vi.mock("../commands/tests.js", () => ({ testsCommand: vi.fn() }));

async function parse(...args: string[]): Promise<void> {
    const program = new Command();
    registerTestsCommands(program);
    await program.parseAsync(["node", "interlinked", "tests", ...args]);
}

beforeEach(() => { vi.mocked(testsCommand).mockReset(); });

describe("tests run/plan/status --coverage-reporter — positive (must fire)", () => {
    it("P1: a repeated --coverage-reporter collects every module path in order", async () => {
        // test-contract: public-api — the flag is documented as repeatable, so each occurrence adds one reporter module
        await parse("run", "a.test.ts", "--coverage", "--coverage-reporter", "first.mjs", "--coverage-reporter", "second.mjs");
        expect(testsCommand).toHaveBeenCalledWith("run", ["a.test.ts"], expect.objectContaining({ coverage: true, coverageReporter: ["first.mjs", "second.mjs"] }));
    });

    it("P2: a single --coverage-reporter yields a one-element list", async () => {
        // test-contract: boundary — the first occurrence starts from an empty list rather than a bare string
        await parse("plan", "--coverage-reporter", "only.mjs");
        expect(testsCommand).toHaveBeenCalledWith("plan", [], expect.objectContaining({ coverageReporter: ["only.mjs"] }));
    });
});

describe("tests run/plan/status --coverage-reporter — negative (must not fire)", () => {
    it("N1: without the flag no reporter list is provided and the documented defaults hold", async () => {
        // test-contract: invariant — an absent flag leaves the reporter list undefined so a plain run asks for no coverage reporters
        await parse("status");
        expect(testsCommand).toHaveBeenCalledWith("status", [], expect.objectContaining({ base: "HEAD", timeout: "60000", workers: "2" }));
        const options = vi.mocked(testsCommand).mock.calls[0]?.[2];
        expect(options).not.toHaveProperty("coverageReporter");
    });
});
