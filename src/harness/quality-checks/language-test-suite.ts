import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goBuildTagArgs, goToolTags } from "../check-engine/tool-runners/go-invocation.js";
import { resolvePythonTestInvocation, type PythonTestInvocationOptions } from "../python-test-runtime.js";
import { pytestCaseInvocation, readPytestCaseEvidence, type PythonCoverageInvocation } from "../pytest-case-evidence.js";
import type { LanguageId } from "../types.js";
import { runBoundedTestProcess } from "./test-process-gate.js";

export interface LanguageSuiteOptions {
    root: string;
    language: LanguageId;
    timeoutMs: number;
    recovery?: boolean;
    signal?: AbortSignal;
    python?: PythonTestInvocationOptions;
}
export interface LanguageSuiteResult {
    status: "passed" | "failed" | "unavailable";
    reason: string;
    output: string;
    durationMs: number;
    scope: "project";
    reusable: false;
    reasonCode?: string;
}

/** Conservative whole-project behavior; no filename-based dependency inference. */
export function languageSuiteCommand(root: string, language: LanguageId, python?: PythonTestInvocationOptions): { command: string; args: string[] } | null {
    if (language === "python") return resolvePythonTestInvocation(root, python);
    if (language === "rust") return { command: "cargo", args: ["test", "--offline", "--jobs", "2", "--", "--test-threads=2"] };
    if (language === "go") return { command: "go", args: ["test", "-json", "-count=1", "-p", "2", ...goBuildTagArgs(goToolTags(process.env)), "./..."] };
    return null;
}

function observedPassingTests(language: LanguageId, output: string): boolean {
    if (language === "rust") return /test result: ok\. [1-9]\d* passed;/.test(output);
    if (language === "go") {
        return output.split("\n").some(line => {
            try {
                const value: unknown = JSON.parse(line);
                return typeof value === "object" && value !== null && "Action" in value && value.Action === "pass" &&
                    "Test" in value && typeof value.Test === "string" && value.Test.length > 0;
            } catch { return false; }
        });
    }
    return false;
}

function pythonUnavailable(code: number, output: string): Pick<LanguageSuiteResult, "status" | "reason" | "reasonCode"> | null {
    if (/No module named ['"]?pytest\b/.test(output)) return {
        status: "unavailable", reasonCode: "runner_missing", reason: "pytest is missing from the selected Python environment; no tests ran. Run interlinked tests readiness python --json for the selected interpreter and approved provisioning argv",
    };
    const reasons: Record<number, [string, string]> = {
        2: ["collection_or_interruption", "pytest collection failed or execution was interrupted; no complete test verdict"],
        3: ["runner_error", "pytest encountered an internal error; no complete test verdict"],
        4: ["configuration_error", "pytest command or configuration was invalid; no complete test verdict"],
        5: ["no_tests", "pytest collected no tests; no behavioral evidence"],
    };
    const reason = reasons[code];
    return reason ? { status: "unavailable", reasonCode: reason[0], reason: reason[1] } : null;
}

function classifySuite(language: LanguageId, code: number, output: string): Pick<LanguageSuiteResult, "status" | "reason" | "reasonCode"> {
    if (code !== 0) return { status: "failed", reason: "Project test command failed; failure is not classified as introduced without a baseline" };
    if (!observedPassingTests(language, output)) return { status: "unavailable", reasonCode: "no_observed_tests", reason: "Runner reported no observable passing tests; empty, skipped-only or unrecognized output is not behavioral evidence" };
    return { status: "passed", reason: "Configured project suite executed passing tests; new requirements still need public-contract review" };
}

function classifyPythonSuite(code: number, output: string, invocation: PythonCoverageInvocation): Pick<LanguageSuiteResult, "status" | "reason" | "reasonCode"> {
    const evidence = readPytestCaseEvidence(invocation);
    if (evidence.status === "failed") return { status: "failed", reason: evidence.complete
        ? "Project tests failed; failure is not classified as introduced without a baseline"
        : "Observed project tests failed and the suite is incomplete; no clean verdict is available" };
    const unavailable = pythonUnavailable(code, output);
    if (unavailable) return unavailable;
    if (evidence.status === "unavailable") return { status: "unavailable", reasonCode: "incomplete_evidence", reason: evidence.reason ?? "No complete pytest case evidence" };
    if (code !== 0 && evidence.status === "passed") return { status: "unavailable", reasonCode: "command_error", reason: "Pytest cases passed but the command failed; inspect plugin or coverage requirements" };
    return { status: "passed", reason: `Pytest observed ${evidence.passed} passing test cases; new requirements still need public-contract review` };
}

async function executeSuite(options: LanguageSuiteOptions, command: { command: string; args: string[] }, invocation?: PythonCoverageInvocation): Promise<LanguageSuiteResult> {
    const started = Date.now();
    const base = { scope: "project" as const, reusable: false as const };
    const result = await runBoundedTestProcess({ ...command, cwd: options.root, timeoutMs: options.timeoutMs,
        waitForCapacity: options.recovery === true, ...(options.signal ? { signal: options.signal } : {}) });
    const durationMs = Date.now() - started;
    if (result.kind === "deferred") return { ...base, status: "unavailable", reasonCode: result.reason, reason: `Project tests ${result.reason}`, output: "", durationMs };
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const verdict = invocation ? classifyPythonSuite(result.code, output, invocation) : classifySuite(options.language, result.code, output);
    return { ...base, ...verdict, output: output.split("\n").slice(-30).join("\n").slice(-6000), durationMs };
}

/** Observed execution only. This does not certify a dependency closure or enable reuse. */
export async function runLanguageTestSuite(options: LanguageSuiteOptions): Promise<LanguageSuiteResult> {
    const command = languageSuiteCommand(options.root, options.language, options.python);
    if (!command) return { scope: "project", reusable: false, status: "unavailable", reason: `No qualified project test adapter for ${options.language}`, output: "", durationMs: 0 };
    if (options.language !== "python") return executeSuite(options, command);
    const reportDir = mkdtempSync(join(tmpdir(), "interlinked-pytest-suite-"));
    try {
        const invocation = pytestCaseInvocation(options.root, reportDir, command.args.slice(3), { runtime: options.python });
        return await executeSuite(options, { command: invocation.command[0]!, args: invocation.command.slice(1) }, invocation);
    } finally {
        rmSync(reportDir, { recursive: true, force: true });
    }
}
