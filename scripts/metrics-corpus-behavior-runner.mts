// Explicit runner for the pinned, dependency-free library pilots. Execute only
// inside runBehavioralEvidence's disposable copy; never against the checkout.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Stryker } from "@stryker-mutator/core";

const [kind, target = "src/**/*.ts"] = process.argv.slice(2);
const dependencies = resolve(import.meta.dirname, "../node_modules");
if (!process.cwd().includes("interlinked-metrics-run-")) throw new Error("Disposable evidence workspace required");
symlinkSync(dependencies, join(process.cwd(), "node_modules"), "dir");
const output = join(process.cwd(), ".interlinked/pilot");
mkdirSync(output, { recursive: true });
const config = join(output, "vitest.config.mjs");
writeFileSync(config, `export default ${JSON.stringify({
    esbuild: { tsconfigRaw: { compilerOptions: { target: "ES2022", module: "ESNext" } } },
    test: { include: ["test/**/*.test.ts"], maxWorkers: 1,
        coverage: { provider: "v8", include: ["src/**/*.ts"], reporter: ["json"], reportsDirectory: ".interlinked/pilot/coverage" } },
})};`);
if (kind === "coverage") {
    const result = spawnSync(process.execPath, [join(dependencies, "vitest/vitest.mjs"), "run", "--config", config, "--coverage"], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
} else if (kind === "mutation") {
    const stryker = new Stryker({
        testRunner: "vitest", plugins: [join(dependencies, "@stryker-mutator/vitest-runner/dist/src/index.js")],
        vitest: { configFile: config }, mutate: [target],
        mutator: { excludedMutations: [] }, reporters: ["json", "clear-text"],
        jsonReporter: { fileName: ".interlinked/pilot/mutation.json" },
        concurrency: 2, timeoutMS: 5000, timeoutFactor: 2, coverageAnalysis: "perTest",
        tempDirName: ".interlinked/pilot/stryker", ignorePatterns: ["/.interlinked"],
        thresholds: { high: 80, low: 60, break: 0 }, cleanTempDir: "always",
    });
    await stryker.runMutationTest();
} else throw new Error("Expected coverage or mutation");
