import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { acquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { inspectCase, inspectContracts } from "./evidence.js";
import { contractDigest, contractPath, readContractFile } from "./paths.js";
import { parseContractManifest } from "./schema.js";
import type { ContractCase, ContractEvidence, ContractExpectation, ContractReport } from "./types.js";

interface Observations { stdout: string; stderr?: string; exitCode?: number; status?: number; headers?: Record<string, string>; }
function compareJson(expected: unknown, actual: string): string[] {
    try { return isDeepStrictEqual(JSON.parse(actual), expected) ? [] : ["JSON differs (key order ignored; array order and strings preserved)"]; }
    catch { return ["Observed output is not a JSON value"]; }
}
function compareFiles(files: Record<string, string>, workspace: string): string[] {
    const differences: string[] = [];
    for (const [path, content] of Object.entries(files)) {
        try { if (readContractFile(workspace, path) !== content) differences.push(`File ${path} differs`); }
        catch (error) { differences.push(`File ${path} cannot be compared: ${String(error)}`); }
    }
    return differences;
}
function compareObservations(expected: ContractExpectation, observed: Observations, workspace: string): string[] {
    const differences = compareFiles(expected.files ?? {}, workspace);
    for (const key of ["stdout", "stderr", "exitCode", "status"] as const) {
        if (expected[key] !== undefined && expected[key] !== observed[key]) differences.push(`${key} differs from the declared expectation`);
    }
    if (Object.hasOwn(expected, "json")) differences.push(...compareJson(expected.json, observed.stdout));
    for (const [name, value] of Object.entries(expected.headers ?? {})) if (observed.headers?.[name.toLowerCase()] !== value) differences.push(`HTTP header ${name} differs`);
    return differences;
}
async function observeHttp(runner: Extract<ContractCase["runner"], { kind: "http" }>, remaining: number): Promise<Observations> {
    const response = await fetch(runner.url, { method: runner.method, ...(runner.body !== undefined ? { body: runner.body } : {}), redirect: "manual", signal: AbortSignal.timeout(remaining) });
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader) {
        try {
            for (;;) {
                const chunk = await reader.read(); if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 1024 * 1024) throw new Error("HTTP observation exceeds 1 MiB budget");
                chunks.push(chunk.value);
            }
        } finally { await reader.cancel(); }
    }
    return { status: response.status, stdout: Buffer.concat(chunks).toString("utf8"), headers: Object.fromEntries(response.headers) };
}
function inputContents(root: string, row: ContractCase): Array<[string, string]> {
    let bytes = 0;
    return row.inputs.map(path => {
        const content = readContractFile(root, path);
        bytes += Buffer.byteLength(content);
        if (bytes > 8 * 1024 * 1024) throw new Error("Contract inputs exceed 8 MiB budget");
        return [path, content];
    });
}
async function observe(row: ContractCase, workspace: string, remaining: number): Promise<Observations> {
    if (row.runner.kind === "http") return observeHttp(row.runner, remaining);
    const run = await runProcessAsync(row.runner.argv[0]!, row.runner.argv.slice(1), { cwd: workspace, timeout: remaining, exactEnv: { PATH: process.env.PATH, HOME: workspace, TMPDIR: workspace, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8" } });
    if (run.code === null || run.timedOut || run.killed || run.stdoutTruncated || run.stderrTruncated) throw new Error("Runner missing, interrupted, timed out, or output truncated; no verdict");
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.code };
}
async function executeCase(root: string, row: ContractCase, evidence: ContractEvidence, deadline: number): Promise<void> {
    const workspace = mkdtempSync(join(tmpdir(), "interlinked-contract-")), started = Date.now();
    try {
        const inputs = inputContents(root, row);
        evidence.inputHash = contractDigest(inputs);
        for (const [path, content] of inputs) {
            const target = contractPath(workspace, path);
            mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { flag: "wx" });
            chmodSync(target, statSync(contractPath(root, path)).mode & 0o777);
        }
        const remaining = deadline - Date.now();
        if (remaining < 1) throw new Error("Execution budget exhausted");
        const observed = await observe(row, workspace, remaining);
        evidence.observations = { stdoutSha256: contractDigest(observed.stdout), stderrSha256: contractDigest(observed.stderr ?? ""), stdoutPreview: observed.stdout.slice(0, 1024), ...(observed.exitCode !== undefined ? { exitCode: observed.exitCode } : {}), ...(observed.status !== undefined ? { status: observed.status } : {}) };
        const differences = compareObservations(row.expect, observed, workspace);
        evidence.state = differences.length ? "failed" : "passed";
        evidence.details.push(...differences);
        if (contractDigest(inputContents(root, row)) !== evidence.inputHash) { evidence.state = "stale"; evidence.details.push("Project inputs changed during execution"); }
    } catch (error) { evidence.state = "unavailable"; evidence.details.push(String(error)); }
    finally { evidence.durationMs = Date.now() - started; rmSync(workspace, { recursive: true, force: true }); }
}
async function executeCases(root: string, context: ReturnType<typeof inspectContracts>, deadline: number): Promise<void> {
    for (const [index, row] of context.manifest.cases.entries()) {
        const evidence = context.report.cases[index]!;
        if (evidence.provenance === "conflict") { evidence.details.push("Not executed: reconcile the source/expectation conflict"); continue; }
        if (Date.now() >= deadline) { evidence.state = "unavailable"; evidence.details.push("Execution budget exhausted; earlier results retained"); continue; }
        if (["stale", "unavailable"].includes(evidence.provenance)) { evidence.state = evidence.provenance === "stale" ? "stale" : "unavailable"; continue; }
        await executeCase(root, row, evidence, deadline);
        if (inspectCase(root, row, context.policy).provenance !== evidence.provenance) { evidence.state = "stale"; evidence.details.push("Requirement changed during execution"); }
    }
}
function retainPrevious(root: string, path: string, context: ReturnType<typeof inspectContracts>): void {
    for (const row of parseContractManifest(readContractFile(root, path)).cases) {
        if (context.manifest.cases.some(current => contractDigest(current) === contractDigest(row))) continue;
        context.manifest.cases.push(row); context.report.cases.push(inspectCase(root, row, context.policy));
    }
}
/** Explicit execution only. Disposable fixtures are not an OS sandbox or a sealed runtime. */
export async function runContracts(root: string, options: { path?: string; previous?: string; timeoutMs: number }): Promise<ContractReport> {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000) throw new Error("Contract timeout must be 1–600000 ms");
    const started = Date.now(), deadline = started + options.timeoutMs;
    const context = inspectContracts(root, options.path), { report } = context;
    const initialManifest = contractDigest(context.manifest);
    if (options.previous) retainPrevious(root, options.previous, context);
    const release = await acquireProjectHeavyProcessLease(root, deadline, AbortSignal.timeout(options.timeoutMs));
    try {
        if (release) await executeCases(root, context, deadline);
        else for (const evidence of report.cases) { evidence.state = "unavailable"; evidence.details.push("Admission budget exhausted"); }
        const current = inspectContracts(root, options.path);
        if (contractDigest(current.manifest) !== initialManifest || contractDigest(current.policy) !== contractDigest(context.policy)) {
            for (const evidence of report.cases) evidence.state = "stale";
            report.gaps.push("Contract definitions or acceptance changed during execution");
        }
    } finally { release?.(); }
    report.elapsedMs = Date.now() - started;
    return report;
}
