import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPytestCaseEvidence } from "../pytest-case-evidence.js";
import { languageSuiteCommand, runLanguageTestSuite } from "./language-test-suite.js";
import { runBoundedTestProcess } from "./test-process-gate.js";

vi.mock("./test-process-gate.js", () => ({ runBoundedTestProcess: vi.fn() }));
vi.mock("../pytest-case-evidence.js", async importOriginal => ({
    ...await importOriginal<typeof import("../pytest-case-evidence.js")>(),
    readPytestCaseEvidence: vi.fn(),
}));
const run = vi.mocked(runBoundedTestProcess);
const evidence = vi.mocked(readPytestCaseEvidence);
beforeEach(() => {
    run.mockReset();
    evidence.mockReset().mockReturnValue({ status: "passed", complete: true, collected: 3, passed: 3, failed: 0, skipped: 0, failingTests: [] });
});

const hostPython = process.platform === "win32" ? "python" : "python3";
const hasPytest = spawnSync(hostPython, ["-B", "-c", "import pytest"], { timeout: 5000, stdio: "ignore" }).status === 0;
describe.skipIf(!hasPytest)("project suite with real pytest case evidence", () => {
    async function realSuite(root: string) {
        const actual = await vi.importActual<typeof import("../pytest-case-evidence.js")>("../pytest-case-evidence.js");
        evidence.mockImplementation(actual.readPytestCaseEvidence);
        run.mockImplementation(async spec => {
            const result = spawnSync(spec.command, spec.args, { cwd: spec.cwd, encoding: "utf8", timeout: spec.timeoutMs,
                env: { ...process.env, PYTEST_ADDOPTS: "", PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1" } });
            return { kind: "completed", code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
        });
        return runLanguageTestSuite({ root, language: "python", timeoutMs: 10000, python: { pythonExecutable: hostPython } });
    }

    it("runs the configured layout and reads its case evidence without trusting terminal output", async () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-suite-test-"));
        try {
            mkdirSync(join(root, "specs"));
            writeFileSync(join(root, "pytest.ini"), "[pytest]\ntestpaths = specs\npython_files = check_*.py\n");
            writeFileSync(join(root, "specs", "check_ok.py"), "def test_behavior():\n    assert 4 == 2 + 2\n");
            writeFileSync(join(root, "check_wrong_scope.py"), "def test_wrong_scope():\n    assert False\n");
            expect(await realSuite(root)).toMatchObject({ status: "passed", reusable: false, reason: expect.stringContaining("1 passing test cases") });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("retains real collection-error diagnostics instead of returning a clean verdict", async () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-suite-test-"));
        try {
            writeFileSync(join(root, "test_import.py"), "import absent_interlinked_fixture_module\n");
            expect(await realSuite(root)).toMatchObject({ status: "unavailable", reasonCode: "collection_or_interruption",
                output: expect.stringContaining("absent_interlinked_fixture_module") });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe("project behavioral suites", () => {
    it.each([
        ["python", "3 passed in 0.02s"],
        ["rust", "test result: ok. 3 passed; 0 failed;"],
        ["go", '{"Action":"pass","Test":"TestBoundary"}'],
    ] as const)("requires observed tests for %s and never labels this result reusable", async (language, stdout) => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout, stderr: "" });
        expect(await runLanguageTestSuite({ root: "/repo", language, timeoutMs: 1500, recovery: true })).toMatchObject({ status: "passed", reusable: false, scope: "project" });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo", waitForCapacity: true, timeoutMs: 1500 }));
    });
    it.each(["python", "rust", "go"] as const)("does not accept an empty %s suite", async language => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout: "", stderr: "" });
        evidence.mockReturnValue({ status: "unavailable", complete: false, collected: 0, passed: 0, failed: 0, skipped: 0, failingTests: [], reason: "No tests" });
        expect(await runLanguageTestSuite({ root: "/repo", language, timeoutMs: 1000 })).toMatchObject({ status: "unavailable" });
    });
    it("keeps Go package-only pass rows distinct from executed tests", async () => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout: '{"Action":"pass","Package":"example"}', stderr: "" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "go", timeoutMs: 1000 })).toMatchObject({ status: "unavailable" });
    });
    it("runs Rust assertions, all Go packages, and Python project tests without installing tools", () => {
        expect(languageSuiteCommand("/repo", "rust")?.args).toEqual(["test", "--offline", "--jobs", "2", "--", "--test-threads=2"]);
        expect(languageSuiteCommand("/repo", "go")?.args).toContain("./...");
        expect(languageSuiteCommand("/repo", "python")?.args).toEqual(["-B", "-m", "pytest", "--tb=short", "-q"]);
        expect(languageSuiteCommand("/repo", "java")).toBeNull();
    });
    it.each(["busy", "timeout", "interrupted", "unavailable"] as const)("retains %s as missing evidence", async reason => {
        run.mockResolvedValue({ kind: "deferred", reason });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "unavailable" });
    });
    it("does not suppress current import/build failures as supposedly pre-existing", async () => {
        run.mockResolvedValue({ kind: "completed", code: 101, stdout: "", stderr: "unresolved import" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "rust", timeoutMs: 1000 })).toMatchObject({ status: "failed", output: "unresolved import" });
    });
    it.each([[2, "collection_or_interruption"], [3, "runner_error"], [4, "configuration_error"], [5, "no_tests"]] as const)("distinguishes pytest exit %s as incomplete execution", async (code, reasonCode) => {
        run.mockResolvedValue({ kind: "completed", code, stdout: "", stderr: "collection failed" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "unavailable", reasonCode, output: "collection failed" });
    });
    it("retains missing-runner diagnostics for the selected interpreter without retrying another environment", async () => {
        run.mockResolvedValue({ kind: "completed", code: 1, stdout: "", stderr: "/chosen/python: No module named pytest" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000,
            python: { pythonExecutable: "/chosen/python" } })).toMatchObject({ status: "unavailable", reasonCode: "runner_missing", output: "/chosen/python: No module named pytest" });
        expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: "/chosen/python" }));
    });
    it("does not treat all-skipped output as observed passing behavior", async () => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout: "3 skipped in 0.1s", stderr: "" });
        evidence.mockReturnValue({ status: "unavailable", complete: false, collected: 3, passed: 0, failed: 0, skipped: 3, failingTests: [], reason: "No passing tests" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "unavailable", reasonCode: "incomplete_evidence" });
    });
    it("bounds a diagnostic's characters as well as its line count", async () => {
        run.mockResolvedValue({ kind: "completed", code: 2, stdout: "", stderr: "x".repeat(10000) + "ImportError: missing_widget" });
        const result = await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 });
        expect(result.output.length).toBeLessThanOrEqual(6000);
        expect(result.output).toContain("ImportError: missing_widget");
    });
    it("requires structured case evidence even when command output claims success", async () => {
        run.mockResolvedValue({ kind: "completed", code: 0, stdout: "100 passed in 0.01s", stderr: "" });
        evidence.mockReturnValue({ status: "unavailable", complete: false, collected: 0, passed: 0, failed: 0, skipped: 0, failingTests: [], reason: "No fresh report" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "unavailable", reasonCode: "incomplete_evidence" });
    });
    it("preserves a failed case verdict independently of terminal summary formatting", async () => {
        run.mockResolvedValue({ kind: "completed", code: 1, stdout: "custom output", stderr: "" });
        evidence.mockReturnValue({ status: "failed", complete: true, collected: 3, passed: 2, failed: 1, skipped: 0, failingTests: ["test_behavior.py::test_case"] });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "failed" });
    });
    it("does not call a failed command clean merely because its test cases passed", async () => {
        run.mockResolvedValue({ kind: "completed", code: 1, stdout: "3 passed", stderr: "Coverage failure: below required floor" });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "unavailable", reasonCode: "command_error", output: expect.stringContaining("Coverage failure") });
    });
    it("retains known case failures even when another part of the suite did not complete", async () => {
        run.mockResolvedValue({ kind: "completed", code: 2, stdout: "", stderr: "Other module did not collect" });
        evidence.mockReturnValue({ status: "failed", complete: false, collected: 3, passed: 0, failed: 1, skipped: 0, failingTests: ["test_behavior.py::test_case"] });
        expect(await runLanguageTestSuite({ root: "/repo", language: "python", timeoutMs: 1000 })).toMatchObject({ status: "failed", reason: expect.stringContaining("incomplete") });
    });
});
