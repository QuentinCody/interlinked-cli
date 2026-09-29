import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { ToolchainIdentity } from "./check-identity.js";
import type { TestPlan } from "./test-plan.js";

/** A file the run produced that a consumer may take instead of re-running (a coverage summary); `path` is relative to the receipt store. */
export interface RunArtifact { path: string; sha256: string; }
export type RunArtifacts = Record<string, RunArtifact>;

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
    /** Artifacts of the run this result certifies (the prior run's when reused). */
    artifacts?: RunArtifacts;
    /**
     * The absolute receipt store the artifact paths resolve against — the PRODUCING drain's store, which a
     * subscriber sharing the run may not own (two callers with different stores can share one batch).
     */
    artifactStore?: string;
    /** Checkout whose absolute paths appear inside the artifacts, independent of the optional scope reporter. */
    artifactRoot?: string;
}
/** Facts about the run a receipt certifies, beyond its key; a receipt is unsigned and local (cross-machine trust is Unit 9). */
export interface ReceiptDetails {
    /** The check identity (`check-identity.ts`); today the receipt key IS the identity. */
    identity: string;
    platform: string;
    toolchain: ToolchainIdentity;
    stages: { exec_ms: number; post_ms: number };
    artifacts?: RunArtifacts;
    artifactRoot?: string;
}

function isArtifacts(value: unknown): value is RunArtifacts {
    return isJsonObject(value) && Object.values(value).every(entry => isJsonObject(entry) && typeof entry.path === "string" && /^[0-9a-f]{64}$/.test(String(entry.sha256)));
}
export interface PassedReceipt extends ReceiptDetails { key: string; runId: string; durationMs: number; }
const RECEIPT_VERSION = 2;

function isToolchain(value: unknown): value is ToolchainIdentity {
    return isJsonObject(value) && typeof value.node === "string" && (value.vitest === null || typeof value.vitest === "string") && (value.typescript === null || typeof value.typescript === "string");
}

function isStages(value: unknown): value is ReceiptDetails["stages"] {
    return isJsonObject(value) && typeof value.exec_ms === "number" && typeof value.post_ms === "number";
}

/** The v2 receipt header for exactly this key: a passed run with a finite, non-negative duration. */
function receiptHeader(data: Record<string, unknown>, key: string): { runId: string; durationMs: number } | null {
    if (data.version !== RECEIPT_VERSION || data.key !== key || data.status !== "passed" || typeof data.runId !== "string") return null;
    if (typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0) return null;
    return { runId: data.runId, durationMs: data.durationMs };
}

/** The identity, platform, toolchain, stages and optional artifacts block; any malformed field rejects the whole receipt. */
function receiptDetails(data: Record<string, unknown>): ReceiptDetails | null {
    if (typeof data.identity !== "string" || typeof data.platform !== "string" || !isToolchain(data.toolchain) || !isStages(data.stages)) return null;
    const details: ReceiptDetails = { identity: data.identity, platform: data.platform, toolchain: data.toolchain, stages: data.stages };
    if (data.artifacts === undefined) return details;
    if (!isArtifacts(data.artifacts) || typeof data.artifactRoot !== "string" || !data.artifactRoot) return null;
    details.artifacts = data.artifacts;
    details.artifactRoot = data.artifactRoot;
    return details;
}

/** Where receipts and run directories live: the project's own store unless the caller points at another (the pre-push export reads the source checkout's). */
export function receiptStorePath(root: string, store?: string): string {
    return store ?? join(root, ".interlinked/test-runs");
}

/** A v2 receipt for exactly this key, or null: an older version, a foreign platform or any malformed field is no receipt. */
export function readTestReceipt(root: string, key: string, store?: string): PassedReceipt | null {
    try {
        const data: unknown = JSON.parse(readFileSync(join(receiptStorePath(root, store), `${key}.json`), "utf8"));
        if (!isJsonObject(data)) return null;
        const header = receiptHeader(data, key), details = receiptDetails(data);
        return header && details ? { key, ...header, ...details } : null;
    } catch { return null; }
}

export function writeTestReceipt(root: string, key: string, result: TestExecution, details: ReceiptDetails, store?: string): void {
    const directory = receiptStorePath(root, store);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${key}.json`), temporary = `${path}.${result.runId}.tmp`;
    const receipt = { version: RECEIPT_VERSION, key, status: result.status, runId: result.runId, durationMs: result.durationMs, ...details };
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, path);
}
