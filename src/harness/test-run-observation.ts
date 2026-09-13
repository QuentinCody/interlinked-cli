import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { TestExecution } from "./test-run-receipt.js";

/** Observation, not a liveness claim: a crashed owner can leave a running row. */
export interface TestRunObservation {
    runId: string; pid: number; observedAt: string; status: string;
    snapshot: string; tests: string[]; reused: boolean;
}

export function observeTestRun(root: string, result: TestExecution, status: TestExecution["status"] | "running" = result.status): void {
    const directory = join(root, ".interlinked/test-runs"), path = join(directory, "latest.json");
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const record: TestRunObservation = { runId: result.runId, pid: process.pid, observedAt: new Date().toISOString(),
        status, snapshot: result.plan.snapshot, tests: result.plan.tests.map(test => test.path), reused: result.reused };
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, path);
}

export function readTestRunObservation(root: string): TestRunObservation | null {
    try {
        const value: unknown = JSON.parse(readFileSync(join(root, ".interlinked/test-runs/latest.json"), "utf8"));
        if (!isJsonObject(value) || !validFields(value)) return null;
        return value;
    } catch { return null; }
}

function validFields(value: Record<string, unknown>): value is Record<string, unknown> & TestRunObservation {
    return typeof value.runId === "string" && typeof value.pid === "number" && Number.isSafeInteger(value.pid)
        && typeof value.observedAt === "string" && typeof value.status === "string" && typeof value.snapshot === "string"
        && typeof value.reused === "boolean" && Array.isArray(value.tests) && value.tests.every(test => typeof test === "string");
}
