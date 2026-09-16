import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { CoverageRunOpts, CoverageRunResult } from "./coverage-runner.js";
import { defaultPythonTestCommand } from "./coverage-runner-commands.js";
import { type PythonTestInvocationOptions, resolvePythonTestInvocation } from "./python-test-runtime.js";
import { PYTEST_CASE_PLUGIN } from "./pytest-case-plugin.js";

export function clearPythonCoverageReport(coverageDir: string): boolean {
    return removeOwnedReport(join(coverageDir, "coverage.json"));
}

function removeOwnedReport(path: string): boolean {
    try {
        rmSync(path, { force: true });
        return true;
    } catch { return false; }
}

export interface TestExecutionEvidence {
    status: "passed" | "failed" | "unavailable";
    complete: boolean;
    collected: number;
    passed: number;
    failed: number;
    skipped: number;
    reason?: string;
    failingTests: string[];
}

export interface PythonCoverageInvocation {
    command: string[];
    report: string;
    identity: string;
    runtime?: { original: string; staged: string } | undefined;
}

interface PytestCaseOptions {
    override?: string[] | undefined;
    runtime?: PythonTestInvocationOptions | undefined;
    observation?: PythonCoverageInvocation["runtime"];
}

function canonicalRoot(root: string): string {
    try { return realpathSync(root); } catch { return resolve(root); }
}

export function pythonCoverageInvocation(opts: CoverageRunOpts): PythonCoverageInvocation {
    const args = defaultPythonTestCommand(opts.coverageDir, opts.selectedTests).slice(1);
    const original = canonicalRoot(opts.runtimeRoot ?? opts.projectRoot);
    const staged = canonicalRoot(opts.projectRoot);
    const observation = original === staged ? undefined : { original, staged };
    return pytestCaseInvocation(opts.runtimeRoot ?? opts.projectRoot, opts.coverageDir, args, { override: opts.testCommand, observation });
}

export function pytestCaseInvocation(root: string, reportDir: string, args: string[], options: PytestCaseOptions = {}): PythonCoverageInvocation {
    const identity = randomUUID();
    const report = join(reportDir, `pytest-cases-${identity}.json`);
    if (options.override) return { command: options.override, report, identity };
    const runtime = resolvePythonTestInvocation(root, options.runtime);
    return { command: [runtime.command, "-B", "-c", PYTEST_CASE_PLUGIN, report, identity, JSON.stringify(options.observation ?? null), ...args], report, identity, runtime: options.observation };
}

function unavailable(reason: string): TestExecutionEvidence {
    return { status: "unavailable", complete: false, collected: 0, passed: 0, failed: 0, skipped: 0, failingTests: [], reason };
}

function validReport(raw: unknown, identity: string): raw is Record<string, unknown> & { cases: unknown[] } {
    return isJsonObject(raw) && raw.identity === identity && Array.isArray(raw.cases);
}

interface CasePhases { outcome: "passed" | "failed" | "skipped"; complete: boolean; }

function phaseOutcome(phases: Record<string, unknown>): CasePhases | null {
    const { setup, call, teardown } = phases;
    if ([setup, call, teardown].includes("failed")) {
        return { outcome: "failed", complete: teardown === "passed" || teardown === "failed" };
    }
    if (teardown !== "passed") return null;
    if (setup === "skipped") return { outcome: "skipped", complete: true };
    if (setup !== "passed" || (call !== "passed" && call !== "skipped")) return null;
    return { outcome: call, complete: true };
}

function caseOutcome(raw: unknown): (CasePhases & { id: string }) | null {
    if (!isJsonObject(raw) || typeof raw.id !== "string" || !isJsonObject(raw.phases)) return null;
    const phases = phaseOutcome(raw.phases);
    return phases ? { id: raw.id, ...phases } : null;
}

function collectionComplete(raw: Record<string, unknown>): boolean {
    return raw.finished === true && (raw.exit === 0 || raw.exit === 1) && raw.collectionErrors === 0 && raw.collectionSkips === 0;
}

function summarizeCases(result: TestExecutionEvidence): TestExecutionEvidence {
    if (result.failed) result.status = "failed";
    else if (result.complete && result.passed) result.status = "passed";
    if (!result.complete) result.reason = "Pytest collection or case execution is incomplete; observed failures remain valid";
    else if (!result.passed && !result.failed) result.reason = "Pytest executed no passing or failing test cases";
    return result;
}

function unsupportedExecution(raw: Record<string, unknown>): string | null {
    if (raw.distributed === true) return "Distributed pytest collection completeness is not supported";
    if (!isJsonObject(raw.runtime)) return null;
    if (raw.runtime.status === "invalid") return `Pytest imported original project modules outside the staged tree: ${JSON.stringify(raw.runtime.violations)}`;
    if (raw.runtime.status === "unknown") return "Pytest could not verify staged module origins";
    return null;
}

export function parsePytestCaseEvidence(raw: unknown, identity: string): TestExecutionEvidence {
    if (!validReport(raw, identity)) return unavailable("Pytest collection or execution evidence is incomplete");
    const unsupported = unsupportedExecution(raw);
    if (unsupported) return unavailable(unsupported);
    const result: TestExecutionEvidence = { status: "unavailable", complete: collectionComplete(raw), collected: raw.cases.length, passed: 0, failed: 0, skipped: 0, failingTests: [] };
    const seen = new Set<string>();
    for (const entry of raw.cases) {
        const row = caseOutcome(entry);
        if (!row || seen.has(row.id)) { result.complete = false; continue; }
        seen.add(row.id);
        result.complete &&= row.complete;
        result[row.outcome]++;
        if (row.outcome === "failed") result.failingTests.push(row.id);
    }
    return summarizeCases(result);
}

function runtimeProofMatches(raw: unknown, expected: PythonCoverageInvocation["runtime"]): boolean {
    if (!expected) return true;
    if (!isJsonObject(raw) || !isJsonObject(raw.runtime)) return false;
    return raw.runtime.original === expected.original && raw.runtime.staged === expected.staged &&
        ["checked", "invalid", "unknown"].includes(String(raw.runtime.status));
}

export function readPytestCaseEvidence(invocation: PythonCoverageInvocation): TestExecutionEvidence {
    try {
        const raw: unknown = JSON.parse(readFileSync(invocation.report, "utf8"));
        if (!runtimeProofMatches(raw, invocation.runtime)) return unavailable("Pytest staged runtime identity evidence is missing or mismatched");
        return parsePytestCaseEvidence(raw, invocation.identity);
    } catch {
        return unavailable("No fresh structured pytest case evidence; command output is not a test verdict");
    } finally {
        // This nonce-named transport file is owned by this invocation. Callers retain
        // normalized evidence; overlays and suite temp roots must not accumulate it.
        removeOwnedReport(invocation.report);
    }
}

export function withPytestEvidence(result: CoverageRunResult, invocation: PythonCoverageInvocation): CoverageRunResult {
    const testEvidence = readPytestCaseEvidence(invocation);
    const testsPassed = testEvidence.status === "unavailable" ? null : testEvidence.status === "passed";
    return { ...result, testsPassed, testEvidence, failingTests: testEvidence.failingTests,
        failingTestFiles: [...new Set(testEvidence.failingTests.map(id => id.split("::")[0]!))] };
}
