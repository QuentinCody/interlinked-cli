import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { TestPlan } from "./test-plan.js";

export interface TestExecution {
    status: "passed" | "failed" | "deferred" | "stale" | "empty";
    plan: TestPlan;
    runId: string;
    reused: boolean;
    durationMs: number;
    reason: string;
    output: string;
    runtimeVerified?: boolean;
    shared?: boolean;
}
interface PassedReceipt { key: string; runId: string; durationMs: number; }

export function readTestReceipt(root: string, key: string): PassedReceipt | null {
    try {
        const data: unknown = JSON.parse(readFileSync(join(root, ".interlinked/test-runs", `${key}.json`), "utf8"));
        if (!isJsonObject(data) || data.version !== 1 || data.key !== key || data.status !== "passed" || typeof data.runId !== "string" ||
            typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0) return null;
        return { key, runId: data.runId, durationMs: data.durationMs };
    } catch { return null; }
}

export function writeTestReceipt(root: string, key: string, result: TestExecution): void {
    const directory = join(root, ".interlinked/test-runs");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${key}.json`), temporary = `${path}.${result.runId}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, key, status: result.status, runId: result.runId, durationMs: result.durationMs }), { mode: 0o600 });
    renameSync(temporary, path);
}
