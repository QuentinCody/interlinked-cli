import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { acquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { inspectCase, inspectContracts } from "./evidence.js";
import { contractDigest, contractPath, readContractBytes, readContractFile } from "./paths.js";
import { parseContractManifest } from "./schema.js";
import type { ContractCase, ContractEvidence, ContractExpectation, ContractReport, HttpRunner } from "./types.js";

interface Observations { stdout: string; stderr?: string; exitCode?: number; status?: number; headers?: Record<string, string>; /** The case's own process id (process runner): the identity runtime observations reconcile against. */ pid?: number; }
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
/** Every DECLARED observable lands in exactly one of `matched` / `mismatched` — structured, so a later reader can tell an outcome mismatch from an abnormal exit. */
interface Comparison { differences: string[]; matched: string[]; mismatched: string[]; }
function compareObservations(expected: ContractExpectation, observed: Observations, workspace: string): Comparison {
    const differences: string[] = [], matched: string[] = [], mismatched: string[] = [];
    const record = (key: string, problems: string[]): void => { differences.push(...problems); (problems.length ? mismatched : matched).push(key); };
    if (expected.files && Object.keys(expected.files).length) record("files", compareFiles(expected.files, workspace));
    for (const key of ["stdout", "stderr", "exitCode", "status"] as const) {
        if (expected[key] !== undefined) record(key, expected[key] === observed[key] ? [] : [`${key} differs from the declared expectation`]);
    }
    if (Object.hasOwn(expected, "json")) record("json", compareJson(expected.json, observed.stdout));
    const headers = Object.entries(expected.headers ?? {});
    if (headers.length) record("headers", headers.filter(([name, value]) => observed.headers?.[name.toLowerCase()] !== value).map(([name]) => `HTTP header ${name} differs`));
    return { differences, matched, mismatched };
}
/** How the supervisor exposes its OWNED services to service-bound cases (Unit D1). Absent ⇒ such a case is unavailable, never a guess. */
export interface ServiceBinding { baseUrl(serviceId: string): string | null; restart(serviceId: string): Promise<boolean>; }
interface HttpTarget { url: string; method: "GET" | "POST"; body?: string; }
function httpTarget(runner: HttpRunner, binding: ServiceBinding | undefined): HttpTarget {
    if ("url" in runner) return runner;
    const base = binding?.baseUrl(runner.service);
    if (!base) throw new Error(`service-bound contract needs the managed e2e supervisor: no owned, ready service "${runner.service}"; no verdict`);
    return { url: `${base}${runner.path}`, method: runner.method, ...(runner.body !== undefined ? { body: runner.body } : {}) };
}
async function runSteps(row: ContractCase, binding: ServiceBinding | undefined): Promise<void> {
    for (const step of row.steps ?? []) {
        if (!binding || !(await binding.restart(step.service))) throw new Error(`workflow step: restart of owned service "${step.service}" failed or no supervisor owns it; no verdict`);
    }
}
async function observeHttp(runner: HttpTarget, signal: AbortSignal): Promise<Observations> {
    const response = await fetch(runner.url, { method: runner.method, ...(runner.body !== undefined ? { body: runner.body } : {}), redirect: "manual", signal });
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
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
interface ContractInput { path: string; bytes: Buffer; mode: number; }
/** Binary-safe: a compiled executable is copied byte-for-byte with its mode. */
function inputContents(root: string, row: ContractCase): ContractInput[] {
    let total = 0;
    return row.inputs.map(path => {
        const { bytes, mode } = readContractBytes(root, path, MAX_INPUT_BYTES);
        total += bytes.byteLength;
        if (total > MAX_INPUT_BYTES) throw new Error("Contract inputs exceed 8 MiB budget");
        return { path, bytes, mode };
    });
}
function inputsDigest(inputs: ContractInput[]): string {
    return contractDigest(inputs.map(input => [input.path, contractDigest(input.bytes), input.mode]));
}
/** The caller's cancellation, when any, combined with the remaining budget. */
function budgetSignal(remaining: number, signal: AbortSignal | undefined): AbortSignal {
    return signal ? AbortSignal.any([AbortSignal.timeout(remaining), signal]) : AbortSignal.timeout(remaining);
}
async function observe(row: ContractCase, workspace: string, remaining: number, scope: ExecutionScope): Promise<Observations> {
    const { signal } = scope;
    if (row.runner.kind === "http") { await runSteps(row, scope.services); return observeHttp(httpTarget(row.runner, scope.services), budgetSignal(remaining, signal)); }
    const run = await runProcessAsync(row.runner.argv[0]!, row.runner.argv.slice(1), { cwd: workspace, timeout: remaining, exactEnv: { PATH: process.env.PATH, HOME: workspace, TMPDIR: workspace, PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", LANG: "C.UTF-8", ...scope.env }, ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw new Error("Runner cancelled by the caller; no verdict");
    if (run.code === null || run.timedOut || run.killed || run.stdoutTruncated || run.stderrTruncated) throw new Error("Runner missing, interrupted, timed out, or output truncated; no verdict");
    return { stdout: run.stdout, stderr: run.stderr, exitCode: run.code, ...(run.pid !== undefined ? { pid: run.pid } : {}) };
}
async function executeCase(root: string, row: ContractCase, evidence: ContractEvidence, deadline: number, scope: ExecutionScope): Promise<void> {
    const workspace = mkdtempSync(join(tmpdir(), "interlinked-contract-")), started = Date.now();
    try {
        const inputs = inputContents(root, row);
        evidence.inputHash = inputsDigest(inputs);
        for (const input of inputs) {
            const target = contractPath(workspace, input.path);
            mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, input.bytes, { flag: "wx" });
            chmodSync(target, input.mode);
        }
        const remaining = deadline - Date.now();
        if (remaining < 1) throw new Error("Execution budget exhausted");
        const observed = await observe(row, workspace, remaining, scope);
        evidence.observations = { stdoutSha256: contractDigest(observed.stdout), stderrSha256: contractDigest(observed.stderr ?? ""), stdoutPreview: observed.stdout.slice(0, 1024), ...(observed.exitCode !== undefined ? { exitCode: observed.exitCode } : {}), ...(observed.status !== undefined ? { status: observed.status } : {}), ...(observed.pid !== undefined ? { pid: observed.pid } : {}) };
        const { differences, matched, mismatched } = compareObservations(row.expect, observed, workspace);
        evidence.observations.matched = matched;
        evidence.observations.mismatched = mismatched;
        evidence.state = differences.length ? "failed" : "passed";
        evidence.details.push(...differences);
        if (inputsDigest(inputContents(root, row)) !== evidence.inputHash) { evidence.state = "stale"; evidence.details.push("Project inputs changed during execution"); }
    } catch (error) { evidence.state = "unavailable"; evidence.details.push(String(error)); }
    finally { evidence.durationMs = Date.now() - started; rmSync(workspace, { recursive: true, force: true }); }
}
type ExecutionScope = Pick<RunContractsOptions, "only" | "signal" | "services" | "env">;
/** True when the case must NOT execute now; the evidence records why (selection, conflict, cancellation, budget, provenance). */
function deferred(row: ContractCase, evidence: ContractEvidence, deadline: number, scope: ExecutionScope): boolean {
    if (scope.only && !scope.only.has(row.id)) { evidence.details.push("Not selected for this run"); return true; }
    if (evidence.provenance === "conflict") { evidence.details.push("Not executed: reconcile the source/expectation conflict"); return true; }
    if (scope.signal?.aborted) { evidence.state = "unavailable"; evidence.details.push("Execution cancelled by the caller; no verdict"); return true; }
    if (Date.now() >= deadline) { evidence.state = "unavailable"; evidence.details.push("Execution budget exhausted; earlier results retained"); return true; }
    if (["stale", "unavailable"].includes(evidence.provenance)) { evidence.state = evidence.provenance === "stale" ? "stale" : "unavailable"; return true; }
    return false;
}
async function executeCases(root: string, context: ReturnType<typeof inspectContracts>, deadline: number, scope: ExecutionScope): Promise<void> {
    for (const [index, row] of context.manifest.cases.entries()) {
        const evidence = context.report.cases[index]!;
        if (deferred(row, evidence, deadline, scope)) continue;
        await executeCase(root, row, evidence, deadline, scope);
        if (inspectCase(root, row, context.policy).provenance !== evidence.provenance) { evidence.state = "stale"; evidence.details.push("Requirement changed during execution"); }
    }
}
function retainPrevious(root: string, path: string, context: ReturnType<typeof inspectContracts>): void {
    for (const row of parseContractManifest(readContractFile(root, path)).cases) {
        if (context.manifest.cases.some(current => contractDigest(current) === contractDigest(row))) continue;
        context.manifest.cases.push(row); context.report.cases.push(inspectCase(root, row, context.policy));
    }
}
export interface RunContractsOptions { path?: string; previous?: string; timeoutMs: number; /** Case ids to execute; others stay not-run. */ only?: ReadonlySet<string>; /** Caller cancellation: a case observed after abort is unavailable, never a verdict. */ signal?: AbortSignal; /** Owned services for service-bound HTTP cases (Unit D1); absent ⇒ those cases are unavailable. */ services?: ServiceBinding; /** Extra env every process case inherits (the supervisor's recorded seed/clock, Unit E1); never a substitute for the fixed base env. */ env?: NodeJS.ProcessEnv; }
function validateTimeout(timeoutMs: number): void {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("Contract timeout must be 1–600000 ms");
}
/** Executes under a lease the CALLER already holds (a supervisor that ran build steps under the same lease). */
export async function runContractsUnderLease(root: string, options: RunContractsOptions, deadline: number): Promise<ContractReport> {
    const started = Date.now();
    const context = inspectContracts(root, options.path), { report } = context;
    const initialManifest = contractDigest(context.manifest);
    if (options.previous) retainPrevious(root, options.previous, context);
    await executeCases(root, context, deadline, options);
    const current = inspectContracts(root, options.path);
    if (contractDigest(current.manifest) !== initialManifest || contractDigest(current.policy) !== contractDigest(context.policy)) {
        for (const evidence of report.cases) evidence.state = "stale";
        report.gaps.push("Contract definitions or acceptance changed during execution");
    }
    report.elapsedMs = Date.now() - started;
    return report;
}
/** Explicit execution only. Disposable fixtures are not an OS sandbox or a sealed runtime. */
export async function runContracts(root: string, options: RunContractsOptions): Promise<ContractReport> {
    validateTimeout(options.timeoutMs);
    const started = Date.now(), deadline = started + options.timeoutMs;
    const release = await acquireProjectHeavyProcessLease(root, deadline, AbortSignal.timeout(options.timeoutMs));
    if (!release) {
        const { report } = inspectContracts(root, options.path);
        for (const evidence of report.cases) { evidence.state = "unavailable"; evidence.details.push("Admission budget exhausted"); }
        report.elapsedMs = Date.now() - started;
        return report;
    }
    try { return await runContractsUnderLease(root, options, deadline); }
    finally { release(); }
}
