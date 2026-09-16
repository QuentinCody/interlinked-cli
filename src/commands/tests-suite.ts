import { realpathSync } from "node:fs";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { runLanguageTestSuite } from "../harness/quality-checks/language-test-suite.js";
import { scheduleTests } from "../harness/test-scheduler.js";

interface SuiteOptions { cwd?: string; timeout?: string; json?: boolean; }

/** Explicit whole-project execution; no language is silently routed into Vitest. */
export async function testsSuiteCommand(language: string, options: SuiteOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd()), timeoutMs = Number(options.timeout ?? "60000");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("Timeout must be an integer from 1 to 3600000 ms");
        const result = await runSuite(language, root, timeoutMs);
        output(mode, result, { normal: () => `${result.status}: ${result.durationMs} ms\n${result.reason}\n${result.output}` });
        if (result.status !== "passed") process.exitCode = 1;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Project suite unavailable"); }
}

function runSuite(language: string, root: string, timeoutMs: number) {
    if (language === "typescript" || language === "javascript") return scheduleTests({ root, paths: [], full: true, timeoutMs, maxWorkers: 2, waitForCapacity: true });
    if (language === "python" || language === "rust" || language === "go") return runLanguageTestSuite({ root, language, timeoutMs, recovery: true });
    throw new Error(`Unsupported test suite language: ${language}. Supported: typescript, javascript, python, rust, go.`);
}
