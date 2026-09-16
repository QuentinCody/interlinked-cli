import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPythonVirtualEnvironment, resolvePythonTestInvocation } from "./python-test-runtime.js";

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-python-runtime-"));
    roots.push(root);
    return root;
}
function interpreter(root: string, ...parts: string[]): string {
    const directory = join(root, ...parts.slice(0, -1));
    mkdirSync(directory, { recursive: true });
    const path = join(root, ...parts);
    writeFileSync(path, "");
    return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Python test environment selection", () => {
    it("requires an environment configuration and interpreter layout, not a directory name", () => {
        const root = fixture();
        const environment = join(root, "venv");
        interpreter(environment, "bin", "python");
        expect(isPythonVirtualEnvironment(environment)).toBe(false);
        writeFileSync(join(environment, "pyvenv.cfg"), "home = /usr/bin\n");
        expect(isPythonVirtualEnvironment(environment)).toBe(true);
        expect(isPythonVirtualEnvironment(root)).toBe(false);
    });
    it("prefers explicit configuration, then the active environment over project environments", () => {
        const root = fixture(), active = fixture();
        interpreter(root, ".venv", "bin", "python");
        const selected = interpreter(active, "bin", "python");
        expect(resolvePythonTestInvocation(root, { env: { VIRTUAL_ENV: active } }).command).toBe(selected);
        expect(resolvePythonTestInvocation(root, { env: { VIRTUAL_ENV: active }, pythonExecutable: "/explicit python" }).command).toBe("/explicit python");
    });
    it("selects a project venv and gives .venv precedence without falling back from an incomplete environment", () => {
        const root = fixture();
        const legacy = interpreter(root, "venv", "bin", "python");
        expect(resolvePythonTestInvocation(root, { env: {} }).command).toBe(legacy);
        mkdirSync(join(root, ".venv"));
        expect(resolvePythonTestInvocation(root, { env: {}, platform: "linux" }).command).toBe(join(root, ".venv", "bin", "python"));
    });
    it("does not silently abandon an explicitly selected missing environment", () => {
        const root = fixture(), missing = join(root, "missing environment");
        interpreter(root, ".venv", "bin", "python");
        expect(resolvePythonTestInvocation(root, { env: { VIRTUAL_ENV: missing }, platform: "linux" }).command).toBe(join(missing, "bin", "python"));
    });
    it("recognizes Windows virtualenv executables and platform defaults", () => {
        const root = fixture();
        expect(resolvePythonTestInvocation(root, { env: {}, platform: "win32" }).command).toBe("python");
        const selected = interpreter(root, ".venv", "Scripts", "python.exe");
        expect(resolvePythonTestInvocation(root, { env: {}, platform: "win32" }).command).toBe(selected);
    });
    it("preserves explicit selection as argv without injecting a whole-project target", () => {
        expect(resolvePythonTestInvocation(fixture(), { env: {}, selectedTests: ["tests with spaces/test_api.py::test_case"] }).args)
            .toEqual(["-B", "-m", "pytest", "tests with spaces/test_api.py::test_case", "--tb=short", "-q"]);
    });
});

const hostPython = process.platform === "win32" ? "python" : "python3";
const hasPytest = spawnSync(hostPython, ["-B", "-c", "import pytest"], { timeout: 5000, stdio: "ignore" }).status === 0;
describe.skipIf(!hasPytest)("real pytest discovery", () => {
    it("honors configured testpaths and python_files while explicit selection still reaches an excluded failure", () => {
        const root = fixture();
        mkdirSync(join(root, "specs"));
        mkdirSync(join(root, "unrelated"));
        writeFileSync(join(root, "pytest.ini"), "[pytest]\ntestpaths = specs\npython_files = check_*.py\n");
        writeFileSync(join(root, "specs", "check_behavior.py"), "def test_behavior():\n    assert 2 + 2 == 4\n");
        writeFileSync(join(root, "unrelated", "check_failure.py"), "def test_failure():\n    assert False, 'outside configured scope'\n");
        const environment = { ...process.env, PYTEST_ADDOPTS: "", PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1" };
        const configured = resolvePythonTestInvocation(root, { pythonExecutable: hostPython, env: {} });
        const result = spawnSync(configured.command, configured.args, { cwd: root, env: environment, encoding: "utf8", timeout: 10000 });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toMatch(/1 passed/);
        const selected = resolvePythonTestInvocation(root, { pythonExecutable: hostPython, selectedTests: ["unrelated/check_failure.py"] });
        const failure = spawnSync(selected.command, selected.args, { cwd: root, env: environment, encoding: "utf8", timeout: 10000 });
        expect(failure.status, failure.stdout + failure.stderr).toBe(1);
        expect(failure.stdout).toContain("outside configured scope");
    });
});
