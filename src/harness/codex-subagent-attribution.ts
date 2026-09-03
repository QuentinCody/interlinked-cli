// ===========================================
// Codex subagent attribution — live hook events -> rollout identity
// ===========================================
// Codex currently emits collaboration-subagent hooks with the parent thread
// id and no actor/model fields. The adjacent rollout JSONL carries the missing
// identity, and completed tool items use the hook's same `exec-*` id. Correlate
// those local records without changing the parent session grouping.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { HarnessEvent } from "./types.js";

const DEFAULT_MAX_AGE_MS = 15 * 60_000;
const PENDING_MATCH_WINDOW_MS = 10_000;

interface CodexSubagentAttribution {
    subagent_id:string;
    agent_name: string;
    parent_agent: string | null;
    model: string | null;
}

interface PendingCall {
    name: string;
    input: string;
    timestampMs: number;
}

interface PendingAttributionMatch {
    parsed: ParsedAttributionRollout;
    call: PendingCall;
}

interface ParsedAttributionRollout {
    attribution:CodexSubagentAttribution | null;
    cwd: string | null;
    executionIds: Set<string>;
    pendingCalls: PendingCall[];
}

interface CachedRollout {
    size: number;
    mtimeMs: number;
    parsed: ParsedAttributionRollout;
}

interface CodexAttributionOptions {
    sessionsDir?: string;
    rolloutPaths?: string[];
    nowMs?: number;
    maxAgeMs?: number;
}

interface RolloutAccumulator {
    attribution: CodexSubagentAttribution | null;
    cwd: string | null;
    model: string | null;
    sessionMetaSeen: boolean;
    executionIds: Set<string>;
    pending: Map<string, PendingCall>;
}

const rolloutCache = new Map<string, CachedRollout>();

function stringField(value: JsonObject, key: string): string | null {
    const field = value[key];
    return typeof field === "string" && field ? field : null;
}

function nestedObject(value: JsonObject, key: string): JsonObject | null {
    const field = value[key];
    return isJsonObject(field) ? field : null;
}

function readSpawnMetadata(payload: JsonObject): CodexSubagentAttribution | null {
    const source = nestedObject(payload, "source");
    const subagent = source ? nestedObject(source, "subagent") : null;
    const spawn = subagent ? nestedObject(subagent, "thread_spawn") : null;
    if (!spawn) return null;
    const subagentId = stringField(payload, "id") ?? stringField(payload, "session_id");
    const taskPath = stringField(spawn, "agent_path");
    if (!subagentId || !taskPath) return null;
    return {
        subagent_id: subagentId,
        agent_name: taskPath,
        parent_agent: stringField(spawn, "parent_thread_id"),
        model: null,
    };
}

function recordResponseItem(
    entry: JsonObject,
    payload: JsonObject,
    pending: Map<string, PendingCall>,
): void {
    const type = stringField(payload, "type");
    const callId = stringField(payload, "call_id");
    if (!callId) return;
    if (type === "custom_tool_call_output" || type === "function_call_output") {
        pending.delete(callId);
        return;
    }
    if (type !== "custom_tool_call" && type !== "function_call") return;
    const name = stringField(payload, "name");
    const inputValue = payload.input ?? payload.arguments;
    const input = typeof inputValue === "string" ? inputValue : JSON.stringify(inputValue ?? {});
    const timestamp = stringField(entry, "timestamp");
    const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (name && Number.isFinite(timestampMs)) pending.set(callId, { name, input, timestampMs });
}

function consumeRolloutEntry(entry: JsonObject, acc: RolloutAccumulator): void {
    const payload = nestedObject(entry, "payload");
    if (!payload) return;
    const entryType = stringField(entry, "type");
    if (entryType === "session_meta" && !acc.sessionMetaSeen) {
        acc.sessionMetaSeen = true;
        acc.attribution = readSpawnMetadata(payload);
        acc.cwd = stringField(payload, "cwd");
    }
    if (entryType === "turn_context" || stringField(payload, "type") === "turn_context") {
        acc.model = stringField(payload, "model") ?? acc.model;
    }
    if (entryType === "event_msg") {
        const item = nestedObject(payload, "item");
        const id = item ? stringField(item, "id") : null;
        if (id) acc.executionIds.add(id);
    }
    if (entryType === "response_item") recordResponseItem(entry, payload, acc.pending);
}

/** Parse only rollout facts needed for live attribution. Malformed lines are
 * skipped; a root (non-subagent) rollout intentionally has null identity. */
export function parseCodexAttributionRollout(text: string): ParsedAttributionRollout {
    const acc: RolloutAccumulator = {
        attribution: null,
        cwd: null,
        model: null,
        sessionMetaSeen: false,
        executionIds: new Set<string>(),
        pending: new Map<string, PendingCall>(),
    };
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry: unknown = JSON.parse(line);
            if (isJsonObject(entry)) consumeRolloutEntry(entry, acc);
        } catch {
            continue;
        }
    }
    if (acc.attribution) acc.attribution.model = acc.model;
    return {
        attribution: acc.attribution,
        cwd: acc.cwd,
        executionIds: acc.executionIds,
        pendingCalls: [...acc.pending.values()],
    };
}

function dateDirectory(root: string, date: Date): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return join(root, year, month, day);
}

function recentRolloutPaths(root: string, nowMs: number, maxAgeMs: number): string[] {
    const directories = new Set([
        dateDirectory(root, new Date(nowMs)),
        dateDirectory(root, new Date(nowMs - 24 * 60 * 60_000)),
    ]);
    const paths: string[] = [];
    for (const directory of directories) {
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch {
            continue;
        }
        for (const name of names) {
            if (!/^rollout-.*\.jsonl$/.test(name)) continue;
            const path = join(directory, name);
            try {
                if (statSync(path).mtimeMs >= nowMs - maxAgeMs) paths.push(path);
            } catch {
                continue;
            }
        }
    }
    return paths;
}

function readRollout(path: string): ParsedAttributionRollout | null {
    try {
        const stat = statSync(path);
        const cached = rolloutCache.get(path);
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
            return cached.parsed;
        }
        const parsed = parseCodexAttributionRollout(readFileSync(path, "utf8"));
        rolloutCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
        return parsed;
    } catch {
        return null;
    }
}

function expectedCodexTool(toolName: string | undefined): string | null {
    if (!toolName) return null;
    return toolName === "Bash" ? "exec" : toolName.toLowerCase();
}

function inputNeedle(event: HarnessEvent): string | null {
    const input = event.tool_input;
    if (!input) return null;
    const candidate = input.command ?? input.patch ?? input.content;
    if (typeof candidate !== "string" || candidate.length < 4) return null;
    return JSON.stringify(candidate).slice(1, -1);
}

function pendingMatch(
    rollout: ParsedAttributionRollout,
    event: HarnessEvent,
    eventMs: number,
): PendingCall | null {
    const expectedTool = expectedCodexTool(event.tool_name);
    const needle = inputNeedle(event);
    const candidates = rollout.pendingCalls.filter((call) => {
        if (expectedTool && call.name.toLowerCase() !== expectedTool) return false;
        const age = eventMs - call.timestampMs;
        if (age < -1_000 || age > PENDING_MATCH_WINDOW_MS) return false;
        return needle === null || call.input.includes(needle);
    });
    return candidates.sort((a, b) => b.timestampMs - a.timestampMs)[0] ?? null;
}

function rememberPendingActor(
    matches: Map<string, PendingAttributionMatch>,
    parsed: ParsedAttributionRollout,
    call: PendingCall,
): void {
    const attribution = parsed.attribution;
    if (!attribution) return;
    const prior = matches.get(attribution.subagent_id);
    if (!prior || prior.call.timestampMs < call.timestampMs) {
        matches.set(attribution.subagent_id, { parsed, call });
    }
}

function uniquePendingAttribution(
    matches: Map<string, PendingAttributionMatch>,
): CodexSubagentAttribution | null {
    if (matches.size !== 1) return null;
    return matches.values().next().value?.parsed.attribution ?? null;
}

/** Process one rollout path against the event: returns the attribution on an
 * exact execution-id match, else records a pending-call candidate (if any)
 * and returns null so the caller's loop continues. */
function processRolloutPathForAttribution(
    path: string,
    event: HarnessEvent,
    eventMs: number,
    pendingByActor: Map<string, PendingAttributionMatch>,
): CodexSubagentAttribution | null {
    const parsed = readRollout(path);
    if (!parsed?.attribution || (parsed.cwd && event.cwd && parsed.cwd !== event.cwd)) return null;
    if (event.tool_use_id && parsed.executionIds.has(event.tool_use_id)) return parsed.attribution;
    const call = pendingMatch(parsed, event, eventMs);
    if (call) rememberPendingActor(pendingByActor, parsed, call);
    return null;
}

/** Resolve the acting Codex collaboration subagent. Exact execution-id
 * correlation wins; PreToolUse falls back to the matching pending call. */
export function resolveCodexSubagentAttribution(
    event: HarnessEvent,
    options: CodexAttributionOptions = {},
): CodexSubagentAttribution | null {
    if (event.agent_source !== "codex") return null;
    const eventMs = Date.parse(event.timestamp);
    if (!Number.isFinite(eventMs)) return null;
    const nowMs = options.nowMs ?? Date.now();
    const root = options.sessionsDir ?? join(homedir(), ".codex", "sessions");
    const paths = options.rolloutPaths
        ?? recentRolloutPaths(root, nowMs, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    const pendingByActor = new Map<string, PendingAttributionMatch>();
    for (const path of paths) {
        const attribution = processRolloutPathForAttribution(path, event, eventMs, pendingByActor);
        if (attribution) return attribution;
    }
    return uniquePendingAttribution(pendingByActor);
}

/** Fill missing fields only; native runner attribution remains authoritative. */
export function enrichCodexSubagentAttribution(
    event: HarnessEvent,
    options: CodexAttributionOptions = {},
): HarnessEvent {
    if (event.subagent_id && event.agent_name && event.model) return event;
    const attribution = resolveCodexSubagentAttribution(event, options);
    if (!attribution) return event;
	event.subagent_id ??= attribution.subagent_id;
	event.agent_name ??= attribution.agent_name;
	if (attribution.model) event.model ??= attribution.model;
	if (attribution.parent_agent) event.parent_agent ??= attribution.parent_agent;
	return event;
}
