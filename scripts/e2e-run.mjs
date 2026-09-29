import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { assertE2eBuild, fingerprintTestInputs, hashBytes } from "./e2e-evidence.mjs";
import { mergeChildCoverage, mergeStageRow } from "./e2e-coverage-merge.mjs";
import { recordStage } from "./e2e-stage-ledger.mjs";

/** Times one stage of this lane into the verification-stages ledger; a thrown failure is recorded before it propagates. */
async function timed(root, check, field, work) {
    const started = Date.now();
    try {
        const value = await work();
        recordStage(root, { check, status: "passed", [field]: Date.now() - started });
        return value;
    } catch (error) {
        recordStage(root, { check, status: "failed", [field]: Date.now() - started });
        throw error;
    }
}

async function runChild(root, args, env, receipt) {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("E2e subprocess exceeded ten minutes")); }, 600_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (receipt) appendFileSync(receipt, `${JSON.stringify({ pid: child.pid, clean: code !== null })}\n`);
    assert.equal(code, 0, `E2e subprocess failed: ${args.join(" ")}`);
}

async function inventoryFor(root) {
    const result = await build({ absWorkingDir: root, entryPoints: ["src/harness/e2e-inventory.ts"], bundle: true,
        write: false, platform: "node", format: "esm", packages: "external",
        define: { "import.meta.url": JSON.stringify(pathToFileURL(join(root, "src/harness/e2e-inventory.ts")).href) } });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    return module.boundaryInventory(root, JSON.parse(readFileSync(join(root, "dist/metafile-esm.json"), "utf8")));
}

async function unchanged(root, buildFingerprint, testFingerprint) {
    assert.equal(assertE2eBuild(root), buildFingerprint, "Build inputs changed during the run");
    assert.equal(await fingerprintTestInputs(root), testFingerprint, "Test inputs changed during the run");
}

function publish(root, directory, merged, evidence) {
    for (const target of [directory, join(root, "coverage-e2e")]) {
        writeFileSync(join(target, "coverage-summary.json"), `${JSON.stringify(merged.summary, null, 2)}\n`);
        writeFileSync(join(target, "inventory.json"), JSON.stringify(merged.inventory));
        writeFileSync(join(target, "coverage-final.json"), JSON.stringify(merged.coverage));
        writeFileSync(join(target, "run.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    }
}

async function main() {
    const root = realpathSync(process.cwd());
    mkdirSync(join(root, "coverage-e2e"), { recursive: true });
    // Invalidate the previous success before any prerequisite can fail.
    writeFileSync(join(root, "coverage-e2e/run.json"), JSON.stringify({ schema: 1, lane: "e2e", passed: false }));
    const buildFingerprint = assertE2eBuild(root);
    const testFingerprint = await fingerprintTestInputs(root);
    const inventory = await inventoryFor(root);
    const runId = randomUUID();
    const directory = resolve(root, "coverage-e2e/runs", runId);
    const v8Directory = join(directory, "v8");
    mkdirSync(v8Directory, { recursive: true });
    const childLedger = join(directory, "children.jsonl");
    // Load the CLI bundle as well as hook/server bundles, so installer code
    // has an executable zero-hit model even when a test doesn't call it.
    await runChild(root, ["dist/index.js", "--help"], { ...process.env, NODE_V8_COVERAGE: v8Directory }, childLedger);
    // These inventoried writers have no production importers yet. Load their
    // e2e-only bundles to measure their uncalled functions as zero, preserving
    // their obligation instead of silently dropping them from the denominator.
    await runChild(root, ["--input-type=module", "--eval", "await import('./dist/harness/agent-io/store.js'); await import('./dist/harness/break-glass.js');"],
        { ...process.env, NODE_V8_COVERAGE: v8Directory }, childLedger);
    const testEnv = { ...process.env, INTERLINKED_VIZ: "1", INTERLINKED_E2E_V8_DIR: v8Directory };
    delete testEnv.NODE_V8_COVERAGE;
    // Two ledger rows split the lane the way the CI timing cannot: the e2e tests (exec_ms) and the coverage merge (post_ms).
    await timed(root, "e2e-tests", "exec_ms", () => runChild(root, ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.e2e.config.ts"], testEnv));
    await unchanged(root, buildFingerprint, testFingerprint);
    const children = readFileSync(childLedger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    // ONE merge row: post_ms is the whole merge, and the per-phase profile (Unit 6: measure before optimizing) rides in
    // its detail — never as further rows, which a `--sum post_ms` would add to the total a second time.
    const mergeStarted = Date.now();
    let merged;
    try {
        merged = await mergeChildCoverage({ root, v8Directory, inventory, children });
    } catch (error) {
        recordStage(root, mergeStageRow("failed", Date.now() - mergeStarted, {}));
        throw error;
    }
    recordStage(root, mergeStageRow("passed", Date.now() - mergeStarted, merged.timings));
    await unchanged(root, buildFingerprint, testFingerprint);
    const report = `${JSON.stringify(merged.summary, null, 2)}\n`;
    const evidence = { schema: 1, lane: "e2e", passed: true, run_id: runId, build: buildFingerprint,
        tests: testFingerprint, inventory: hashBytes(JSON.stringify(merged.inventory)), report: hashBytes(report), children };
    // The passing run record is published last. Partial runs never receive one.
    publish(root, directory, merged, evidence);
    process.stdout.write(`Measured ${merged.inventory.length} boundary files from ${children.length} child processes.\n`);
}

await main();
