import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBehavioralEvidence } from "../src/lib/metrics/evidence-run.js";
import { collectCompositeScoreReport } from "../src/lib/metrics/composite-report.js";
import { hashBytes } from "../src/lib/metrics/inventory.js";

const [directory, outputDirectory, kind = "coverage", target = "src/**/*.ts"] = process.argv.slice(2);
if (!directory || !outputDirectory || !["coverage", "mutation"].includes(kind)) throw new Error("Usage: tsx scripts/metrics-corpus-behavior.mts <root> <output> [coverage|mutation] [mutate glob]");
const root = resolve(directory), output = resolve(outputDirectory);
const runner = resolve(import.meta.dirname, "metrics-corpus-behavior-runner.mts");
const runnerHash = hashBytes(readFileSync(runner));
const result = await runBehavioralEvidence({ root, kind: kind === "mutation" ? "mutation" : "coverage",
    artifact: kind === "coverage" ? ".interlinked/pilot/coverage/coverage-final.json" : ".interlinked/pilot/mutation.json",
    timeoutMs: 600_000, resume: true,
    runner: { argv: [process.execPath, "--import", resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs"), runner, kind, target],
        version: `vitest-4.1.8/stryker-9.6.1/pilot-${runnerHash}`,
        operatorPolicy: kind === "coverage" ? "v8/src-all/existing-tests/explicit-es2022-transform-v1" : `stryker-all-operators/per-test/${target}/v1`,
        environmentHash: hashBytes(JSON.stringify([process.version, process.platform, process.arch, process.env.NODE_OPTIONS ?? ""])),
    } });
mkdirSync(output, { recursive: true });
writeFileSync(join(output, `${kind}-run.json`), JSON.stringify(result, null, 2));
writeFileSync(join(output, `${kind}-score.json`), JSON.stringify(collectCompositeScoreReport(root), null, 2));
console.log(JSON.stringify({ outcome: result.outcome, state: result.evidence?.observations.state, durationMs: result.durationMs, issues: result.issues, modelCalls: 0 }));
if (result.outcome !== "passed" || result.evidence?.observations.state !== "measured") process.exitCode = 1;
