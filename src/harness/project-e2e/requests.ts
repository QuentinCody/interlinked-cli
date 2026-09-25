// ===========================================
// Durable run requests — append-only, served by exact key + generation
// ===========================================
// Plan 31 §8 (attribution) / Unit C4. A request records that some session
// wants evidence for one obligation at one generation. It survives daemon
// restarts (JSONL under .interlinked), is deduplicated by (key, generation),
// and is SERVED only by a run whose receipt certifies that exact pair — a
// run for another scenario or an older generation leaves it open (PE-13).
// Two sessions asking for the same current scope share one qualifying run;
// the receipt lists both request ids and the actual initiator (PE-12).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const E2E_REQUESTS_PATH = ".interlinked/e2e-requests.jsonl";
const MAX_REQUESTS_BYTES = 16 * 1024 * 1024;
const GENERATION = /^[a-f0-9]{64}$/;
export type RequestTxn =
    | { op: "open"; id: string; key: string; generation: string; atMs: number; sessionId?: string }
    | { op: "served"; id: string; runId: string; atMs: number };
export interface OpenRequest { key: string; generation: string; sessionId?: string; atMs: number; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Strict row parser; a malformed row is skipped, never guessed at. */
export function parseRequestTxn(value: unknown): RequestTxn | null {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id || typeof value.atMs !== "number" || !Number.isInteger(value.atMs)) return null;
    if (value.op === "served") return typeof value.runId === "string" ? { op: "served", id: value.id, runId: value.runId, atMs: value.atMs } : null;
    if (value.op !== "open" || typeof value.key !== "string" || !value.key || typeof value.generation !== "string" || !GENERATION.test(value.generation)) return null;
    if (value.sessionId !== undefined && typeof value.sessionId !== "string") return null;
    return { op: "open", id: value.id, key: value.key, generation: value.generation, atMs: value.atMs, ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }) };
}
export function readRequestTxns(root: string): RequestTxn[] {
    const path = join(root, E2E_REQUESTS_PATH);
    if (!existsSync(path)) return [];
    let content = readFileSync(path, "utf8");
    if (Buffer.byteLength(content) > MAX_REQUESTS_BYTES) content = content.slice(content.indexOf("\n", content.length - MAX_REQUESTS_BYTES) + 1);
    const rows: RequestTxn[] = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const txn = parseRequestTxn(parsed);
        if (txn) rows.push(txn);
    }
    return rows;
}
function appendRequestTxn(root: string, txn: RequestTxn): void {
    const path = join(root, E2E_REQUESTS_PATH);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(txn)}\n`);
}
/** Deterministic reduction: open rows minus served rows; a served row for an unknown id is ignored. */
export function openRequests(root: string): Map<string, OpenRequest> {
    const open = new Map<string, OpenRequest>();
    for (const txn of readRequestTxns(root)) {
        if (txn.op === "open") open.set(txn.id, { key: txn.key, generation: txn.generation, atMs: txn.atMs, ...(txn.sessionId === undefined ? {} : { sessionId: txn.sessionId }) });
        else open.delete(txn.id);
    }
    return open;
}
/** Idempotent per (key, generation, session): the same session asking again gets its existing id; ANOTHER session gets its own request, so a shared run can attribute both (PE-12). */
export function openRequest(root: string, input: { key: string; generation: string; sessionId?: string; atMs: number; dryRun?: boolean }): string {
    for (const [id, row] of openRequests(root)) if (row.key === input.key && row.generation === input.generation && row.sessionId === input.sessionId) return id;
    const id = randomUUID();
    if (!input.dryRun) appendRequestTxn(root, { op: "open", id, key: input.key, generation: input.generation, atMs: input.atMs, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) });
    return id;
}
/** Requests this run's receipt certifies: exact key AND generation. Returns the served ids (for `receipt.requestIds`). */
export function matchingRequests(root: string, certified: Record<string, string>): string[] {
    return [...openRequests(root)].filter(([, row]) => certified[row.key] === row.generation).map(([id]) => id).sort();
}
/**
 * Serves EXACTLY the ids the published receipt records (review round 2, D1): a request that arrived after the
 * attribution set was frozen stays open — it is never closed against evidence that omits its identity.
 * Ids that are unknown or already served are ignored; the served ids are returned.
 */
export function serveRequests(root: string, runId: string, requestIds: readonly string[], atMs: number): string[] {
    const open = openRequests(root);
    const served = requestIds.filter(id => open.has(id)).sort();
    for (const id of served) appendRequestTxn(root, { op: "served", id, runId, atMs });
    return served;
}
