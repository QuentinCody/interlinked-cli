import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCyclomaticPython } from "./checks/cyclomatic-python.js";
import type { PerFileCoverage } from "./coverage-final-reader.js";
import { pythonFunctionCoverageIssue } from "./coverage-python-functions.js";
import { PythonCoverageRunner } from "./coverage-runner.js";
import { crapViolationsPerLine } from "./evaluator/crap-violations.js";

const python = spawnSync("python3", ["-c", "import pytest, pytest_cov, coverage; assert coverage.version_info[:3] >= (7, 13, 1)"], { timeout: 5000 });
const radon = spawnSync("radon", ["--version"], { timeout: 5000 });
const SOURCE = `def identity(fn):
    return fn

@identity
def outer(flag):
    def inner(value):
        if value:
            return 1
        return 2
    return 42 if flag else 0

class Service:
    @staticmethod
    def answer(flag):
        if flag:
            return 42
        return 0  # pragma: no cover

async def async_answer(flag):
    if flag:
        return 42
    return 0

def excluded():  # pragma: no cover
    return "not measured"
`;
const TEST = `import asyncio
from contract import outer, Service, async_answer
def test_public_contract():
    assert outer(True) == 42
    assert Service.answer(True) == 42
    assert asyncio.run(async_answer(True)) == 42
`;

describe.skipIf(python.status !== 0 || radon.status !== 0)("native coverage.py / Radon function contract", () => {
    let root: string;
    let cov: PerFileCoverage;
    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "interlinked-python-regions-"));
        writeFileSync(join(root, "contract.py"), SOURCE);
        writeFileSync(join(root, "test_contract.py"), TEST);
        writeFileSync(join(root, "pytest.ini"), "[pytest]\naddopts = --cov-branch\n");
        const result = await new PythonCoverageRunner().run({ projectRoot: root, coverageDir: join(root, "reports"), timeoutMs: 15000 });
        expect(result).toMatchObject({ ok: true, testsPassed: true, testEvidence: { passed: 1, complete: true } });
        cov = result.perFile.get("contract.py")!;
    }, 20000);
    afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    it("matches decorators, nested functions, methods and async definitions without line-range borrowing", () => {
        const complexities = computeCyclomaticPython(SOURCE, "contract.py")!;
        const measured = complexities.filter((fn) => fn.name !== "excluded");
        expect(measured.map((fn) => fn.name)).toEqual(["identity", "outer", "inner", "answer", "async_answer"]);
        expect(pythonFunctionCoverageIssue(measured, cov.pythonFunctions!)).toBeNull();
        const scores = crapViolationsPerLine(measured, cov, 0);
        expect(Object.fromEntries(scores.map((score) => [score.function, score.coverage_pct]))).toEqual({
            identity: 100, outer: 100, inner: 0, answer: 100, async_answer: (2 / 3) * 100,
        });
    });

    it("retains whole-function exclusions as unmeasured, without inventing call counts", () => {
        const excluded = computeCyclomaticPython(SOURCE, "contract.py")!.filter((fn) => fn.name === "excluded");
        expect(pythonFunctionCoverageIssue(excluded, cov.pythonFunctions!)).toMatch(/no measured executable lines/);
        expect(crapViolationsPerLine(excluded, cov, 0)).toEqual([]);
        expect(cov.functions).toEqual([]);
    });

    it("isolates simultaneous native pytest coverage runs and preserves an existing coverage database", async () => {
        writeFileSync(join(root, ".coverage"), "untouched caller data");
        writeFileSync(join(root, "test_other.py"), "import asyncio\nfrom contract import async_answer\ndef test_other():\n    assert asyncio.run(async_answer(False)) == 0\n");
        const runner = new PythonCoverageRunner();
        const options = { projectRoot: root, coverageDir: join(root, "reports"), timeoutMs: 15000 };
        const results = await Promise.all(["test_contract.py", "test_other.py"].map((test) => runner.run({ ...options, selectedTests: [test] })));
        expect(results.map((result) => result.testsPassed)).toEqual([true, true]);
        expect(results[0]!.perFile.get("contract.py")!.coveredLines!.has(21)).toBe(true);
        expect(results[1]!.perFile.get("contract.py")!.uncoveredLines!.has(21)).toBe(true);
        expect(readFileSync(join(root, ".coverage"), "utf8")).toBe("untouched caller data");
    }, 20000);
});
