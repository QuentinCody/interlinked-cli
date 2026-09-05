import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { dataTimestampMs } from "../data-time.js";
import { isJsonObject, type JsonObject } from "../json-types.js";
import type { DataSource } from "./catalog-types.js";

const TEXT_LIMIT = 32 * 1024;
const FIELD_LIMIT = 2048;
const DEPTH_LIMIT = 8;

export interface DataFieldShape { path: string; type: string; }
export interface DataCheckEvidence { id: string; status: string; severity: string | null; }
export interface NormalizedDataRecord {
    id: string; rawHash: string; source: string; category: string; role: string;
    schema: string | null; eventMs: number | null;
    session: string | null; actor: string | null; parentActor: string | null;
    provider: string | null; model: string | null; callId: string | null;
    kind: string | null; phase: string | null; tool: string | null; decision: string | null;
    origin: string; text: string; textTruncated: boolean;
    files: string[]; checks: DataCheckEvidence[]; fields: DataFieldShape[];
    inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
    summary: JsonObject;
}

export function firstDataString(record: JsonObject, fields: readonly string[]): string | null {
    for (const field of fields) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
}

export function dataRecordHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function fieldType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

interface FieldVisit { path: string; value: unknown; depth: number; }
function childFields(node: FieldVisit): FieldVisit[] {
    if (node.depth >= DEPTH_LIMIT) return [];
    if (Array.isArray(node.value)) return node.value.slice(0, FIELD_LIMIT).map((value) => ({ path: `${node.path}[]`, value, depth: node.depth + 1 }));
    if (!isJsonObject(node.value)) return [];
    return Object.entries(node.value).slice(0, FIELD_LIMIT).map(([key, value]) => ({ path: node.path ? `${node.path}.${key}` : key, value, depth: node.depth + 1 }));
}

function omittedChildren(node: FieldVisit): boolean {
    const count = Array.isArray(node.value) ? node.value.length : isJsonObject(node.value) ? Object.keys(node.value).length : 0;
    return count > FIELD_LIMIT || (node.depth >= DEPTH_LIMIT && count > 0);
}

function describeFields(record: JsonObject): { fields: DataFieldShape[]; text: string; truncated: boolean } {
    const pending: FieldVisit[] = [{ path: "", value: record, depth: 0 }];
    const shapes = new Map<string, DataFieldShape>();
    const text: string[] = [];
    let remaining = TEXT_LIMIT;
    let visits = 0;
    let truncated = false;
    while (pending.length > 0 && visits++ < FIELD_LIMIT) {
        const node = pending.pop();
        if (!node) break;
        const type = fieldType(node.value);
        truncated ||= omittedChildren(node);
        if (node.path) shapes.set(`${node.path}:${type}`, { path: node.path, type });
        if (typeof node.value === "string") {
            text.push(node.value.slice(0, remaining));
            truncated ||= node.value.length > remaining;
            remaining = Math.max(0, remaining - node.value.length);
        }
        pending.push(...childFields(node));
    }
    return { fields: [...shapes.values()], text: text.join("\n"), truncated: truncated || pending.length > 0 };
}

function relatedFiles(record: JsonObject, cwd: string): string[] {
    const values: unknown[] = [record.file, record.file_path, record.path];
    for (const key of ["action", "tool_input"]) {
        const value = record[key];
        if (isJsonObject(value)) values.push(value.path, value.file_path);
    }
    if (Array.isArray(record.files_modified)) values.push(...record.files_modified);
    if (Array.isArray(record.checks)) for (const check of record.checks) if (isJsonObject(check)) values.push(check.file);
    return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)
        .map((path) => (isAbsolute(path) ? relative(cwd, path) : path).replace(/\\/g, "/")))];
}

function checkEvidence(record: JsonObject): DataCheckEvidence[] {
    const checks: DataCheckEvidence[] = [];
    const entries = Array.isArray(record.execution) ? record.execution : record.checks;
    if (Array.isArray(entries)) {
        for (const check of entries) {
            if (!isJsonObject(check)) continue;
            const id = firstDataString(check, ["id", "name"]);
            if (id) checks.push({ id, status: firstDataString(check, ["status"]) ?? "finding", severity: firstDataString(check, ["severity"]) });
        }
    }
    const id = firstDataString(record, ["check_id", "check", "check_name"]);
    if (id) checks.push({ id, status: firstDataString(record, ["outcome", "status"]) ?? "observed", severity: firstDataString(record, ["severity"]) });
    return checks;
}

function tokenValue(record: JsonObject, key: string): number | null {
    const usage = isJsonObject(record.usage) ? record.usage : record;
    const aliases: Record<string, string> = { input_tokens: "input", output_tokens: "output", cache_read_input_tokens: "cache_read" };
    const value = usage[key] ?? usage[aliases[key] ?? key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function evidenceOrigin(record: JsonObject): string {
    const capture = isJsonObject(record.capture) ? record.capture : record;
    const origin = firstDataString(capture, ["origin", "environment"]);
    return origin && ["production", "test", "probe", "imported"].includes(origin) ? origin : "unknown";
}

function projectedSummary(record: JsonObject): JsonObject {
    return { summary: firstDataString(record, ["summary", "message", "text", "reason"])?.slice(0, 2000) ?? null,
        score: typeof record.score === "number" ? record.score : null,
        shown: typeof record.shown === "boolean" ? record.shown : null,
        suppressed: typeof record.suppressed === "boolean" ? record.suppressed : null };
}

function capturedIdentity(record: JsonObject, fields: readonly string[], fallback: string): string | null {
    const capture = isJsonObject(record.capture) ? record.capture : {};
    return firstDataString(record, fields) ?? firstDataString(capture, [fallback]);
}

function dataProvider(record: JsonObject): string | null {
    const provider = capturedIdentity(record, ["provider", "agent_source"], "provider");
    return provider === "claude-code" ? "claude" : provider;
}

/** Raw bytes remain in source files; this is a bounded, explicitly lossy search projection. */
export function normalizeDataRecord(record: JsonObject, source: DataSource, raw: string, cwd: string): NormalizedDataRecord {
    const described = describeFields(record);
    const rawHash = dataRecordHash(raw);
    return {
        id: dataRecordHash(`${source.name}\0${rawHash}`), rawHash,
        source: source.name, category: source.category, role: source.role,
        schema: firstDataString(record, ["schema"]) ?? (typeof record.schema_version === "number" ? String(record.schema_version) : null),
        eventMs: dataTimestampMs(record, source.timestamps) ?? null,
        session: capturedIdentity(record, source.sessionFields, "session"), actor: capturedIdentity(record, source.actorFields, "actor"),
        parentActor: firstDataString(record, ["parent_agent", "parent_session_id"]),
        provider: dataProvider(record), model: firstDataString(record, ["model"]),
        callId: firstDataString(record, source.callFields), kind: firstDataString(record, ["kind", "type", "category", "event", "op"]),
        phase: firstDataString(record, ["phase", "hook", "hook_event"]), tool: firstDataString(record, ["tool", "provider_tool", "tool_name"]),
        decision: firstDataString(record, ["actual_decision", "guard_decision", "decision", "outcome", "tool_outcome", "status"]),
        origin: evidenceOrigin(record), text: described.text, textTruncated: described.truncated,
        files: relatedFiles(record, cwd), checks: checkEvidence(record), fields: described.fields,
        inputTokens: tokenValue(record, "input_tokens"), outputTokens: tokenValue(record, "output_tokens"),
        cacheReadTokens: tokenValue(record, "cache_read_input_tokens"),
        summary: projectedSummary(record),
    };
}
