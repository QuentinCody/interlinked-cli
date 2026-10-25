// ===========================================
// Call coverage — which tool calls did the daemon actually judge?
// ===========================================
// The runner's transcript, normalized into `timeline.jsonl`, lists every tool call; the collection log holds a row
// for every call the daemon received. A call with no collection row was decided without the daemon: a cold fallback
// (no socket found, the daemon down or slow) or a hook that never ran. 2026-10-22: 135 of 734 calls of one session
// went unjudged because a stray `.interlinked/` below the project shadowed its root, and nothing showed it until the
// two logs were joined by tool_use_id. This module is that join. It reads the live logs only; a session whose hooks
// never reached the daemon may have no timeline rows at all, so a low call count is not proof of coverage.

import { createReadStream, existsSync } from "node:fs";
import { relative } from "node:path";
import { createInterface } from "node:readline";
import { getCollectionPath } from "../lib/collection/writer.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { timelinePath } from "./timeline-record-utils.js";

export interface CallCoverageQuery { root: string; since: string; session?: string; }
export interface SessionCallCoverage {
    session: string; provider: string; calls: number; judged: number;
    /** Unjudged calls by tool name, and by working folder relative to the project root. */
    byTool: Record<string, number>; byFolder: Record<string, number>;
    firstUnjudged: string | null; lastUnjudged: string | null;
}

interface Call { ts: string; session: string; provider: string; tool: string; cwd: string; }
const callKey = (session: string, id: string): string => JSON.stringify([session, id]);

async function* rows(path: string, marker: string, session?: string): AsyncGenerator<JsonObject> {
    if (!existsSync(path)) return;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
        if (!line.includes(marker) || (session && !line.includes(session))) continue;
        let row: unknown;
        try { row = JSON.parse(line); } catch { continue; } // a torn line is no evidence
        if (isJsonObject(row)) yield row;
    }
}

async function timelineCalls(query: CallCoverageQuery): Promise<Map<string, Call>> {
    const calls = new Map<string, Call>();
    for await (const row of rows(timelinePath(query.root), "\"category\":\"tool_use\"", query.session)) {
        if (row.category !== "tool_use" || typeof row.tool_use_id !== "string" || typeof row.ts !== "string" || row.ts < query.since) continue;
        if (query.session && row.session !== query.session) continue;
        calls.set(callKey(String(row.session ?? ""), row.tool_use_id), { ts: row.ts, session: String(row.session ?? ""), provider: String(row.provider ?? "unknown"),
            tool: String(row.tool_name ?? "unknown"), cwd: typeof row.cwd === "string" ? row.cwd : query.root });
    }
    return calls;
}

async function judgedIds(query: CallCoverageQuery): Promise<Set<string>> {
    const ids = new Set<string>();
    for await (const row of rows(getCollectionPath(query.root), "\"tool_use_id\"", query.session)) {
        if (query.session && row.session_id !== query.session) continue;
        if (row.kind === "tool_event" && typeof row.tool_use_id === "string") ids.add(callKey(String(row.session_id ?? ""), row.tool_use_id));
    }
    return ids;
}

function bump(counts: Record<string, number>, key: string): void { counts[key] = (counts[key] ?? 0) + 1; }

/** Per session, in first-call order: the calls in the window, how many the daemon received, and where the rest ran. */
export async function callCoverage(query: CallCoverageQuery): Promise<SessionCallCoverage[]> {
    const [calls, judged] = await Promise.all([timelineCalls(query), judgedIds(query)]);
    const sessions = new Map<string, SessionCallCoverage>();
    const ordered = [...calls].sort(([, a], [, b]) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const [id, call] of ordered) {
        const row = sessions.get(call.session) ?? { session: call.session, provider: call.provider, calls: 0, judged: 0, byTool: {}, byFolder: {}, firstUnjudged: null, lastUnjudged: null };
        sessions.set(call.session, row);
        row.calls++;
        if (judged.has(id)) { row.judged++; continue; }
        bump(row.byTool, call.tool);
        bump(row.byFolder, relative(query.root, call.cwd) || ".");
        row.firstUnjudged ??= call.ts;
        row.lastUnjudged = call.ts;
    }
    return [...sessions.values()];
}
