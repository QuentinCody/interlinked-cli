import { realpathSync } from "node:fs";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { testReadiness } from "../harness/test-readiness.js";

export async function testsReadinessCommand(language: string, options: { cwd?: string; json?: boolean }): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const result = await testReadiness(realpathSync(options.cwd ?? process.cwd()), language);
        output(mode, result, { normal: () => `${result.status}: ${result.interpreter}\n${result.reason}\nMissing: ${result.missing.join(", ") || "none"}\n${result.install ? `Approved install argv: ${JSON.stringify(result.install)}` : "No install proposed."}` });
        if (result.status !== "ready") process.exitCode = 1;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Test readiness unavailable"); }
}
