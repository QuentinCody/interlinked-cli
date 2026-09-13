#!/usr/bin/env node
// Reproducible worker comparison. Reports sampled process-tree RSS, not just the coordinator.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const full = args.has("--full"), coverage = args.has("--coverage");
const iterations = Number(process.argv.find(arg => arg.startsWith("--iterations="))?.split("=")[1] ?? 1);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10) throw new Error("--iterations must be 1 through 10");
const directory = join(root, ".interlinked/test-benchmarks", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(directory, { recursive: true });
const samples = {
    unit: ["src/harness/test-plan.test.ts", "src/harness/test-dependency-graph.test.ts", "src/harness/resource-governor.test.ts",
        "src/harness/coverage-index/invalidation.test.ts", "src/harness/coverage-index/aggregate.test.ts"],
    subprocess: ["src/harness/test-execution.integration.test.ts", "src/harness/coverage-index/controller.integration.test.ts",
        "src/harness/background-job.integration.test.ts"],
};

function treeRss(pid) {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 2000 })
        .trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const owners = new Set([pid]);
    for (let previous = -1; previous !== owners.size;) {
        previous = owners.size;
        for (const [child, parent] of rows) if (owners.has(parent)) owners.add(child);
    }
    return rows.reduce((sum, [child, , rss]) => sum + (owners.has(child) ? rss * 1024 : 0), 0);
}

async function benchmark(workload, files, workers, iteration) {
    const reportPath = join(directory, `${workload}-${workers}-${iteration}.json`);
    const runnerArgs = [join(root, "node_modules/vitest/vitest.mjs"), "run", ...files,
        `--maxWorkers=${workers}`, "--retry=0", "--no-cache", "--reporter=json", `--outputFile=${reportPath}`];
    if (coverage) runnerArgs.push("--coverage", `--coverage.reportsDirectory=${reportPath}.coverage`);
    const started = performance.now(), child = spawn(process.execPath, runnerArgs, { cwd: root,
        env: { ...process.env, CI: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    let peakRssBytes = 0, memorySamples = 0, memoryErrors = 0, stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setInterval(() => {
        try { peakRssBytes = Math.max(peakRssBytes, treeRss(child.pid)); memorySamples++; }
        catch { memoryErrors++; }
    }, 100);
    const exitCode = await new Promise((resolveExit, reject) => {
        child.once("error", reject); child.once("close", resolveExit);
    }).finally(() => clearInterval(timer));
    let report = null, reportIssue = null;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
    catch (error) { reportIssue = String(error); }
    return { workload, workers, iteration, elapsedMs: Math.round(performance.now() - started), peakRssBytes,
        memorySamples, memoryErrors, reportIssue, exitCode, retry: 0, coverage,
        tests: report?.numTotalTests ?? null, failed: report?.numFailedTests ?? null,
        passed: exitCode === 0 && report?.success === true && report?.numPassedTests > 0, stderr, reportPath };
}

const results = [];
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const diffHash = createHash("sha256").update(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })).digest("hex");
for (let iteration = 1; iteration <= iterations; iteration++) {
    for (const [workload, files] of Object.entries(full ? { full: [] } : samples)) {
        for (const workers of [1, 2, 4]) {
            const result = await benchmark(workload, files, workers, iteration);
            results.push(result);
            console.log(JSON.stringify(result));
        }
    }
}
const summary = { revision, trackedDiffHash: diffHash, node: process.version, platform: process.platform, cores: cpus().length, totalMemoryBytes: totalmem(),
    full, coverage, results };
writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Report: ${join(directory, "summary.json")}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
