import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { pythonTestReadiness, type PythonTestReadiness } from "./python-test-readiness.js";

/** Readiness is deliberately weaker than a test verdict. No install or collection. */
export async function testReadiness(root: string, language: string): Promise<PythonTestReadiness> {
    if (language === "python") return pythonTestReadiness(root);
    const result: PythonTestReadiness = { status: "unavailable", interpreter: language, missing: [],
        reason: "Runner readiness does not establish test collection, assertions, coverage, or new-requirement coverage.",
        behavioralEvidence: "not-run", requiresApproval: [], install: null };
    if (language === "typescript" || language === "javascript") {
        try { result.interpreter = createRequire(join(root, "package.json")).resolve("vitest/node"); result.status = "ready"; }
        catch { result.missing.push("project-resolvable vitest"); }
        return result;
    }
    const runner = { rust: ["cargo", "Cargo.toml"], go: ["go", "go.mod"] }[language];
    if (!runner) throw new Error(`Unsupported readiness language: ${language}. Supported: typescript, javascript, python, rust, go.`);
    result.interpreter = runner[0]!;
    if (!existsSync(join(root, runner[1]!))) result.missing.push(runner[1]!);
    const probe = await runProcessAsync(runner[0]!, ["version"], { cwd: root, timeout: 3000 });
    if (probe.code !== 0 || probe.timedOut) result.missing.push(runner[0]!);
    result.status = result.missing.length ? "unavailable" : "ready";
    return result;
}

/** Concrete early guidance; runner presence never implies collected or passing tests. */
export function testReadinessGuidance(result: PythonTestReadiness, language: string): string {
    const setup = result.install
        ? `Approved install argv in the selected environment: ${JSON.stringify([result.install.command, ...result.install.args])}. `
        : `Inspect prerequisites with interlinked tests readiness ${language} --json. `;
    const prerequisites = result.status === "ready" ? "Runner prerequisites are available; no behavioral checks have run. "
        : `Test evidence is unavailable in ${result.interpreter}: ${result.missing.join(", ") || result.reason}. ${setup}`;
    return `[interlinked:test-readiness] ${prerequisites}No test layout was detected. Inspect custom layouts; otherwise retain executable assertions for the public contract, boundary/error cases and established behavior before extending it. Run interlinked tests suite ${language} --json after adding tests. An ad hoc example or a test filename alone is not regression protection.`;
}
