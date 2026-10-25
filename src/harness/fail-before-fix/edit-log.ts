// ===========================================
// fail-before-fix — applied edits from the harness collection log
// ===========================================
// Reads post-phase Write / Edit / MultiEdit / apply_patch rows from `.interlinked/collection.jsonl` (and, on
// request, the rotated `archive/collection-*.jsonl.gz` segments). A row counts only when it was applied (post phase,
// no error outcome). The collector stores an apply_patch call as ONE raw V4A envelope under one path, also when
// the patch touches several files, so envelopes are split here into one event per file section.
// A call that runs while the daemon is stalled gets the hook client's cold-fallback allow and leaves NO collection
// row (2026-10-22: two Writes in one session, one beside a daemon emergency GC). The transcript-derived
// `timeline.jsonl` still holds its input and result, so a Write / Edit / MultiEdit fills that gap when no collection
// post row carries its tool_use_id and its tool_result reports success; the replay's byte check still decides.

import { createReadStream, existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { getCollectionPath } from "../../lib/collection/writer.js";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { looksLikeApplyPatch, parseApplyPatchSections } from "../apply-patch-content.js";
import { timelinePath } from "../timeline-record-utils.js";
import type { EditEvent } from "./replay.js";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "apply_patch"]);
const TIMELINE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export interface EditLogQuery { root: string; archives: boolean; session?: string; paths?: ReadonlySet<string>; since?: string; }

/** The live log plus, on request, its rotated `archive/<name>-NNNN.jsonl.gz` segments (oldest first). */
function logFiles(live: string, name: "collection" | "timeline", archives: boolean): string[] {
    const archive = join(dirname(live), "archive"), segment = new RegExp(`^${name}-\\d+\\.jsonl\\.gz$`);
    const rotated = archives && existsSync(archive)
        ? readdirSync(archive).filter(file => segment.test(file)).sort().map(file => join(archive, file))
        : [];
    return [...rotated, ...(existsSync(live) ? [live] : [])];
}

async function* lines(path: string): AsyncGenerator<string> {
    const raw = createReadStream(path);
    const input = path.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    for await (const line of createInterface({ input, crlfDelay: Infinity })) yield line;
}

function projectPath(root: string, path: string, cwd: string): string | null {
    const full = normalize(isAbsolute(path) ? path : join(cwd, path));
    const rel = relative(root, full);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
}

function applied(row: JsonObject): boolean {
    if (row.kind !== "tool_event" || row.phase !== "post" || row.outcome === "error") return false;
    return !isJsonObject(row.observation) || row.observation.applied !== false;
}

function eventsOf(root: string, row: JsonObject): EditEvent[] {
    const action = isJsonObject(row.action) ? row.action : {}, cwd = typeof row.cwd === "string" ? row.cwd : root;
    const base = { ts: String(row.ts ?? ""), seq: typeof row.seq === "number" ? row.seq : 0, session: String(row.session_id ?? "") };
    const hunks = (isJsonObject(action.diff) && Array.isArray(action.diff.hunks) ? action.diff.hunks : [])
        .filter(isJsonObject).map(hunk => ({ old: String(hunk.old ?? ""), new: String(hunk.new ?? "") }));
    const raw = hunks.find(hunk => hunk.old === "" && looksLikeApplyPatch(hunk.new));
    if (row.provider_tool === "apply_patch" && raw) {
        return parseApplyPatchSections(raw.new).flatMap(section => {
            const path = projectPath(root, section.path, cwd);
            return path ? [{ ...base, kind: "patch" as const, path, section }] : [];
        });
    }
    const path = typeof action.path === "string" ? projectPath(root, action.path, cwd) : null;
    if (!path) return [];
    if (row.provider_tool === "Write") return typeof action.content === "string" ? [{ ...base, kind: "write", path, content: action.content }] : [];
    return [{ ...base, kind: "hunks", path, hunks }];
}

function parseRow(line: string): JsonObject | null {
    try {
        const row: unknown = JSON.parse(line);
        return isJsonObject(row) ? row : null;
    } catch { return null; }
}

/** `recorded` collects the tool_use_id of every post-phase edit row, applied or not: the timeline never refills those. */
function lineEvents(query: EditLogQuery, line: string, recorded: Set<string>): EditEvent[] {
    if (!line.includes("\"tool_event\"") || (query.session && !line.includes(query.session))) return [];
    const row = parseRow(line);
    if (!row || !EDIT_TOOLS.has(String(row.provider_tool))) return [];
    if (row.phase === "post" && typeof row.tool_use_id === "string") recorded.add(row.tool_use_id);
    if (!applied(row)) return [];
    if ((query.session && row.session_id !== query.session) || (query.since && String(row.ts ?? "") < query.since)) return [];
    return eventsOf(query.root, row).filter(event => !query.paths || query.paths.has(event.path));
}

interface TimelineCall { ts: string; session: string; cwd: string; tool: string; input: JsonObject; }

function timelineEvents(root: string, call: TimelineCall): EditEvent[] {
    const path = typeof call.input.file_path === "string" ? projectPath(root, call.input.file_path, call.cwd) : null;
    if (!path) return [];
    const base = { ts: call.ts, seq: 0, session: call.session, path, source: "timeline" as const };
    if (call.tool === "Write") return typeof call.input.content === "string" ? [{ ...base, kind: "write", content: call.input.content }] : [];
    const edits = call.tool === "MultiEdit" ? (Array.isArray(call.input.edits) ? call.input.edits.filter(isJsonObject) : []) : [call.input];
    return [{ ...base, kind: "hunks", hunks: edits.map(edit => ({ old: String(edit.old_string ?? ""), new: String(edit.new_string ?? "") })) }];
}

function timelineCall(query: EditLogQuery, row: JsonObject): TimelineCall | null {
    if (!TIMELINE_EDIT_TOOLS.has(String(row.tool_name)) || !isJsonObject(row.tool_input)) return null;
    if ((query.session && row.session !== query.session) || (query.since && String(row.ts ?? "") < query.since)) return null;
    return { ts: String(row.ts ?? ""), session: String(row.session ?? ""), cwd: typeof row.cwd === "string" ? row.cwd : query.root, tool: String(row.tool_name), input: row.tool_input };
}

/** Edit calls and successful results seen so far, keyed by tool_use_id. */
interface TimelineScan { calls: Map<string, TimelineCall>; succeeded: Set<string>; }

function scanTimelineLine(query: EditLogQuery, line: string, recorded: ReadonlySet<string>, scan: TimelineScan): void {
    if (!line.includes("\"category\":\"tool_") || (query.session && !line.includes(query.session))) return;
    const row = parseRow(line);
    if (!row || typeof row.tool_use_id !== "string" || recorded.has(row.tool_use_id)) return;
    if (row.category === "tool_result" && row.is_error === false) scan.succeeded.add(row.tool_use_id);
    const call = row.category === "tool_use" ? timelineCall(query, row) : null;
    if (call) scan.calls.set(row.tool_use_id, call);
}

/** Applied edit calls that no collection post row recorded, from the transcript-derived timeline. */
async function timelineGaps(query: EditLogQuery, recorded: ReadonlySet<string>): Promise<EditEvent[]> {
    const scan: TimelineScan = { calls: new Map(), succeeded: new Set() };
    for (const file of logFiles(timelinePath(query.root), "timeline", query.archives)) {
        for await (const line of lines(file)) scanTimelineLine(query, line, recorded, scan);
    }
    return [...scan.calls].filter(([id]) => scan.succeeded.has(id)).flatMap(([, call]) => timelineEvents(query.root, call))
        .filter(event => !query.paths || query.paths.has(event.path));
}

/** Code-point order (never locale order): ISO timestamps, then the log sequence, then file order. */
function byTime(a: { event: EditEvent; order: number }, b: { event: EditEvent; order: number }): number {
    if (a.event.ts !== b.event.ts) return a.event.ts < b.event.ts ? -1 : 1;
    return a.event.seq - b.event.seq || a.order - b.order;
}

/** Applied edit events in log order (archives first), plus the timeline's gap fills. Filters by session,
 *  project-relative path and start time. */
export async function readEditEvents(query: EditLogQuery): Promise<EditEvent[]> {
    const out: EditEvent[] = [], recorded = new Set<string>();
    for (const file of logFiles(getCollectionPath(query.root), "collection", query.archives)) {
        for await (const line of lines(file)) out.push(...lineEvents(query, line, recorded));
    }
    out.push(...await timelineGaps(query, recorded));
    return out.map((event, order) => ({ event, order })).sort(byTime).map(row => row.event);
}

/** The session of the most recent applied edit in the live log, or null. */
export async function latestEditSession(root: string): Promise<string | null> {
    const events = await readEditEvents({ root, archives: false });
    return events.at(-1)?.session ?? null;
}
