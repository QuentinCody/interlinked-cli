// ===========================================
// Supervised run — snapshot, prepare, drive the public boundary, publish
// ===========================================
// Plan 31 §9.1 sequence, scoped to managed process contracts: reconcile and
// take the input snapshot, hold the project's heavy-process lease, copy the
// project into a DISPOSABLE snapshot (R7: preparation never touches the
// live tree and never inherits the developer's HOME), run declared argv
// preparation steps there, bind build artifacts from the snapshot, execute
// the scenario's contract cases through the portable driver, recheck the
// live inputs, publish the receipt once, then append one attempt row per
// scenario.

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { resolveOwnVersionFrom } from "../../lib/hook-version.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { CONTRACT_MANIFEST, CONTRACT_POLICY } from "../contracts/paths.js";
import { runContractsUnderLease, type ServiceBinding } from "../contracts/runner.js";
import type { ContractEvidence } from "../contracts/types.js";
import { acquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { recoverOrphanedRuns, writeAttemptRecord } from "./attempts.js";
import { evaluateE2e, selectScenarios, type E2eEvaluation, type Selected } from "./evaluate.js";
import { collectProjectInputs, scenarioGeneration, type ScenarioGeneration } from "./generation.js";
import { appendE2eTxn, scenarioKey, type AttemptStatus } from "./ledger.js";
import { digestOf, loadE2ePolicy, type E2eDesignated, type E2ePolicy, type E2eProject, type E2eProof, type E2eScenario, type E2eSuite, type ProofMode, type ReportFormat } from "./policy.js";
import { E2E_RUNS_DIRECTORY, emptyReceipt, writeE2eReceipt, type E2eReceipt, type PrepareResult, type ReceiptCase } from "./receipt.js";
import { reconcileChanges } from "./reconcile.js";
import { matchingRequests, serveRequests } from "./requests.js";
import { effectiveScheduling } from "./scheduler.js";
import { applyFault, classifySensitivity, exportRevision, proofCaseIds, type BuildResult, type SensitivityRecord, type SideOutcome } from "./sensitivity.js";
import { collectNodeCoverage, COVERAGE_DIRECTORY, writeRuntimeObservations } from "./runtime-observations.js";
import { allocatePort, createOwnedService, restartService, serviceBaseUrl, startService, stopService, type OwnedService, type ServiceRecord, type ServiceStage } from "./services.js";
import { runBrowserStage, structuredCase } from "./browser-stage.js";
import { parseStructuredReport, type StructuredReport } from "./structured-report.js";

/** One attempt of a stability cohort (§9.5, Unit E1): recorded in the receipt and exported to every owned process as `INTERLINKED_E2E_*`. */
export interface StabilityAttempt { cohortId: string; attempt: number; seed: string; /** ISO instant to freeze, or "real". */ clock: string; }
export interface RunE2eOptions {
    root: string; /** Where git refs resolve when `root` is an exported candidate tree without `.git` (CI, F-R3). */ gitRoot?: string; projectId?: string; scenarioIds?: string[]; timeoutMs: number; sessionId?: string; requestIds?: string[]; stability?: StabilityAttempt;
    /** Cancellation (C6): an aborted step is an explicit unavailable attempt, never a pass. */ signal?: AbortSignal;
    /** An automatic (scheduler-spawned) launch: refused unless the CURRENT policy still turns `scheduling.autoRun` on (review C4). */ automatic?: boolean;
}
export interface RunE2eResult extends E2eEvaluation { receipts: Array<{ path: string; runId: string; scenarioIds: string[] }>; messages: string[]; }
interface SuiteRun { root: string; projectRoot: string; canonicalRoot: string; policy: E2ePolicy; digest: string; project: E2eProject; suite: E2eSuite; scenarios: E2eScenario[]; deadline: number; options: RunE2eOptions; }
interface Disposable { snapshot: string; runDirectory: string; home: string; controls: Array<{ path: string; bytes: Buffer | null }>; /** Extra env every owned process inherits (the cohort attempt's seed/clock). */ env: NodeJS.ProcessEnv; }

const MAX_TIMEOUT_MS = 600_000;
const PREVIEW_BYTES = 1024;
const NEVER_COPIED = new Set([".git", ".interlinked"]);

function toolchainEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const home = process.env.HOME;
    for (const key of ["CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOCACHE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    if (home && env.CARGO_HOME === undefined && existsSync(join(home, ".cargo"))) env.CARGO_HOME = join(home, ".cargo");
    if (home && env.RUSTUP_HOME === undefined && existsSync(join(home, ".rustup"))) env.RUSTUP_HOME = join(home, ".rustup");
    return env;
}
/** The recorded seed/clock of a cohort attempt, as the language-independent env every owned process sees (§9.5). */
function stabilityEnv(stability: StabilityAttempt | undefined): NodeJS.ProcessEnv {
    if (!stability) return {};
    const env: NodeJS.ProcessEnv = { INTERLINKED_E2E_SEED: stability.seed, INTERLINKED_E2E_COHORT: stability.cohortId, INTERLINKED_E2E_ATTEMPT: String(stability.attempt) };
    if (stability.clock !== "real") env.INTERLINKED_E2E_CLOCK = stability.clock;
    return env;
}
/** §7.4 (E4): the owned application processes (services, contract cases) write V8 coverage under the run when the project declares a node profile; preparation and the test runner do not. */
function observationEnv(ctx: SuiteRun, disposable: Disposable): NodeJS.ProcessEnv {
    const profile = ctx.project.observations?.runtimeCoverage ?? "off";
    return profile === "off" ? {} : { NODE_V8_COVERAGE: join(disposable.runDirectory, COVERAGE_DIRECTORY) };
}
/** After the owned processes have exited: collect their coverage into run-level edges beside the receipt; the summary (not the edges) travels in the receipt. */
function observationsStage(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable): void {
    if ((ctx.project.observations?.runtimeCoverage ?? "off") === "off") return;
    // E3 / round 2 R2: the expected-process inventory BY IDENTITY — every service spawn across every stage (restarts included) and each
    // contract case's own pid; a case that ran without a recorded pid is a gap, never satisfied by a neighbour's helper.
    const expected = {
        services: (receipt.services ?? []).flatMap(service => service.pids.map(pid => ({ id: `${service.id}@${service.stage}`, pid }))),
        processes: receipt.cases.filter(row => row.runnerKind === "process" && (row.state === "passed" || row.state === "failed")).map(row => ({ id: row.id, pid: row.observations?.pid ?? null })),
    };
    const collected = collectNodeCoverage({ coverageDirectory: join(disposable.runDirectory, COVERAGE_DIRECTORY), snapshotRoot: disposable.snapshot, runId: receipt.runId, scenarioIds: receipt.scenarioIds, expected });
    collected.summary.path = writeRuntimeObservations(disposable.runDirectory, collected.edges);
    receipt.observations = collected.summary;
}
/** Explicit inheritance only: PATH and the toolchain homes; HOME is a private directory under the run. */
function prepareEnv(disposable: Disposable): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, HOME: disposable.home, TMPDIR: disposable.runDirectory, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", ...toolchainEnv(), ...disposable.env };
}
/** The caller's cancellation signal, threaded to every owned process (exactOptionalPropertyTypes: absent, not undefined). */
function signalOf(ctx: SuiteRun): { signal: AbortSignal } | Record<string, never> {
    return ctx.options.signal ? { signal: ctx.options.signal } : {};
}
function substitute(argv: string[], disposable: Disposable): string[] {
    return argv.map(token => token.replaceAll("{run-directory}", disposable.runDirectory).replaceAll("{fixture-directory}", join(disposable.runDirectory, "fixture")));
}
/** Copy filter: never the VCS/ledger dirs at the project root, never a symlink (a retained link is a writable reference to the live tree, F2). */
function copyable(projectRoot: string, source: string): boolean {
    if (NEVER_COPIED.has(basename(source)) && !relative(projectRoot, source).includes("/")) return false;
    return !lstatSync(source).isSymbolicLink();
}
/** Frozen control files (manifest + acceptance) captured from the live tree BEFORE preparation (F1); ABSENCE is frozen too (round 3, G1). */
interface FrozenControl { path: string; bytes: Buffer | null; }
function freezeControls(ctx: SuiteRun): FrozenControl[] {
    return [ctx.project.contractManifest ?? CONTRACT_MANIFEST, CONTRACT_POLICY].map(control => {
        const absolute = join(ctx.projectRoot, control);
        return { path: control, bytes: existsSync(absolute) ? readFileSync(absolute) : null };
    });
}
function restoreControls(snapshot: string, frozen: ReadonlyArray<FrozenControl>): void {
    for (const control of frozen) {
        const target = join(snapshot, control.path);
        if (control.bytes === null) { rmSync(target, { force: true }); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, control.bytes);
    }
}
/** The disposable project copy every preparation and case runs against; the live tree is only ever READ. */
function createDisposable(ctx: SuiteRun, runId: string): Disposable {
    const runDirectory = join(ctx.root, E2E_RUNS_DIRECTORY, runId);
    const home = join(runDirectory, "home");
    mkdirSync(join(runDirectory, "fixture"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const snapshot = mkdtempSync(join(tmpdir(), "interlinked-e2e-snapshot-"));
    cpSync(ctx.projectRoot, snapshot, { recursive: true, dereference: false, filter: source => copyable(ctx.projectRoot, source) });
    const controls = freezeControls(ctx);
    restoreControls(snapshot, controls);
    return { snapshot, runDirectory, home, controls, env: stabilityEnv(ctx.options.stability) };
}
/** Why a declared input in the snapshot no longer matches the live input the generation named, or null. `stage` names the writer (preparation / the test command). */
function inputDrift(snapshot: string, file: { path: string; sha256: string; mode?: number }, stage: string): string | null {
    const absolute = join(snapshot, file.path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) return `${stage} removed declared input ${file.path}`;
    const sha256 = digestOf(readFileSync(absolute)), mode = lstatSync(absolute).mode & 0o777;
    if (sha256 !== file.sha256 || (file.mode !== undefined && mode !== file.mode)) return `${stage} modified declared input ${file.path}`;
    return null;
}
/** Paths exempt from drift: regenerated in some scenario AND held in a source role by NO scenario of this run (round-7 H1: a source obligation wins across the whole suite execution). */
function driftExempt(before: Map<string, ScenarioGeneration>): Set<string> {
    const regenerated = new Set<string>(), sourced = new Set<string>();
    for (const row of before.values()) {
        const own = new Set(row.inputs.regenerated);
        for (const path of own) regenerated.add(path);
        for (const file of row.inputs.files) if (!own.has(file.path)) sourced.add(file.path);
    }
    return new Set([...regenerated].filter(path => !sourced.has(path)));
}
/** After a writing stage: every declared project-local input in the snapshot must still be the live input (F1) — except artifact-covered ones the stage is expected to rewrite and no scenario treats as source. */
function stageDrift(snapshot: string, before: Map<string, ScenarioGeneration>, stage: string): string[] {
    const drift: string[] = [];
    const seen = driftExempt(before);
    const files = [...before.values()].flatMap(row => row.inputs.files).filter(file => !isAbsolute(file.path) && !file.path.startsWith("../"));
    for (const file of files) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
        const reason = inputDrift(snapshot, file, stage);
        if (reason) drift.push(reason);
    }
    return drift;
}
/**
 * After EVERY stage that may write into the snapshot (preparation, the native test command — review C1): put the frozen
 * controls back, re-verify the declared inputs against the generation, and re-bind the artifacts from the bytes NOW
 * present (the bytes the contract cases will exercise). Returns false when a declared input drifted: no case may run.
 */
function stageIntact(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, before: Map<string, ScenarioGeneration>, stage: string): { ok: boolean; artifactGaps: string[] } {
    restoreControls(disposable.snapshot, disposable.controls);
    const drift = stageDrift(disposable.snapshot, before, stage);
    receipt.completion.reasons.push(...drift);
    const artifacts = collectProjectInputs(disposable.snapshot, ctx.suite.artifacts ?? []);
    receipt.artifacts = artifacts.files;
    for (const gap of artifacts.gaps) if (!receipt.completion.reasons.includes(gap)) receipt.completion.reasons.push(gap);
    if (drift.length) receipt.completion.reasons.push(`${stage} altered declared inputs; no case executed`);
    return { ok: drift.length === 0, artifactGaps: artifacts.gaps };
}
function cancelled(ctx: SuiteRun): boolean { return ctx.options.signal?.aborted === true; }
async function runPrepare(ctx: SuiteRun, disposable: Disposable): Promise<PrepareResult[]> {
    const results: PrepareResult[] = [];
    for (const step of ctx.suite.prepare ?? []) {
        const argv = substitute(step.argv, disposable), started = Date.now();
        const remaining = ctx.deadline - started;
        if (remaining < 1) { results.push({ argv, exitCode: null, ok: false, durationMs: 0, stdoutSha256: digestOf(""), stderrSha256: digestOf(""), preview: "budget exhausted before this step" }); break; }
        const run = await runProcessAsync(argv[0]!, argv.slice(1), { cwd: disposable.snapshot, timeout: remaining, exactEnv: prepareEnv(disposable), ...signalOf(ctx) });
        const cancelled = ctx.options.signal?.aborted === true;
        const ok = run.code === 0 && !run.timedOut && !run.killed && !cancelled;
        results.push({ argv, exitCode: run.code, ok, durationMs: Date.now() - started, stdoutSha256: digestOf(run.stdout), stderrSha256: digestOf(run.stderr), preview: (cancelled ? "cancelled: " : "") + `${run.stdout}\n${run.stderr}`.trim().slice(-PREVIEW_BYTES) });
        if (!ok) break;
    }
    return results;
}
function toReceiptCase(row: ContractEvidence): ReceiptCase {
    const result: ReceiptCase = { id: row.id, digest: row.digest, authority: row.authority, provenance: row.provenance, state: row.state, runnerKind: row.contract.runner.kind, details: [...row.details] };
    if (row.contract.runner.kind === "http" && "service" in row.contract.runner) result.service = row.contract.runner.service;
    if (row.inputHash !== undefined) result.inputHash = row.inputHash;
    if (row.observations) result.observations = row.observations;
    return result;
}
function attemptStatus(receipt: E2eReceipt, scenario: E2eScenario, changed: boolean): AttemptStatus {
    if (receipt.prepare.some(step => !step.ok) || !receipt.completion.complete) return "unavailable";
    if (changed) return "stale";
    const states = [...scenario.contractIds, ...(scenario.caseIds ?? [])].map(id => receipt.cases.find(row => row.id === id)?.state ?? "not-run");
    if (states.includes("failed")) return "failed";
    if (states.includes("stale")) return "stale";
    const sensitivity = receipt.sensitivity?.[scenario.id];
    if (sensitivity && sensitivity.verdict !== "demonstrated" && sensitivity.verdict !== "preserved") return "unavailable"; // a required proof mode not demonstrated keeps the obligation open (§9.4)
    return states.every(state => state === "passed") ? "passed" : "unavailable";
}
function seedReceipt(ctx: SuiteRun, runId: string, before: Map<string, ScenarioGeneration>): E2eReceipt {
    const combined = digestOf([...before.entries()].map(([id, row]) => [id, row.generation]));
    const receipt = emptyReceipt({ runId, project: { id: ctx.project.id, root: ctx.project.root, canonicalRoot: ctx.canonicalRoot }, scenarioIds: ctx.scenarios.map(row => row.id), policyDigest: ctx.digest, generation: combined });
    receipt.scenarioGenerations = Object.fromEntries([...before.entries()].map(([id, row]) => [id, row.generation]));
    receipt.runtime.interlinked = resolveOwnVersionFrom(import.meta.url);
    if (ctx.options.sessionId) receipt.initiator = ctx.options.sessionId;
    if (ctx.options.stability) receipt.stability = { ...ctx.options.stability };
    const files = new Map<string, { path: string; sha256: string }>();
    for (const row of before.values()) { for (const file of row.inputs.files) files.set(file.path, file); receipt.inputGaps.push(...row.gaps); }
    receipt.inputs = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    receipt.selection.required = [...new Set(ctx.scenarios.flatMap(row => [...row.contractIds, ...(row.caseIds ?? [])]))];
    receipt.authority = ctx.policy.expectations.filter(row => ctx.scenarios.some(scenario => scenario.expectationIds?.includes(row.id)))
        .map(row => ({ expectationId: row.id, lifecycle: row.lifecycle, origin: row.origin, revision: row.revision }));
    return receipt;
}
function generations(ctx: SuiteRun): Map<string, ScenarioGeneration> {
    return new Map(ctx.scenarios.map(scenario => [scenario.id, scenarioGeneration(ctx.root, ctx.policy, ctx.digest, ctx.project, scenario, ctx.options.gitRoot ?? ctx.root)]));
}
/** Obligation key → generation this run set out to certify (the identity requests and attempt records bind to). */
function certifiedGenerations(ctx: SuiteRun, before: Map<string, ScenarioGeneration>): Record<string, string> {
    return Object.fromEntries([...before.entries()].map(([scenarioId, row]) => [scenarioKey(ctx.project.id, scenarioId), row.generation]));
}
/** The native test stage (structured-runner suites): the command runs, its report is normalized, then the snapshot is re-verified exactly as after preparation (C1). */
async function nativeStage(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, before: Map<string, ScenarioGeneration>): Promise<{ ok: boolean; artifactGaps: string[] } | null> {
    if (ctx.suite.adapter === "managed-contracts") return null;
    const ran = ctx.suite.adapter === "playwright" ? await runBrowser(ctx, receipt, disposable) : await runStructured(ctx, receipt, disposable);
    if (!ran) return { ok: false, artifactGaps: [] };
    return stageIntact(ctx, receipt, disposable, before, "the test command");
}
/** The owned service the browser is driven through: the scenarios' declared `boundary.service`, else the suite's first service; a disagreement is a run gap. */
function browserServiceId(ctx: SuiteRun, receipt: E2eReceipt): string | null {
    const declared = [...new Set(ctx.scenarios.map(row => row.boundary?.service).filter((id): id is string => id !== undefined))];
    if (declared.length > 1) { receipt.completion.reasons.push(`scenarios disagree on the browser service (${declared.join(", ")}); one run fronts one application, so no browser case executed`); return null; }
    return declared[0] ?? ctx.suite.services?.[0]?.id ?? null;
}
/** Unit E2 (§10.2): the browser stage runs through injected primitives so `browser-stage.ts` owns the Playwright logic without importing the runner. */
async function runBrowser(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable): Promise<boolean> {
    const spec = ctx.suite.report!, reportPath = join(disposable.snapshot, spec.path), serviceId = browserServiceId(ctx, receipt);
    if (serviceId === null) return false;
    if (existsSync(reportPath)) { rmSync(reportPath, { force: true }); receipt.completion.reasons.push(`pre-existing report ${spec.path} removed before the run; only a report this run writes counts`); }
    return runBrowserStage({
        snapshot: disposable.snapshot, serviceId, declared: declaredNativeIds(ctx), runArgv: substitute(ctx.suite.run!.argv, disposable), reportPath, reasons: receipt.completion.reasons, cases: receipt.cases,
        startServices: () => startServices(ctx, receipt, disposable, "browser"), stopServices: owned => stopServices(owned, receipt),
        runCommand: (argv, env) => runTestCommand(ctx, receipt, disposable, { argv, env }), readReport: () => readStructuredReport(receipt, spec, reportPath),
    });
}
/** §9.1 step 6–7 (D1): allocate a port per declared service, start it in the snapshot in declaration order, stop at the first that is not ready. */
async function startServices(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, stage: ServiceStage): Promise<Map<string, OwnedService>> {
    const owned = new Map<string, OwnedService>();
    for (const spec of ctx.suite.services ?? []) {
        const port = await allocatePort();
        const withPort = (token: string) => token.replaceAll("{port}", String(port));
        const argv = substitute(spec.argv, disposable).map(withPort);
        const env = { ...prepareEnv(disposable), ...observationEnv(ctx, disposable), ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value]) => [key, withPort(substitute([value], disposable)[0]!)])) };
        const service = createOwnedService(spec, { argv, env, cwd: disposable.snapshot, logDir: join(disposable.runDirectory, "services"), port, stage });
        owned.set(spec.id, service);
        if (await startService(service, ctx.deadline)) continue;
        receipt.completion.reasons.push(`service ${spec.id} not ready: ${service.record.ready.reason ?? "unknown"}; no case executed`);
        break;
    }
    return owned;
}
/** §9.1 step 10 (D1): stop every owned service (reverse order) and record the outcome; a failed teardown or a port that still answers makes the run incomplete (PE-26). */
async function stopServices(owned: Map<string, OwnedService>, receipt: E2eReceipt): Promise<boolean> {
    let ok = true;
    for (const service of [...owned.values()].reverse()) {
        const shutdown = await stopService(service);
        if (!shutdown.ok) { ok = false; receipt.completion.reasons.push(`service ${service.spec.id} shutdown failed: ${shutdown.reason ?? "unknown"}`); }
    }
    // Round 2 R1: the receipt's inventory is APPEND-ONLY across stages — the browser stage's lifetime is not replaced by the contract stage's.
    receipt.services = [...(receipt.services ?? []), ...[...owned.values()].map(service => service.record)];
    return ok;
}
function serviceBinding(owned: Map<string, OwnedService>, ctx: SuiteRun): ServiceBinding {
    return {
        baseUrl: id => { const service = owned.get(id); return service?.child && service.record.ready.ok ? serviceBaseUrl(service.record.port) : null; },
        restart: async id => { const service = owned.get(id); return service ? restartService(service, ctx.deadline) : false; },
    };
}
async function runContracts(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, owned: Map<string, OwnedService>): Promise<boolean> {
    const remaining = ctx.deadline - Date.now();
    if (remaining < 1) { receipt.completion.reasons.push("budget exhausted before case execution"); return false; }
    const contractIds = new Set(ctx.scenarios.flatMap(row => row.contractIds));
    const report = await runContractsUnderLease(disposable.snapshot, { timeoutMs: remaining, only: contractIds, services: serviceBinding(owned, ctx), env: { ...disposable.env, ...observationEnv(ctx, disposable) }, ...(ctx.project.contractManifest ? { path: ctx.project.contractManifest } : {}), ...signalOf(ctx) }, ctx.deadline);
    receipt.cases.push(...report.cases.filter(row => contractIds.has(row.id)).map(toReceiptCase));
    receipt.selection.observed = receipt.cases.map(row => row.id);
    receipt.completion.reasons.push(...report.gaps);
    if (cancelled(ctx)) { receipt.completion.reasons.push("cancelled during contract execution; no case result is trusted"); return false; }
    return true;
}
/** Services up → contracts → services down. The stage is ok only when every declared service was ready AND stopped cleanly and the contracts ran to completion. */
async function contractsStage(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable): Promise<boolean> {
    const owned = await startServices(ctx, receipt, disposable, "contracts");
    const allReady = owned.size === (ctx.suite.services ?? []).length && [...owned.values()].every(service => service.record.ready.ok);
    let ok = false;
    try { ok = allReady && (await runContracts(ctx, receipt, disposable, owned)); }
    finally { if (!(await stopServices(owned, receipt))) ok = false; }
    return ok;
}
async function executeSuite(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, before: Map<string, ScenarioGeneration>): Promise<void> {
    receipt.prepare = await runPrepare(ctx, disposable);
    let stage = stageIntact(ctx, receipt, disposable, before, "preparation"); // the accepted definitions and the generation's inputs, not whatever preparation left behind (F1)
    if (receipt.prepare.some(step => !step.ok)) { receipt.completion.reasons.push("preparation failed; no case executed"); return; }
    if (!stage.ok) return;
    stage = (await nativeStage(ctx, receipt, disposable, before)) ?? stage;
    if (!stage.ok) return;
    if (cancelled(ctx)) { receipt.completion.reasons.push("cancelled before contract execution; no case executed"); return; }
    const ok = await contractsStage(ctx, receipt, disposable);
    receipt.completion.complete = ok && stage.artifactGaps.length === 0;
}
/** The declared native ids; a report case nobody declared is observed but never required (selection is explicit, §10.1). */
function declaredNativeIds(ctx: SuiteRun): Set<string> { return new Set(ctx.scenarios.flatMap(row => row.caseIds ?? [])); }
/**
 * C2: run the suite's test command in the snapshot and normalize the report it WROTE. Any report already at that path
 * is removed before the run (a leftover cannot be substituted); a missing, oversized or unparseable report leaves the
 * run incomplete. Returns false when no case may proceed.
 */
/** Runs a test command in the snapshot and records its outcome; null when no report may be trusted (budget, timeout, kill, cancellation). */
async function runTestCommand(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, command: { argv: string[]; env: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null } | null> {
    const argv = command.argv, started = Date.now(), remaining = ctx.deadline - started;
    if (remaining < 1) { receipt.completion.reasons.push("budget exhausted before the test command"); return null; }
    const run = await runProcessAsync(argv[0]!, argv.slice(1), { cwd: disposable.snapshot, timeout: remaining, exactEnv: { ...prepareEnv(disposable), ...command.env }, ...signalOf(ctx) });
    const interrupted = run.code === null || run.timedOut || run.killed || cancelled(ctx);
    receipt.execution = { argv, exitCode: run.code, ok: !interrupted && run.code === 0, durationMs: Date.now() - started, stdoutSha256: digestOf(run.stdout), stderrSha256: digestOf(run.stderr), preview: `${run.stdout}\n${run.stderr}`.trim().slice(-PREVIEW_BYTES) };
    if (interrupted) { receipt.completion.reasons.push(`test command ${argv.join(" ")} was ${cancelled(ctx) ? "cancelled" : "interrupted (timeout/kill)"}; no report is trusted`); return null; }
    return { exitCode: run.code };
}
/** The report the command wrote, normalized; null (with a completion reason) when missing, not a file, oversized or unparseable. */
async function readStructuredReport(receipt: E2eReceipt, spec: { format: ReportFormat; path: string }, reportPath: string): Promise<StructuredReport | null> {
    if (!existsSync(reportPath) || !lstatSync(reportPath).isFile()) { receipt.completion.reasons.push(`structured report ${spec.path} was not produced by the run`); return null; }
    const bytes = readFileSync(reportPath);
    try {
        const parsed = await parseStructuredReport(bytes.toString("utf8"), spec.format);
        receipt.report = { format: spec.format, path: spec.path, sha256: digestOf(bytes), cases: parsed.cases.length };
        return parsed;
    } catch (error) { receipt.completion.reasons.push(`structured report ${spec.path} unreadable: ${error instanceof Error ? error.message : String(error)}`); return null; }
}
async function runStructured(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable): Promise<boolean> {
    const spec = ctx.suite.report!, reportPath = join(disposable.snapshot, spec.path);
    if (existsSync(reportPath)) { rmSync(reportPath, { force: true }); receipt.completion.reasons.push(`pre-existing report ${spec.path} removed before the run; only a report this run writes counts`); }
    const run = await runTestCommand(ctx, receipt, disposable, { argv: substitute(ctx.suite.run!.argv, disposable), env: {} });
    if (!run) return false;
    const parsed = await readStructuredReport(receipt, spec, reportPath);
    if (!parsed) return false;
    const declared = declaredNativeIds(ctx);
    receipt.cases.push(...parsed.cases.filter(row => declared.has(row.id)).map(row => structuredCase(spec.format, row)));
    // Review C2: a nonzero exit is explained only by a failure the report itself records; an all-green report under a
    // failing command (teardown, a crashed reporter, a runner that never ran the suite) leaves the run incomplete.
    if (run.exitCode !== 0 && !parsed.cases.some(row => row.status === "failed" || row.status === "error")) { receipt.completion.reasons.push(`test command exited ${run.exitCode} but its report records no failure; the exit is unexplained and no case result certifies completion`); return false; }
    return true;
}
function publish(ctx: SuiteRun, receipt: E2eReceipt, before: Map<string, ScenarioGeneration>, startedMs: number): { path: string; runId: string; scenarioIds: string[] } {
    const after = generations(ctx);
    const changedScenarios = new Set([...before.entries()].filter(([id, row]) => after.get(id)?.generation !== row.generation).map(([id]) => id));
    receipt.completion.generationAfter = digestOf([...after.entries()].map(([id, row]) => [id, row.generation]));
    receipt.completion.inputsChangedDuringRun = changedScenarios.size > 0;
    receipt.completion.durationMs = Date.now() - startedMs;
    receipt.finishedAt = new Date().toISOString();
    // Attribution (C4, PE-12; round 2 D1): FROZEN at publication — every request open for exactly these keys at exactly
    // these generations rides on this run, and exactly these ids are served below. A request arriving later stays open.
    receipt.requestIds = [...new Set([...(ctx.options.requestIds ?? []), ...matchingRequests(ctx.root, certifiedGenerations(ctx, before))])].sort();
    const path = writeE2eReceipt(ctx.root, receipt);
    for (const scenario of ctx.scenarios) {
        const status = attemptStatus(receipt, scenario, changedScenarios.has(scenario.id));
        const reason = status === "passed" ? "supervised run passed" : `${status}: ${receipt.completion.reasons.join("; ") || receipt.cases.filter(row => row.state !== "passed").map(row => `${row.id} ${row.state}`).join(", ")}`;
        appendE2eTxn(ctx.root, { op: "attempt", key: scenarioKey(ctx.project.id, scenario.id), generation: before.get(scenario.id)!.generation, runId: receipt.runId, status, atMs: Date.now(), receipt: path, reason });
    }
    serveRequests(ctx.root, receipt.runId, receipt.requestIds, Date.now()); // exactly the ids the receipt names (D1)
    return { path, runId: receipt.runId, scenarioIds: ctx.scenarios.map(row => row.id) };
}
/**
 * §9.4 (D3): the comparison side is a SECOND immutable disposable snapshot — a git export of the pinned revision, or the
 * candidate with exactly one recorded fault applied — with its own run directory, data, ports and lifecycle. The
 * candidate's frozen controls (manifest + acceptance) are restored into it, so the test digest is fixed on both sides.
 */
async function comparisonDisposable(ctx: SuiteRun, disposable: Disposable, scenario: E2eScenario): Promise<{ side: Disposable; built: BuildResult }> {
    const proof = scenario.proof!, runDirectory = join(disposable.runDirectory, "comparison", scenario.id), home = join(runDirectory, "home");
    mkdirSync(join(runDirectory, "fixture"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const snapshot = mkdtempSync(join(tmpdir(), "interlinked-e2e-comparison-"));
    let built: BuildResult;
    if (proof.mode === "controlled-fault") { cpSync(ctx.projectRoot, snapshot, { recursive: true, dereference: false, filter: source => copyable(ctx.projectRoot, source) }); built = applyFault(snapshot, proof.fault!); }
    else built = await exportRevision(join(ctx.options.gitRoot ?? ctx.root, ctx.project.root), proof.revision!, snapshot); // the REAL repository's project dir (review F2-3)
    if (built.ok) restoreControls(snapshot, disposable.controls);
    return { side: { snapshot, runDirectory, home, controls: disposable.controls, env: disposable.env }, built };
}
/** One side's outcomes WITH the phase evidence the classifier reads (review D1): which observables differed, primary output, how the invocation ended. */
function outcomesFor(cases: ReceiptCase[], ids: readonly string[]): SideOutcome[] {
    return cases.filter(row => ids.includes(row.id)).map(row => {
        const outcome: SideOutcome = { id: row.id, state: row.state };
        const observed = row.observations;
        if (!observed) return outcome;
        outcome.matched = observed.matched ?? [];
        outcome.mismatched = observed.mismatched ?? [];
        outcome.primaryOutput = observed.stdoutPreview.length > 0;
        if (observed.exitCode !== undefined) outcome.exitCode = observed.exitCode;
        if (observed.status !== undefined) outcome.status = observed.status;
        return outcome;
    });
}
interface ComparisonRun { prepared: boolean; complete: boolean; reasons: string[]; services: ServiceRecord[]; cases: ReceiptCase[]; }
/** Prepare → services → contracts on the comparison snapshot for ONE scenario; a sink receipt collects what the classifier needs, INCLUDING the lifecycle outcome (review D2). */
async function runComparison(ctx: SuiteRun, scenario: E2eScenario, side: Disposable): Promise<ComparisonRun> {
    const sideCtx: SuiteRun = { ...ctx, scenarios: [scenario] };
    const sink = emptyReceipt({ runId: `comparison-${scenario.id}`, project: { id: ctx.project.id, root: ctx.project.root, canonicalRoot: ctx.canonicalRoot }, scenarioIds: [scenario.id], policyDigest: ctx.digest, generation: "0".repeat(64) });
    sink.prepare = await runPrepare(sideCtx, side);
    if (sink.prepare.some(step => !step.ok)) return { prepared: false, complete: false, reasons: ["comparison preparation failed"], services: [], cases: [] };
    restoreControls(side.snapshot, side.controls);
    const complete = await contractsStage(sideCtx, sink, side);
    return { prepared: (sink.services ?? []).every(service => service.ready.ok), complete, reasons: sink.completion.reasons, services: sink.services ?? [], cases: sink.cases };
}
async function sensitivityFor(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable, scenario: E2eScenario): Promise<SensitivityRecord> {
    const proof = scenario.proof as E2eProof & { mode: Exclude<ProofMode, "execution"> }; // SAFETY: callers filter execution mode out
    const designated: E2eDesignated[] = proof.designated ?? scenario.contractIds.map(id => ({ id })), candidate = outcomesFor(receipt.cases, scenario.contractIds);
    const kind = proof.mode === "controlled-fault" ? "fault" as const : "revision" as const;
    const base = { mode: proof.mode, designated, candidate };
    if (proofCaseIds(designated).some(id => candidate.find(row => row.id === id)?.state !== "passed")) return { ...base, compared: [], comparison: { kind, identity: "not-built", description: "the candidate did not pass; no comparison was built" }, ...classifySensitivity({ ...base, compared: [], comparisonPrepared: false, comparisonComplete: false }) };
    const { side, built } = await comparisonDisposable(ctx, disposable, scenario);
    if (!built.ok) return { ...base, compared: [], comparison: { kind, identity: "unavailable", description: built.reason }, verdict: "inconclusive", category: "comparison-unavailable", reasons: [built.reason] };
    try {
        const run = await runComparison(ctx, scenario, side);
        const compared = outcomesFor(run.cases, scenario.contractIds);
        const lifecycle: NonNullable<SensitivityRecord["lifecycle"]> = { complete: run.complete, reasons: run.reasons };
        if (run.services.length) lifecycle.services = run.services;
        return { ...base, compared, lifecycle, comparison: { kind, identity: built.identity, description: built.description }, ...classifySensitivity({ ...base, compared, comparisonPrepared: run.prepared, comparisonComplete: run.complete, comparisonReasons: run.reasons }) };
    } finally { rmSync(side.snapshot, { recursive: true, force: true }); }
}
async function sensitivityStage(ctx: SuiteRun, receipt: E2eReceipt, disposable: Disposable): Promise<void> {
    for (const scenario of ctx.scenarios) {
        if (!scenario.proof || scenario.proof.mode === "execution") continue;
        receipt.sensitivity = { ...receipt.sensitivity, [scenario.id]: await sensitivityFor(ctx, receipt, disposable, scenario) };
    }
}
async function runSuite(ctx: SuiteRun): Promise<{ path: string; runId: string; scenarioIds: string[] }> {
    const runId = randomUUID(), startedMs = Date.now();
    const before = generations(ctx);
    const receipt = seedReceipt(ctx, runId, before);
    const disposable = createDisposable(ctx, runId);
    // Durable from the first instant (C3): if this process dies before publication, the record makes the attempt an explicit unavailable, never silence.
    writeAttemptRecord(ctx.root, { version: 1, runId, pid: process.pid, hostname: hostname(), startedAt: receipt.startedAt, projectId: ctx.project.id, scenarioIds: ctx.scenarios.map(row => row.id), keys: Object.keys(certifiedGenerations(ctx, before)), generations: certifiedGenerations(ctx, before) });
    try { await executeSuite(ctx, receipt, disposable, before); if (receipt.completion.complete) await sensitivityStage(ctx, receipt, disposable); observationsStage(ctx, receipt, disposable); }
    finally { rmSync(disposable.snapshot, { recursive: true, force: true }); }
    return publish(ctx, receipt, before, startedMs);
}
function groupBySuite(selection: Selected[]): Array<{ project: E2eProject; suite: E2eSuite; scenarios: E2eScenario[] }> {
    const groups = new Map<string, { project: E2eProject; suite: E2eSuite; scenarios: E2eScenario[] }>();
    for (const { project, scenario } of selection) {
        const key = `${project.id}\0${scenario.suite}`;
        const suite = project.suites.find(row => row.id === scenario.suite)!;
        const group = groups.get(key) ?? { project, suite, scenarios: [] };
        group.scenarios.push(scenario);
        groups.set(key, group);
    }
    return [...groups.values()];
}
function canonical(path: string): string { try { return realpathSync(path); } catch { return path; } }
/** Explicit supervised execution. Returns the post-run evaluation plus the receipts written. */
export async function runProjectE2e(options: RunE2eOptions): Promise<RunE2eResult> {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) throw new Error(`e2e: timeout must be 1–${MAX_TIMEOUT_MS} ms`);
    const loaded = loadE2ePolicy(options.root);
    const evaluateOptions = { root: options.root, atMs: Date.now(), ...(options.gitRoot ? { gitRoot: options.gitRoot } : {}), ...(options.projectId ? { projectId: options.projectId } : {}), ...(options.scenarioIds ? { scenarioIds: options.scenarioIds } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
    if (loaded.status !== "configured") return { ...evaluateE2e(evaluateOptions), receipts: [], messages: [loaded.status === "invalid" ? `policy invalid: ${loaded.reason}` : "UNCONFIGURED: no e2e policy; nothing was run"] };
    if (options.automatic && !effectiveScheduling(loaded.policy).autoRun) return { ...evaluateE2e(evaluateOptions), receipts: [], messages: ["automatic execution is off in the current policy (scheduling.autoRun); nothing was run"] };
    const selection = selectScenarios(loaded.policy, options);
    recoverOrphanedRuns(options.root, Date.now()); // a crashed earlier run becomes an explicit unavailable attempt before anything new starts (C3)
    // Open the obligation at the snapshot this run will certify (§9.1 step 1): an attempt whose
    // generation the ledger never saw would be historical evidence for nothing.
    reconcileChanges({ root: options.root, changedPaths: "all", atMs: Date.now(), ...(options.gitRoot ? { gitRoot: options.gitRoot } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
    const out: Pick<RunE2eResult, "receipts" | "messages"> = { receipts: [], messages: [] };
    const deadline = Date.now() + options.timeoutMs;
    for (const group of groupBySuite(selection)) await runGroup({ policy: loaded.policy, digest: loaded.digest, group, options, deadline }, out);
    return { ...evaluateE2e(evaluateOptions), ...out };
}
interface GroupRun { policy: E2ePolicy; digest: string; group: ReturnType<typeof groupBySuite>[number]; options: RunE2eOptions; deadline: number; }
/** One suite group under the project's heavy-process lease. A cancelled (C3) or lease-starved admission retains the request; nothing runs. */
async function runGroup(input: GroupRun, out: Pick<RunE2eResult, "receipts" | "messages">): Promise<void> {
    const { group, options, deadline } = input;
    const projectRoot = group.project.root === "." ? options.root : join(options.root, group.project.root), label = `${group.project.id}/${group.suite.id}`;
    if (options.signal?.aborted) { out.messages.push(`${label}: cancelled before admission; nothing was run and the obligation stays open`); return; }
    const budget = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const release = await acquireProjectHeavyProcessLease(projectRoot, deadline, options.signal ? AbortSignal.any([budget, options.signal]) : budget);
    if (!release) { out.messages.push(`${label}: deferred — project heavy-process lease unavailable within budget; request retained`); return; }
    try { out.receipts.push(await runSuite({ root: options.root, projectRoot, canonicalRoot: canonical(projectRoot), policy: input.policy, digest: input.digest, project: group.project, suite: group.suite, scenarios: group.scenarios, deadline, options })); }
    finally { release(); }
}
