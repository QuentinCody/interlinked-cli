// ===========================================
// Requirement faults — the recorded-violation corpus and the kill fraction
// ===========================================
// A requirement fault is one recorded violation of a stated requirement: the plan 31 fault shape (id, path, find,
// replace, rationale) plus the requirement it violates, the test files that must notice it, and where it came from
// (`authored` by a fault lane blind to the tests, `edit-log` = the real pre-fix code, `revision` = an old commit).
// A requirement's kill fraction is killed / (killed + survived): one violation under-samples a requirement (E64c:
// 174 of 296 kills came from only one of two violations), and the fraction is the test-value score of plan 32 —
// a score, never a gate. `.interlinked/requirement-faults.json` is the corpus.

import { isJsonObject } from "../../lib/json-types.js";

export const FAULT_CORPUS_PATH = ".interlinked/requirement-faults.json";
const ORIGINS = ["authored", "edit-log", "revision"] as const;
export interface RequirementFault {
    id: string; requirement: { id: string; text?: string; source?: string }; path: string; find: string; replace: string;
    rationale: string; tests: string[]; origin: typeof ORIGINS[number];
}
export interface FaultCorpus { version: 1; faults: RequirementFault[]; }
export interface FaultOutcome {
    fault: string; requirement: string; status: "killed" | "survived" | "inconclusive" | "invalid"; killedBy: string[]; inconclusive: string[]; reason?: string;
    /** Per inconclusive test: its first failure line, or "no result" when it did not report under the fault. */
    inconclusiveReasons?: Record<string, string>;
}
export interface RequirementKills { requirement: string; killed: number; survived: number; inconclusive: number; invalid: number; fraction: number | null; }

function fail(message: string): never { throw new Error(`requirement faults: ${message}`); }
function text(value: unknown, where: string, allowEmpty = false): string {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) fail(`${where} must be a non-empty string`);
    return value;
}
function confined(value: unknown, where: string): string {
    const path = text(value, where).replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").includes("..")) fail(`${where} must be a confined project-relative path`);
    return path;
}
function only(row: Record<string, unknown>, keys: readonly string[], where: string): void {
    for (const key of Object.keys(row)) if (!keys.includes(key)) fail(`${where} has unknown key "${key}"`);
}

function requirement(value: unknown, where: string): RequirementFault["requirement"] {
    if (!isJsonObject(value)) fail(`${where} must be an object`);
    only(value, ["id", "text", "source"], where);
    const out: RequirementFault["requirement"] = { id: text(value.id, `${where}.id`) };
    if (value.text !== undefined) out.text = text(value.text, `${where}.text`);
    if (value.source !== undefined) out.source = confined(value.source, `${where}.source`);
    return out;
}

function fault(value: unknown, where: string): RequirementFault {
    if (!isJsonObject(value)) fail(`${where} must be an object`);
    only(value, ["id", "requirement", "path", "find", "replace", "rationale", "tests", "origin"], where);
    const tests = Array.isArray(value.tests) ? value.tests.map((item, n) => confined(item, `${where}.tests[${n}]`)) : [];
    if (!tests.length) fail(`${where}.tests must list at least one test file`);
    if (!ORIGINS.includes(value.origin as typeof ORIGINS[number])) fail(`${where}.origin must be one of ${ORIGINS.join(", ")}`);
    return {
        id: text(value.id, `${where}.id`), requirement: requirement(value.requirement, `${where}.requirement`), path: confined(value.path, `${where}.path`),
        find: text(value.find, `${where}.find`), replace: text(value.replace, `${where}.replace`, true), rationale: text(value.rationale, `${where}.rationale`),
        tests, origin: value.origin as typeof ORIGINS[number], // SAFETY: membership checked above
    };
}

/** Strict reader: anything unexpected is refused, never skipped. */
export function parseFaultCorpus(content: string): FaultCorpus {
    let raw: unknown;
    try { raw = JSON.parse(content); } catch (error) { fail(`not JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!isJsonObject(raw) || raw.version !== 1 || !Array.isArray(raw.faults)) fail("the corpus must be { version 1, faults: [...] }");
    const faults = raw.faults.map((item, n) => fault(item, `faults[${n}]`));
    if (new Set(faults.map(row => row.id)).size !== faults.length) fail("fault ids must be unique");
    return { version: 1, faults };
}

/** Per requirement, in first-seen order: the kill fraction over valid, conclusive faults (null when none). */
export function summarizeKills(outcomes: readonly FaultOutcome[]): RequirementKills[] {
    const rows = new Map<string, RequirementKills>();
    for (const outcome of outcomes) {
        const row = rows.get(outcome.requirement) ?? { requirement: outcome.requirement, killed: 0, survived: 0, inconclusive: 0, invalid: 0, fraction: null };
        row[outcome.status] += 1;
        rows.set(outcome.requirement, row);
    }
    return [...rows.values()].map(row => ({ ...row, fraction: row.killed + row.survived ? row.killed / (row.killed + row.survived) : null }));
}
