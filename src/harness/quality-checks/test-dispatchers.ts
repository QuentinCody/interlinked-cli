// Language-appropriate behavioral checks. Vitest owns dependency-aware selection;
// other registered runners use a bounded project suite and never cache this verdict.
import { join, sep } from "node:path";
import type { LanguageId, LanguageProfile } from "../types.js";
import { scheduleTests } from "../test-scheduler.js";
import { runLanguageTestSuite } from "./language-test-suite.js";

interface TestDispatcherInput {
    filePath: string;
    absPath: string;
    checkCwd: string;
    profile: LanguageProfile;
    timeoutMs: number;
    severity: "error" | "warning";
    checkName: string;
    maxDependentTests?: number;
}
interface TestDispatcherResult {
    name: string;
    severity: "error" | "warning";
    message: string;
    file: string;
    detail: string;
}
export type TestDispatcher = (input: TestDispatcherInput) => TestDispatcherResult[] | Promise<TestDispatcherResult[]>;

export const TEST_DISPATCHERS: Partial<Record<LanguageId, TestDispatcher>> = {
    typescript: runVitestDispatcher,
    python: runProjectDispatcher,
    rust: runProjectDispatcher,
    go: runProjectDispatcher,
};

function unavailable(input: TestDispatcherInput, detail: string): TestDispatcherResult {
    return { name: "affected_tests_deferred", severity: "warning", file: input.filePath,
        message: "Affected tests not measured", detail };
}

async function runVitestDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
    if (!(input.profile.test_runner?.command ?? "npx vitest run").includes("vitest")) {
        return [unavailable(input, "The configured runner is not Vitest; no run was scheduled.")];
    }
    try {
        // A dry-run event never reaches this dispatcher (tool-check-loop-run.ts returns first), so no dryRun flag is threaded.
        const result = await scheduleTests({ root: input.checkCwd, paths: [input.absPath], timeoutMs: input.timeoutMs,
            maxTests: input.maxDependentTests ?? 150, waitForCapacity: false, stage: "edit" });
        if (result.status === "passed") return [];
        if (result.status === "failed") return [{ name: input.checkName, severity: input.severity,
            file: input.filePath, message: `Tests failed for ${input.filePath}`, detail: result.output }];
        return [unavailable(input, result.reason)];
    } catch (error) {
        return [unavailable(input, error instanceof Error ? error.message : "Test planning unavailable")];
    }
}

async function runProjectDispatcher(input: TestDispatcherInput): Promise<TestDispatcherResult[]> {
    try {
        const result = await runLanguageTestSuite({ root: input.checkCwd, language: input.profile.id, timeoutMs: input.timeoutMs });
        if (result.status === "passed") return [];
        if (result.status === "unavailable") return [unavailable(input, [result.reason, result.output].filter(Boolean).join("\n"))];
        // A current failure is evidence, but cannot be called introduced without a before result.
        return [{ name: input.checkName, severity: "warning", file: input.filePath, message: result.reason, detail: result.output }];
    } catch (error) { return [unavailable(input, String(error))]; }
}

function relativizeFromRoot(absPath: string, root: string): string {
    const prefix = join(root, sep);
    return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

// Retained path helper seam for downstream callers; project suites no longer guess companions.
export const __test_only__ = { runVitestDispatcher, runPytestDispatcher: runProjectDispatcher,
    runCargoTestDispatcher: runProjectDispatcher, runGoTestDispatcher: runProjectDispatcher, relativizeFromRoot };
