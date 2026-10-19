import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { isInsideRoot } from "../large-file-policy.js";
import type { HarnessEvent } from "../types.js";

export interface TscDeferredEntry {
    path: string;
    tool_use_id: string;
    p: number;
    at: string;
    seq: number;
}

export interface TscDeferredSet {
    seq: number;
    entries: TscDeferredEntry[];
    blocking: string[];
}

export function tscSchedulerStorePath(cwd: string, event: Pick<HarnessEvent, "agent_source" | "session_id" | "subagent_id">): string {
    // Preserve the original root-session key; new child work belongs to its actor.
    const actor = `${event.agent_source}\0${event.session_id ?? ""}${event.subagent_id ? `\0${event.subagent_id}` : ""}`;
    return join(cwd, ".interlinked", "tsc-scheduler", `${createHash("sha256").update(actor).digest("hex")}.json`);
}

function isEntry(value: unknown): value is TscDeferredEntry {
    return isJsonObject(value) && typeof value.path === "string" && typeof value.tool_use_id === "string"
        && typeof value.p === "number" && Number.isFinite(value.p) && value.p >= 0 && value.p <= 1
        && typeof value.at === "string" && typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq > 0;
}

/** Keep corrupt state in place: a second boundary or daemon restart must still refuse it. */
export function readTscStore(cwd: string, store: string): TscDeferredSet {
    if (!existsSync(store)) return { seq: 0, entries: [], blocking: [] };
    const value: unknown = JSON.parse(readFileSync(store, "utf8"));
    if (!isJsonObject(value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0
        || !Array.isArray(value.entries) || !value.entries.every(isEntry)) throw new Error("invalid tsc scheduler deferred set");
    const blocking = value.blocking ?? [];
    const seq = value.seq;
    if (!Array.isArray(blocking) || !blocking.every(item => typeof item === "string")) throw new Error("invalid tsc scheduler findings");
    if (value.entries.some(entry => entry.seq > seq || !isInsideRoot(cwd, entry.path))) throw new Error("invalid tsc scheduler target or sequence");
    if (blocking.length && !value.entries.length) throw new Error("tsc scheduler findings have no retained targets");
    return { seq: value.seq, entries: value.entries, blocking };
}

function writeStore(store: string, set: TscDeferredSet): void {
    mkdirSync(dirname(store), { recursive: true });
    const temporary = `${store}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(set), { mode: 0o600 });
    renameSync(temporary, store);
}

export function readTscDeferred(cwd: string, event: HarnessEvent): TscDeferredSet {
    return readTscStore(cwd, tscSchedulerStorePath(cwd, event));
}

export function addTscDeferred(cwd: string, event: HarnessEvent, path: string, p: number): void {
    const store = tscSchedulerStorePath(cwd, event);
    const current = readTscStore(cwd, store);
    const seq = current.seq + 1;
    const entry: TscDeferredEntry = { path, tool_use_id: event.tool_use_id ?? "", p, at: event.timestamp, seq };
    writeStore(store, { ...current, seq, entries: [...current.entries.filter(item => item.path !== path), entry] });
}

/** Errors and edits arriving during a drain retain their obligations and diagnostics. */
export function finishTscDrain(cwd: string, store: string, checked: TscDeferredSet, blocking: string[], unavailable: boolean): boolean {
    const current = readTscStore(cwd, store);
    const changed = current.seq !== checked.seq;
    const outstanding = changed || unavailable ? [...new Set([...current.blocking, ...blocking])] : blocking;
    const entries = outstanding.length || unavailable ? current.entries : current.entries.filter(entry => entry.seq > checked.seq);
    writeStore(store, { seq: current.seq, entries, blocking: outstanding });
    return entries.length === 0;
}
