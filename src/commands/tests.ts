import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { output, outputError, getOutputMode } from "../lib/output.js";
import { hashBytes } from "../lib/metrics/inventory.js";
import { changedTestInputs, loadTestPlan } from "../harness/test-plan-inputs.js";
import { pendingTests } from "../harness/test-requests.js";
import { scheduleTests, type ScheduleTestsOptions } from "../harness/test-scheduler.js";
import type { TestPlan } from "../harness/test-plan.js";
import { readTestRunObservation } from "../harness/test-run-observation.js";
import { receiptStorePath, type TestExecution } from "../harness/test-run-receipt.js";
import { stageFromEnvironment } from "../harness/verification-stages.js";
import { isJsonObject } from "../lib/json-types.js";

interface TestsOptions {
    cwd?: string; base?: string; all?: boolean; json?: boolean; timeout?: string; workers?: string;
    coverage?: boolean; coverageReporter?: string[]; receiptStore?: string; artifactsOut?: string;
}

/** The checkout root a coverage scope was recorded from (the run's root at the time), or null when the artifact is not a scope. */
function recordedRoot(name: string, bytes: Buffer): string | null {
    if (name !== "coverage_scope") return null;
    const scope: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof scope === "object" && scope !== null && "root" in scope && typeof scope.root === "string" ? scope.root : null;
}

/**
 * Coverage artifacts name the run's absolute checkout root (the scope's `root`, the summary's file keys). A reused run may
 * come from another export of the same bytes. Relocate only the scope root and summary path keys, after the stored
 * bytes match the receipt's sha256. JSON parsing preserves quoting and literal replacement characters in paths.
 */
function relocated(name: string, bytes: Buffer, fromRoot: string | null, toRoot: string): Buffer {
    if (!fromRoot || fromRoot === toRoot || (name !== "coverage_scope" && name !== "coverage_summary")) return bytes;
    const data: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isJsonObject(data)) throw new Error(`Invalid ${name} artifact`);
    const relocated = name === "coverage_scope" ? { ...data, root: toRoot } : Object.fromEntries(Object.entries(data).map(([path, entry]) => {
        const suffix = relative(fromRoot, path);
        const inside = isAbsolute(path) && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
        return [inside ? resolve(toRoot, suffix) : path, entry];
    }));
    return Buffer.from(JSON.stringify(relocated), "utf8");
}

/**
 * Copies the certified run's artifacts (fresh or reused) out of the receipt store, verifying each file against the
 * sha256 the receipt recorded, so a consumer such as the pre-push hook gets exactly the bytes the run produced —
 * re-rooted to this checkout when the run happened in another export of the same bytes.
 */
function exportArtifacts(root: string, result: TestExecution, store: string | undefined, destination: string): string[] {
    const exported: string[] = [];
    mkdirSync(destination, { recursive: true });
    // A shared run's artifacts live in the PRODUCING drain's store, which may not be this caller's own.
    const artifactStore = result.artifactStore ?? receiptStorePath(root, store);
    const entries = Object.entries(result.artifacts ?? {}).map(([name, artifact]) => {
        const source = join(artifactStore, artifact.path);
        const bytes = readFileSync(source);
        if (hashBytes(bytes) !== artifact.sha256) throw new Error(`Artifact ${name} at ${source} does not match the receipt's sha256; not exported`);
        return { name, artifact, bytes };
    });
    const fromRoot = result.artifactRoot ?? entries.map(entry => recordedRoot(entry.name, entry.bytes)).find(value => value !== null) ?? null;
    for (const { name, artifact, bytes } of entries) {
        const target = join(destination, basename(artifact.path));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, relocated(name, bytes, fromRoot, root));
        exported.push(target);
    }
    return exported;
}

export function formatTestPlan(plan: TestPlan): string {
    const summary = `${plan.mode}: ${plan.tests.length} test files; ${plan.omitted.length} omitted; estimated serial time ${plan.estimatedSerialMs === null ? "unmeasured" : `${plan.estimatedSerialMs} ms`}`;
    return [summary, `Snapshot: ${plan.snapshot}`, `Result reuse: ${plan.reusable ? "eligible after runtime validation" : "disabled for uncertain inputs"}`,
        ...plan.reasons, ...plan.tests.map(test => `${test.path}: ${test.reasons.join("; ")}`)].join("\n");
}

/** Schedules the run with the CLI's coverage/store choices and exports the certified artifacts when asked. */
async function runScheduled(root: string, changed: string[], timeoutMs: number, options: TestsOptions): Promise<TestExecution & { exported: string[] }> {
    const receiptStore = options.receiptStore ? resolve(root, options.receiptStore) : undefined;
    // The declared stage (the pre-push hook exports `push`) reaches the ledger rows this run writes.
    const request: ScheduleTestsOptions = { root, paths: changed, timeoutMs, full: options.all === true, maxWorkers: positive(options.workers, 2, 64), stage: stageFromEnvironment("cli") };
    if (options.coverage) request.coverage = { reporters: (options.coverageReporter ?? []).map(reporter => resolve(root, reporter)) };
    if (receiptStore) request.receiptStore = receiptStore;
    const result = await scheduleTests(request);
    const exported = options.artifactsOut && result.status === "passed" ? exportArtifacts(root, result, receiptStore, resolve(root, options.artifactsOut)) : [];
    return { ...result, exported };
}

function positive(value: string | undefined, fallback: number, maximum: number): number {
    const number = Number(value ?? fallback);
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Expected an integer from 1 to ${maximum}`);
    return number;
}

export async function testsCommand(kind: "plan" | "run" | "status", paths: string[], options: TestsOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const root = realpathSync(options.cwd ?? process.cwd());
        const pending = pendingTests(root);
        if (kind === "status") {
            const latest = readTestRunObservation(root);
            output(mode, { ...pending, latest }, { normal: () => `${pending.ids.length} pending requests\n${pending.paths.join("\n")}\nLast observation: ${latest ? `${latest.status} ${latest.runId} at ${latest.observedAt} (owner PID ${latest.pid})` : "none"}` });
            return;
        }
        const timeoutMs = positive(options.timeout, 60_000, 3_600_000);
        const changed = paths.length || options.all ? paths : changedTestInputs(root, options.base);
        if (kind === "plan") {
            const plan = await loadTestPlan(root, [...new Set([...changed, ...pending.paths])], timeoutMs, options.all === true || pending.full);
            output(mode, plan, { normal: () => formatTestPlan(plan) });
            return;
        }
        const result = await runScheduled(root, changed, timeoutMs, options);
        output(mode, result, { normal: () => [`${result.status}${result.reused ? " (reused)" : ""}: ${result.durationMs} ms; run ${result.runId}`, formatTestPlan(result.plan),
            result.reason, result.output, ...result.exported.map(path => `artifact: ${path}`)].join("\n") });
        // A failed run is exit 1; deferred/stale runs produced NO verdict and exit 75 (EX_TEMPFAIL), like the bounded runner.
        if (result.status === "failed") process.exitCode = 1;
        else if (result.status !== "passed" && result.status !== "empty") process.exitCode = 75;
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "Test planning unavailable"); }
}
