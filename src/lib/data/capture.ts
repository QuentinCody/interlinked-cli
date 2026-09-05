import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../config.js";
import { appendFileWithMutationLock } from "../file-mutation-lock.js";
import { DATA_CATALOG } from "./catalog.js";
import { assertCaptureIsolation } from "./capture-isolation.js";

export type CaptureOrigin = "production" | "test" | "probe" | "imported" | "unknown";
export interface CaptureContext {
    dataDir?: string;
    cwd: string; producer: string; origin?: CaptureOrigin; session?: string;
    provider?: string; capabilities?: Record<string, string>;
}
export interface CaptureReceipt {
    source: string; status: "written" | "failed" | "unsupported" | "disabled" | "idle";
    records?: number; bytes?: number; error?: string; trigger?: string;
}
const reportedFailures = new Set<string>();

export function captureOrigin(): CaptureOrigin {
    const explicit = process.env.INTERLINKED_CAPTURE_ORIGIN;
    if (explicit === "test" || explicit === "probe" || explicit === "imported") return explicit;
    if (process.env.VITEST === "true") return "test";
    return "production";
}

export function captureEnvelope(context: CaptureContext): object {
    return { version: 1, event_id: randomUUID(), ingested_at: new Date().toISOString(),
        producer: context.producer, origin: context.origin ?? captureOrigin(),
        session: context.session ?? null, provider: context.provider ?? null,
        capabilities: context.capabilities ?? {}, redaction: "producer-policy" };
}

function writeCaptureLine(context: CaptureContext, path: string, record: object): number {
    const target = join(context.dataDir ?? getDataDir(context.cwd), path);
    assertCaptureIsolation(target);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(record)}\n`;
    appendFileWithMutationLock(target, body, { waitMs: 0 });
    return Buffer.byteLength(body);
}

/** Receipt failure is surfaced once per source/process; it never recurses. */
export function recordCaptureReceipt(context: CaptureContext, receipt: CaptureReceipt): void {
    try {
        writeCaptureLine(context, "capture-receipts.jsonl", {
            schema: "capture-receipt.v1", ts: new Date().toISOString(), ...receipt,
            trigger: receipt.trigger ?? DATA_CATALOG.find((source) => source.name === receipt.source)?.trigger ?? "producer invocation",
            producer: context.producer, session: context.session ?? null,
            capture: captureEnvelope(context),
        });
    } catch {
        if (reportedFailures.has(receipt.source)) return;
        reportedFailures.add(receipt.source);
        process.stderr.write(`[interlinked:capture] unable to record ${receipt.source} capture health\n`);
    }
}

/** Additive provenance with observable failures. Raw producer fields are retained. */
export function appendCapturedData(context: CaptureContext, source: string, records: readonly object[]): boolean {
    assertCaptureIsolation(context.dataDir ?? getDataDir(context.cwd));
    const entry = DATA_CATALOG.find((item) => item.name === source);
    if (!entry) throw new Error(`unregistered capture source: ${source}`);
    if (records.length === 0) return true;
    let written = 0;
    let bytes = 0;
    try {
        for (const record of records) {
            bytes += writeCaptureLine(context, entry.path, { ...record, capture: captureEnvelope(context) });
            written++;
        }
        recordCaptureReceipt(context, { source, status: "written", records: written, bytes });
        return true;
    } catch (error) {
        // Filesystem codes convey failure without copying payloads or secret-bearing messages.
        const code = error instanceof Error && "code" in error ? String(error.code) : "write-error";
        recordCaptureReceipt(context, { source, status: "failed", records: written, bytes, error: code });
        return false;
    }
}
