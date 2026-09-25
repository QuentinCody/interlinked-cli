// ===========================================
// Reviewed policy-change records (Unit F3, plan §13)
// ===========================================
// A legitimate requirement change is RECORDED, never inferred: the replaced
// scenario (or the whole project), the rationale, an optional source, and the
// exact base and head policy digests. A record discharges a weakening finding
// only for those two digests, so a later edit needs a new review. Append-only
// JSONL; a malformed row is skipped and reported, never repaired.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { E2eSourceRef } from "./policy.js";

export const E2E_POLICY_CHANGES_PATH = ".interlinked/e2e-policy-changes.jsonl";
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ROWS = 10_000;
const SOURCE_KINDS = ["requirement", "example", "regression", "conversation", "inferred"] as const;

export interface PolicyChangeRecord {
    version: 1; kind: "replacement"; projectId: string; /** Absent ⇒ the record covers the whole project (removal or demotion). */ scenarioId?: string;
    baseDigest: string; headDigest: string; rationale: string; source?: E2eSourceRef; recordedAt: string;
}
export interface PolicyChangeLedger { records: PolicyChangeRecord[]; issues: string[]; }

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isHex(value: unknown): value is string { return typeof value === "string" && HEX.test(value); }
function isId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function parseSource(value: unknown): E2eSourceRef | null {
    if (!isRecord(value) || typeof value.path !== "string" || !isHex(value.sha256) || typeof value.quote !== "string") return null;
    const kind = SOURCE_KINDS.find(item => item === value.kind);
    return kind ? { kind, path: value.path, sha256: value.sha256, quote: value.quote } : null;
}
function wellFormed(value: Record<string, unknown>): boolean {
    if (value.version !== 1 || value.kind !== "replacement" || !isId(value.projectId)) return false;
    if (value.scenarioId !== undefined && !isId(value.scenarioId)) return false;
    if (!isHex(value.baseDigest) || !isHex(value.headDigest)) return false;
    return typeof value.rationale === "string" && value.rationale.trim() !== "" && typeof value.recordedAt === "string" && Number.isFinite(Date.parse(value.recordedAt));
}
/** Constructing parser: every field checked; unknown or malformed ⇒ null. */
export function parsePolicyChange(value: unknown): PolicyChangeRecord | null {
    if (!isRecord(value) || !wellFormed(value)) return null;
    const record: PolicyChangeRecord = { version: 1, kind: "replacement", projectId: String(value.projectId), baseDigest: String(value.baseDigest), headDigest: String(value.headDigest), rationale: String(value.rationale), recordedAt: String(value.recordedAt) };
    if (value.scenarioId !== undefined) record.scenarioId = String(value.scenarioId);
    if (value.source === undefined) return record;
    const source = parseSource(value.source);
    if (!source) return null;
    record.source = source;
    return record;
}
export function appendPolicyChange(root: string, record: PolicyChangeRecord): PolicyChangeRecord {
    if (!parsePolicyChange(record)) throw new Error("policy change record is not well-formed");
    const absolute = join(root, E2E_POLICY_CHANGES_PATH);
    mkdirSync(dirname(absolute), { recursive: true });
    appendFileSync(absolute, `${JSON.stringify(record)}\n`);
    return record;
}
function parseLine(line: string, where: string, ledger: PolicyChangeLedger): void {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { ledger.issues.push(`${where} is not JSON`); return; }
    const record = parsePolicyChange(parsed);
    if (record) ledger.records.push(record); else ledger.issues.push(`${where} is not a replacement record`);
}
export function readPolicyChanges(root: string): PolicyChangeLedger {
    const absolute = join(root, E2E_POLICY_CHANGES_PATH);
    const ledger: PolicyChangeLedger = { records: [], issues: [] };
    if (!existsSync(absolute)) return ledger;
    const lines = readFileSync(absolute, "utf8").split("\n").filter(line => line.trim());
    if (lines.length > MAX_ROWS) ledger.issues.push(`${E2E_POLICY_CHANGES_PATH} has ${lines.length} rows; only the newest ${MAX_ROWS} are read`);
    for (const [index, line] of lines.slice(-MAX_ROWS).entries()) parseLine(line, `${E2E_POLICY_CHANGES_PATH}:${index + 1}`, ledger);
    return ledger;
}
