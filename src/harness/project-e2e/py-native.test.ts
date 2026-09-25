// Unit D2: a Python-native test layout (pytest under tests/) qualifies through
// the shipped structured-runner route — pytest's JUnit report normalizes the
// exact declared native cases, and the same scenario still binds portable
// contracts for the boundary (plan §10.2 "Pytest + declared boundary", §16
// Unit D "Python-native test layout"). No Python plugin is involved. Where
// pytest is absent the run is explicitly unavailable, never a pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import type { E2eReceipt } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 120_000;
const PYTEST_AVAILABLE = spawnSync("python3", ["-m", "pytest", "--version"], { encoding: "utf8" }).status === 0;
const CASES = ["tests.test_orders::test_add_prints_order", "tests.test_orders::test_add_without_name_fails"];
const TEST_FILE = `import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args, cwd):
    return subprocess.run([sys.executable, os.path.join(ROOT, "orders_cli.py"), *args], cwd=cwd, capture_output=True, text=True)


def test_add_prints_order(tmp_path):
    result = run("add", "widget", cwd=tmp_path)
    assert result.returncode == 0
    assert json.loads(result.stdout)["ok"] is True


def test_add_without_name_fails(tmp_path):
    assert run("add", cwd=tmp_path).returncode == 2
`;
/** The py fixture plus a pytest layout under tests/ and a structured-runner suite that runs it with a JUnit report. */
function pytestFixture(caseIds: string[] = CASES): FixtureProject {
    const project = fixtureProject("py", { accept: true }); projects.push(project);
    mkdirSync(join(project.root, "tests"), { recursive: true });
    writeFileSync(join(project.root, "tests", "test_orders.py"), TEST_FILE);
    const policyPath = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(policyPath, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
    const project0 = policy.projects[0]!;
    project0.protectedInputs = ["orders_cli.py", "tests/**"];
    project0.suites = [{ id: "pytest", adapter: "structured-runner", run: { argv: ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml=report.xml", "tests"] }, report: { format: "junit", path: "report.xml" } }];
    project0.scenarios = [{ id: "orders-native", suite: "pytest", affects: ["orders_cli.py", "tests/**"], contractIds: ["orders.create", "orders.invalid"], caseIds, required: true }];
    writeFileSync(policyPath, JSON.stringify(policy));
    return project;
}
function receiptOf(project: FixtureProject, path: string): E2eReceipt { return JSON.parse(readFileSync(join(project.root, path), "utf8")) as E2eReceipt; } // SAFETY: the receipt this run wrote
function verdict(project: FixtureProject) { return evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!; }

describe("Python-native test layout — positive (pytest JUnit + portable contracts qualify)", () => {
    it.skipIf(!PYTEST_AVAILABLE)("P1: the declared pytest cases pass through the JUnit report, the portable contracts pass through the process driver, and the scenario is satisfied", async () => {
        const project = pytestFixture();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode, result.messages.join("\n")).toBe(0);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        // The fixture also ships tests/test_unit.py: pytest reports 3 cases, the scenario declares 2 — an undeclared native case is observed, never required (§10.1).
        expect(receipt.report).toMatchObject({ format: "junit", path: "report.xml", cases: 3 });
        expect(receipt.cases.filter(row => row.runnerKind === "structured").map(row => [row.id, row.state])).toEqual(CASES.map(id => [id, "passed"]));
        expect(receipt.cases.filter(row => row.runnerKind === "process").map(row => row.state)).toEqual(["passed", "passed"]);
        expect(verdict(project).satisfied).toBe(true);
    }, TIMEOUT);
    it.skipIf(PYTEST_AVAILABLE)("P1-absent: without pytest the run is explicitly unavailable (missing report), never a pass", async () => {
        const project = pytestFixture();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        expect(verdict(project).reasons.map(row => row.code)).toContain("RUN_INCOMPLETE");
    }, TIMEOUT);
});
describe("Python-native test layout — negative (a green pytest run alone never qualifies)", () => {
    it.skipIf(!PYTEST_AVAILABLE)("N1 (PE-08): a declared native case the report does not contain is CASE_NOT_RUN; the passing rest cannot cover it", async () => {
        const project = pytestFixture([...CASES, "tests.test_orders::test_read_back"]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1);
        expect(verdict(project).reasons.map(row => row.code)).toContain("CASE_NOT_RUN");
    }, TIMEOUT);
    it.skipIf(!PYTEST_AVAILABLE)("N2 (PE-23/PE-55): the persistence defect passes every pytest case (they never read back) but fails the portable contract; the scenario fails", async () => {
        const project = pytestFixture();
        injectPersistenceDefect(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1);
        const receipt = receiptOf(project, result.receipts[0]!.path);
        expect(receipt.cases.filter(row => row.runnerKind === "structured").every(row => row.state === "passed")).toBe(true);
        expect(receipt.cases.find(row => row.id === "orders.create")?.state).toBe("failed");
        expect(verdict(project).status).toBe("failed");
    }, TIMEOUT);
});
