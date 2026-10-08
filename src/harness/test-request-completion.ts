import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { isJsonObject } from "../lib/json-types.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { normalizeTestInput } from "./test-plan-inputs.js";
import { type Obligation, parseObligation, readRequestObligation } from "./test-requests.js";
import { captureTestRuntime, changedKnownTestInputs } from "./test-runtime.js";
import type { TestExecution } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";

export interface CompletionInputs { inputHash: string; environmentHash: string; known: Map<string, string>; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function duration(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === "boolean"; }
function executionPlatform(): string { return JSON.stringify([process.versions, process.platform, process.arch, release()]); }
function planRecord(value: unknown): value is TestPlan {
    return isJsonObject(value) && value.version === 1 && typeof value.snapshot === "string"
        && (value.mode === "full" || value.mode === "selected") && strings(value.changedPaths)
        && strings(value.omitted) && strings(value.reasons) && typeof value.reusable === "boolean"
        && optionalString(value.runtimeHash) && optionalString(value.runtimeIssue)
        && (value.estimatedSerialMs === null || duration(value.estimatedSerialMs))
        && Array.isArray(value.tests) && value.tests.every(test => isJsonObject(test) && typeof test.path === "string"
            && strings(test.reasons) && (test.durationMs === null || duration(test.durationMs)));
}
function completedResult(value: unknown): value is TestExecution {
    return isJsonObject(value) && (value.status === "passed" || value.status === "empty") && planRecord(value.plan)
        && typeof value.runId === "string" && typeof value.reused === "boolean" && duration(value.durationMs)
        && optionalBoolean(value.runtimeVerified) && optionalBoolean(value.shared)
        && typeof value.reason === "string" && typeof value.output === "string";
}
function atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
}

/** Completion belongs to these pending requests; it is not a reusable test cache. */
export function publishTestCompletion(root: string, ids: string[], result: TestExecution, inputs: CompletionInputs): void {
    const directory = join(root, ".interlinked/test-runs/completions");
    mkdirSync(directory, { recursive: true });
    const record = `${randomUUID()}.result`;
    atomicJson(join(directory, record), { version: 1, platform: executionPlatform(), result, inputHash: inputs.inputHash,
        environmentHash: inputs.environmentHash, known: [...inputs.known] });
    // Each pointer keeps the completed request's OBLIGATION: its file is removed next, and a later handover after this
    // completion goes stale must requeue the shared request's full scope and requirements, not one waiter's subset.
    for (const id of ids) {
        const request = readRequestObligation(root, id);
        atomicJson(join(directory, id), request ? { record, request } : { record });
    }
}

/** The obligation a completion pointer recorded for `id`, or null (no pointer, malformed, or an older pointer format). */
export function completedObligation(root: string, id: string): Obligation | null {
    try {
        const pointer: unknown = JSON.parse(readFileSync(join(root, ".interlinked/test-runs/completions", `${id}.json`), "utf8"));
        return isJsonObject(pointer) ? parseObligation(pointer.request) : null;
    } catch {
        return null;
    }
}

function knownInputs(root: string, value: unknown): Map<string, string> | null {
    if (!Array.isArray(value) || !value.every(pair => strings(pair) && pair.length === 2)) return null;
    const result = new Map<string, string>();
    for (const pair of value) {
        if (!strings(pair) || pair[0] === undefined || pair[1] === undefined) return null;
        result.set(normalizeTestInput(root, pair[0]), pair[1]);
    }
    return result;
}

async function runtimeMatches(root: string, result: TestExecution, deadline: number): Promise<boolean> {
    if (!result.runtimeVerified) return true;
    if (!result.plan.runtimeHash) return false;
    const current = await captureTestRuntime(root, deadline);
    return !current.issue && current.hash === result.plan.runtimeHash;
}

/** Removes `id`'s completion pointer once a newer audit row hands its obligation on (the record itself is shared and kept). */
export function retractTestCompletion(root: string, id: string): void {
    rmSync(join(root, ".interlinked/test-runs/completions", `${id}.json`), { force: true });
}

export async function readTestCompletion(root: string, id: string, deadline: number): Promise<TestExecution | null> {
    try {
        const directory = join(root, ".interlinked/test-runs/completions");
        const pointer: unknown = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
        if (!isJsonObject(pointer) || typeof pointer.record !== "string" || !/^[a-f0-9-]+\.result$/.test(pointer.record)) return null;
        const value: unknown = JSON.parse(readFileSync(join(directory, pointer.record), "utf8"));
        if (!isJsonObject(value) || value.version !== 1 || value.platform !== executionPlatform() || !completedResult(value.result)) return null;
        const known = knownInputs(root, value.known);
        if (!known || value.inputHash !== collectRepositoryInventory(root).inputHash
            || value.environmentHash !== captureVitestEnvironment().environmentHash || changedKnownTestInputs(root, known).length) return null;
        if (!await runtimeMatches(root, value.result, deadline)) return null;
        return { ...value.result, shared: true, reason: `Shared completed request. ${value.result.reason}` };
    } catch { return null; }
}
