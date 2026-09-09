import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { isJsonObject } from "../json-types.js";
import type { CoworkEvent, CoworkVerdict } from "./native.js";

export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

export function recordCoworkReceipt(path: string, event: CoworkEvent, verdict: CoworkVerdict, policyDigest: string): void {
    const row = { schema: 1, id: randomUUID(), at: new Date().toISOString(), provider: "cowork", event: event.event, tool: event.tool,
        sessionHash: digest(event.session), callHash: event.callId ? digest(event.callId) : null, inputHash: digest(JSON.stringify(event.input)),
        policyDigest, platform: process.platform, arch: process.arch, cwd: process.cwd(), declaredCwd: event.cwd,
        payloadKeys: Object.keys(event.raw).sort(), inputKeys: Object.keys(event.input).sort(),
        verdict: { decision: verdict.decision, checks: verdict.checks, unmeasured: verdict.unmeasured, probeControl: verdict.probeControl ?? null },
        enforcement: "unmeasured", execution: "unknown" };
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a", 0o600);
    try { appendFileSync(fd, `${JSON.stringify(row)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
}

/** Summarize receipts without upgrading a hook's emitted denial to effect proof. */
export function summarizeCoworkReceipts(text: string) {
    const events: Record<string, number> = Object.create(null), tools: Record<string, number> = Object.create(null), probeControls: Record<string, number> = Object.create(null);
    let records = 0, intendedDenials = 0;
    for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
        const row: unknown = JSON.parse(line);
        if (!isJsonObject(row) || row.schema !== 1 || row.provider !== "cowork" || typeof row.event !== "string" || typeof row.tool !== "string" || !isJsonObject(row.verdict)) throw new Error(`Invalid Cowork receipt at record ${records + 1}`);
        records++;
        events[row.event] = (events[row.event] ?? 0) + 1;
        tools[row.tool] = (tools[row.tool] ?? 0) + 1;
        if ([row.verdict.decision, row.verdict.probeControl].includes("deny")) intendedDenials++;
        countControl(probeControls, row.verdict.probeControl);
    }
    return { records, events, tools, intendedDenials, probeControls, enforcement: "unmeasured", note: "Receipts precede output: an intended decision does not prove emission or prevention. Independent effects and positive controls are required." };
}

function countControl(counts: Record<string, number>, control: unknown): void {
    if (typeof control === "string") counts[control] = (counts[control] ?? 0) + 1;
}
