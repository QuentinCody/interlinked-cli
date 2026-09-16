import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PythonCoverageRunner, type SpawnFn } from "./coverage-runner.js";
import { createCoverageOverlay } from "./coverage-overlay.js";
import { parsePytestCaseEvidence, pytestCaseInvocation, readPytestCaseEvidence } from "./pytest-case-evidence.js";

const identity = "case-evidence-fixture";
function report(cases: unknown[], overrides = {}) {
    return { identity, finished: true, exit: 0, collectionErrors: 0, collectionSkips: 0, cases, ...overrides };
}
function testCase(id: string, call = "passed") {
    return { id, phases: { setup: "passed", call, teardown: "passed" } };
}

describe("structured pytest case evidence", () => {
    it("keeps assertion passes distinct from a failing instrumentation exit", () => {
        expect(parsePytestCaseEvidence(report([testCase("test_x.py::test_x")], { exit: 1 }), identity))
            .toMatchObject({ status: "passed", passed: 1, failed: 0 });
    });
    it("reports failed assertions with exact case identities", () => {
        expect(parsePytestCaseEvidence(report([testCase("test_x.py::test_x", "failed")], { exit: 1 }), identity))
            .toMatchObject({ status: "failed", failed: 1, failingTests: ["test_x.py::test_x"] });
    });
    it.each(["passed", "failed"])("rejects %s cases from distributed or original source execution", outcome => {
        const cases = [testCase("test_x.py::test_x", outcome)];
        expect(parsePytestCaseEvidence(report(cases, { distributed: true }), identity))
            .toMatchObject({ status: "unavailable", reason: expect.stringContaining("Distributed") });
        expect(parsePytestCaseEvidence(report(cases, { runtime: { status: "invalid", violations: ["src/module.py"] } }), identity))
            .toMatchObject({ status: "unavailable", reason: expect.stringContaining("original project") });
    });
    it("retains a known failure alongside incomplete collection and another unfinished case", () => {
        const raw = report([testCase("test_a.py::test_bad", "failed"), { id: "test_b.py::test_pending", phases: {} }],
            { collectionErrors: 1, exit: 2 });
        expect(parsePytestCaseEvidence(raw, identity)).toMatchObject({ status: "failed", complete: false, failed: 1,
            failingTests: ["test_a.py::test_bad"] });
    });
    it.each([
        { setup: "failed", teardown: "passed" },
        { setup: "passed", call: "passed", teardown: "failed" },
    ])("preserves setup and teardown failures as failed test executions", phases => {
        expect(parsePytestCaseEvidence(report([{ id: "test_x.py::test_x", phases }], { exit: 1 }), identity))
            .toMatchObject({ status: "failed", complete: true, failed: 1 });
    });
    it.each([
        report([]), report([testCase("test_x.py::test_x", "skipped")]),
        report([testCase("test_x.py::test_x")], { collectionErrors: 1 }),
        report([testCase("test_x.py::test_x")], { collectionSkips: 1 }),
        report([testCase("test_x.py::test_x")], { exit: 2 }),
        report([testCase("test_x.py::test_x")], { identity: "stale" }),
        report([{ id: "test_x.py::test_x", phases: { setup: "passed" } }]),
        report([testCase("test_x.py::test_x"), testCase("test_x.py::test_x")]),
    ])("does not invent complete execution from empty, skipped or incomplete evidence", raw => {
        expect(parsePytestCaseEvidence(raw, identity).status).toBe("unavailable");
    });
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-pytest-cases-")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("Python coverage evidence plumbing", () => {
    it.each([
        { original: "/original", staged: "/staged" },
        { original: "/original", staged: "/wrong", status: "checked" },
    ])("requires matching roots and a recognized runtime proof status", runtime => {
        const reportPath = join(root, "cases.json");
        writeFileSync(reportPath, JSON.stringify(report([testCase("test_x.py::test_x")], { runtime })));
        const evidence = readPytestCaseEvidence({ command: [], report: reportPath, identity,
            runtime: { original: "/original", staged: "/staged" } });
        expect(evidence).toMatchObject({ status: "unavailable", reason: expect.stringContaining("identity") });
        expect(existsSync(reportPath)).toBe(false);
    });
    it("does not reuse coverage from a previous run when the new run emits nothing", async () => {
        writeFileSync(join(root, "coverage.json"), JSON.stringify({ files: { "module.py": { executed_lines: [1], missing_lines: [] } } }));
        const spawn: SpawnFn = async () => ({ status: 0, stdout: "", stderr: "" });
        const result = await new PythonCoverageRunner(spawn).run({ projectRoot: root, coverageDir: root });
        expect(result).toMatchObject({ ok: false, testsPassed: null });
        expect(result.perFile.size).toBe(0);
    });
    it("retains a failed assertion when coverage instrumentation emits no report", async () => {
        const spawn: SpawnFn = async (_command, args) => {
            const evidencePath = args[3]!;
            mkdirSync(join(root, "coverage"), { recursive: true });
            writeFileSync(evidencePath, JSON.stringify(report([testCase("test_x.py::test_x", "failed")], { identity: args[4], exit: 1 })));
            return { status: 1, stdout: "", stderr: "" };
        };
        const result = await new PythonCoverageRunner(spawn).run({ projectRoot: root, coverageDir: join(root, "coverage") });
        expect(result).toMatchObject({ ok: false, testsPassed: false, failingTestFiles: ["test_x.py"] });
    });
    it("preserves custom argv and refuses to promote textual output to a verdict", async () => {
        const commands: string[][] = [];
        const spawn: SpawnFn = async (command, args) => {
            commands.push([command, ...args]);
            return { status: 0, stdout: "999 passed", stderr: "" };
        };
        const custom = ["custom-python", "my-test-wrapper.py"];
        const result = await new PythonCoverageRunner(spawn).run({ projectRoot: root, coverageDir: root, testCommand: custom });
        expect(commands).toEqual([custom]);
        expect(result.testsPassed).toBeNull();
    });
});

const nativePython = spawnSync("python3", ["-B", "-c", "import pytest, pytest_cov, sys; print(sys.executable)"], { timeout: 5000, encoding: "utf8" });
const hasPytest = nativePython.status === 0;

describe.runIf(hasPytest)("native pytest observer", () => {
    function runCase(test: string, args: string[] = []) {
        writeFileSync(join(root, "test_sample.py"), test);
        const invocation = pytestCaseInvocation(root, join(root, "reports"), ["test_sample.py", "-q", ...args],
            { runtime: { pythonExecutable: "python3" } });
        const result = spawnSync(invocation.command[0]!, invocation.command.slice(1), { cwd: root, encoding: "utf8", timeout: 15000 });
        return { evidence: readPytestCaseEvidence(invocation), result, invocation };
    }
    it("observes actual passing and failing cases in one invocation", () => {
        const { evidence, result } = runCase("def test_good():\n    assert 2 + 2 == 4\ndef test_bad():\n    assert 2 + 2 == 5\n");
        expect(result.status).toBe(1);
        expect(evidence).toMatchObject({ status: "failed", collected: 2, passed: 1, failed: 1 });
    });
    it("PythonCoverageRunner measures actual cases and source coverage together", async () => {
        writeFileSync(join(root, "module.py"), "def answer():\n    return 42\n");
        writeFileSync(join(root, "test_sample.py"), "from module import answer\ndef test_answer():\n    assert answer() == 42\n");
        const result = await new PythonCoverageRunner().run({ projectRoot: root, coverageDir: join(root, "reports"), timeoutMs: 15000 });
        expect(result).toMatchObject({ ok: true, testsPassed: true, testEvidence: { passed: 1, failed: 0 } });
        expect(result.perFile.get("module.py")?.coveredLines?.has(2)).toBe(true);
    });
    it("runs proposed overlay source through the original project environment, then verifies repair", async () => {
        const executable = nativePython.stdout.trim();
        mkdirSync(join(root, ".venv", "bin"), { recursive: true });
        symlinkSync(executable, join(root, ".venv", "bin", "python"));
        writeFileSync(join(root, ".venv", "pyvenv.cfg"), `home = ${dirname(executable)}\ninclude-system-site-packages = true\n`);
        const original = "def answer():\n    return 42\n";
        writeFileSync(join(root, "public_contract.py"), original);
        writeFileSync(join(root, "pytest.ini"), "[pytest]\ntestpaths = .\n");
        writeFileSync(join(root, "test_public_contract.py"), "from public_contract import answer\ndef test_answer():\n    assert answer() == 42\n");
        const runner = new PythonCoverageRunner();
        const baseline = await runner.run({ projectRoot: root, runtimeRoot: root, coverageDir: join(root, "reports"), timeoutMs: 15000 });
        expect(baseline).toMatchObject({ ok: true, testsPassed: true });
        const broken = createCoverageOverlay(root, "public_contract.py", "def answer():\n    return 43\n");
        const repaired = createCoverageOverlay(root, "public_contract.py", original);
        try {
            const result = await runner.run({ projectRoot: broken.overlayRoot, runtimeRoot: root, coverageDir: join(broken.overlayRoot, "reports"), timeoutMs: 15000 });
            expect(result).toMatchObject({ ok: true, testsPassed: false, testEvidence: { failed: 1, complete: true } });
            expect(readFileSync(join(root, "public_contract.py"), "utf8")).toBe(original);
            const green = await runner.run({ projectRoot: repaired.overlayRoot, runtimeRoot: root, coverageDir: join(repaired.overlayRoot, "reports"), timeoutMs: 15000 });
            expect(green).toMatchObject({ ok: true, testsPassed: true, testEvidence: { passed: 1 } });
        } finally { broken.cleanup(); repaired.cleanup(); }
    });
    it("does not mislabel coverage threshold failure as a failed assertion", () => {
        writeFileSync(join(root, "module.py"), "def answer(flag):\n    if flag:\n        return 42\n    return 0\n");
        const { evidence, result } = runCase("from module import answer\ndef test_answer():\n    assert answer(True) == 42\n",
            ["--cov=module", "--cov-fail-under=100"]);
        expect(result.status).toBe(1);
        expect(evidence).toMatchObject({ status: "passed", passed: 1, failed: 0 });
    });
    it.each([42, 43])("invalidates original src imports even when their answer is %s", async answer => {
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "editable_contract.py"), `def answer():\n    return ${answer}\n`);
        writeFileSync(join(root, "test_contract.py"), "from editable_contract import answer\ndef test_answer():\n    assert answer() == 42\n");
        vi.stubEnv("PYTHONPATH", join(root, "src"));
        const overlay = createCoverageOverlay(root, "src/editable_contract.py", `def answer():\n    return ${85 - answer}\n`);
        try {
            const result = await new PythonCoverageRunner().run({ projectRoot: overlay.overlayRoot, runtimeRoot: root,
                coverageDir: join(overlay.overlayRoot, "reports"), timeoutMs: 15000 });
            expect(result.testsPassed).toBeNull();
            expect(result.testEvidence).toMatchObject({ status: "unavailable", reason: expect.stringContaining("src/editable_contract.py") });
        } finally { overlay.cleanup(); }
    });
    it.each([
        { destination: "numprocesses", value: "2", fallback: "0" },
        { destination: "dist", value: "load", fallback: "no" },
        { destination: "tx", value: "popen", fallback: "" },
    ])("reports active $destination without assuming worker collection completeness", ({ destination, value, fallback }) => {
        writeFileSync(join(root, "conftest.py"), `def pytest_addoption(parser):\n    parser.addoption('--probe-workers', dest='${destination}', default='${fallback}')\n`);
        const { evidence, result } = runCase("def test_ok():\n    assert True\n", ["--probe-workers", value]);
        expect(result.status).toBe(0);
        expect(evidence).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Distributed") });
    });
    it("all skipped cases do not establish passing behavior", () => {
        const { evidence } = runCase("import pytest\n@pytest.mark.skip(reason='unavailable')\ndef test_skip():\n    assert False\n");
        expect(evidence).toMatchObject({ status: "unavailable", skipped: 1 });
    });
    it("collection failure does not masquerade as a code regression", () => {
        const { evidence } = runCase("import nonexistent_dependency_for_probe\n");
        expect(evidence.status).toBe("unavailable");
    });
    it("retains an actual test failure when pytest also reports a collection error", () => {
        writeFileSync(join(root, "test_broken.py"), "import nonexistent_dependency_for_probe\n");
        const { evidence } = runCase("def test_bad():\n    assert False\n", ["test_broken.py", "--continue-on-collection-errors"]);
        expect(evidence).toMatchObject({ status: "failed", complete: false, failed: 1 });
    });
    it.each([
        "import pytest\n@pytest.fixture\ndef value():\n    raise ValueError('setup failed')\ndef test_value(value):\n    assert value\n",
        "import pytest\n@pytest.fixture\ndef value():\n    yield 42\n    raise ValueError('teardown failed')\ndef test_value(value):\n    assert value == 42\n",
    ])("observes native fixture execution failures", source => {
        expect(runCase(source).evidence).toMatchObject({ status: "failed", failed: 1 });
    });
    it("reading normalized evidence removes the owned transport file", () => {
        const { invocation } = runCase("def test_ok():\n    assert True\n");
        expect(existsSync(invocation.report)).toBe(false);
        expect(readPytestCaseEvidence(invocation).status).toBe("unavailable");
    });
});
