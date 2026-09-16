import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testsSuiteCommand } from "../tests-suite.js";
import { runLanguageTestSuite } from "../../harness/quality-checks/language-test-suite.js";
import { scheduleTests } from "../../harness/test-scheduler.js";
import { output, outputError } from "../../lib/output.js";
vi.mock("../../harness/quality-checks/language-test-suite.js", () => ({ runLanguageTestSuite: vi.fn() }));
vi.mock("../../harness/test-scheduler.js", () => ({ scheduleTests: vi.fn() }));
vi.mock("../../lib/output.js", () => ({ getOutputMode: () => "json", output: vi.fn(), outputError: vi.fn() }));
const exitCode = process.exitCode;
beforeEach(() => { vi.clearAllMocks(); process.exitCode = undefined; });
afterEach(() => { process.exitCode = exitCode; });
describe("explicit language suites", () => {
    it.each(["python", "rust", "go"])("routes %s to the project adapter", async language => {
        vi.mocked(runLanguageTestSuite).mockResolvedValue({ status: "passed", durationMs: 1, reason: "tested", output: "", scope: "project", reusable: false });
        await testsSuiteCommand(language, { cwd: process.cwd(), timeout: "1234", json: true });
        expect(runLanguageTestSuite).toHaveBeenCalledWith({ root: process.cwd(), language, timeoutMs: 1234, recovery: true });
        expect(scheduleTests).not.toHaveBeenCalled();
        expect(output).toHaveBeenCalledWith("json", expect.objectContaining({ status: "passed", reusable: false }), expect.any(Object));
    });
    it("exits unsuccessfully on missing behavioral evidence", async () => {
        vi.mocked(runLanguageTestSuite).mockResolvedValue({ status: "unavailable", durationMs: 0, reason: "runner missing", output: "", scope: "project", reusable: false });
        await testsSuiteCommand("python", { json: true });
        expect(process.exitCode).toBe(1);
    });
    it.each(["java", "typo"])("rejects unsupported language %s before starting a runner", async language => {
        await testsSuiteCommand(language, { json: true });
        expect(outputError).toHaveBeenCalledWith("json", expect.stringContaining("Unsupported test suite language"));
        expect(runLanguageTestSuite).not.toHaveBeenCalled();
        expect(scheduleTests).not.toHaveBeenCalled();
    });
});
