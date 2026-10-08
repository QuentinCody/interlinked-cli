import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";

/**
 * Durable test-request queue: one JSON file per request under `.interlinked/test-runs/requests/`,
 * unioned at read time, coalesced at write time (see `requestTests`), retirements audited in
 * `requests/superseded.jsonl`, files removed only by `completeTestRequests` or retirement.
 */
/**
 * What a run must PRODUCE to satisfy a request, beyond passing: a coverage request is satisfied only by a coverage run.
 * `staticSelection` is a PERMISSION, not a product: the requester allows classifier-based omission and reuse. A batch
 * selects only when EVERY pending request permits it, and a run that selected never discharges a request that did not
 * permit it (review 2026-10-06: a default request rode on an opt-in run that omitted a failing test).
 */
export interface RunRequirements { coverage?: { reporters?: string[] }; staticSelection?: true; }
export interface PendingTests { ids: string[]; paths: string[]; full: boolean; requirements: RunRequirements; }
/** Oldest request files read per scan; coalescing at write time keeps the queue far below this. */
const PENDING_REQUEST_CAP = 1000;
function directory(root: string): string { return join(root, ".interlinked/test-runs/requests"); }
export function hasTestRequest(root: string, id: string): boolean { return existsSync(join(directory(root), `${id}.json`)); }

interface StoredRequest { id: string; paths: string[]; full: boolean; requirements: RunRequirements; }

function parseRequirements(value: unknown): RunRequirements | null {
    if (value === undefined) return {};
    if (!isJsonObject(value)) return null;
    if (value.staticSelection !== undefined && value.staticSelection !== true) return null;
    const selection: RunRequirements = value.staticSelection === true ? { staticSelection: true } : {};
    if (value.coverage === undefined) return selection;
    if (!isJsonObject(value.coverage)) return null;
    const reporters = value.coverage.reporters;
    if (reporters !== undefined && (!Array.isArray(reporters) || !reporters.every((reporter): reporter is string => typeof reporter === "string"))) return null;
    return { ...selection, coverage: reporters === undefined ? {} : { reporters } };
}

/**
 * Reference counts of request ids callers in THIS process still await. Coalescing lets several callers share one
 * id, so a request stays protected until the LAST of them leaves; a cross-process waiter re-requests when its file is gone.
 */
const localSubscribers = new Map<string, number>();
export function subscribeTestRequest(id: string): void { localSubscribers.set(id, (localSubscribers.get(id) ?? 0) + 1); }
export function unsubscribeTestRequest(id: string): void {
    const remaining = (localSubscribers.get(id) ?? 0) - 1;
    if (remaining > 0) localSubscribers.set(id, remaining);
    else localSubscribers.delete(id);
}

/** What one request obliges a run to cover and produce. */
export interface Obligation { paths: readonly string[]; full: boolean; requirements: RunRequirements; }

/** A stored obligation (a request file's JSON, or the copy a completion pointer keeps), or null when malformed. */
export function parseObligation(value: unknown): Obligation | null {
    if (!isJsonObject(value) || typeof value.full !== "boolean" || !Array.isArray(value.paths)) return null;
    if (!value.paths.every((path): path is string => typeof path === "string")) return null;
    const requirements = parseRequirements(value.requirements);
    return requirements ? { paths: value.paths, full: value.full, requirements } : null;
}

/** The obligation of a still-pending request (`name` is the request id, with or without `.json`), or null. */
export function readRequestObligation(root: string, name: string): Obligation | null {
    const file = name.endsWith(".json") ? name : `${name}.json`;
    try {
        return parseObligation(JSON.parse(readFileSync(join(directory(root), file), "utf8")));
    } catch {
        return null;
    }
}

/** `covering` satisfies every obligation of `covered`: scope (a full run satisfies any scope; a selected run a selected subset) AND what the run must produce. */
function covers(covering: Obligation, covered: Obligation): boolean {
    if (!meetsRequirements(covering.requirements, covered.requirements)) return false;
    if (covering.full) return true;
    if (covered.full) return false;
    const paths = new Set(covering.paths);
    return covered.paths.every(path => paths.has(path));
}

/** One request file, or null when another process retired or completed it between the directory scan and this read. */
function parseRequest(dir: string, name: string): StoredRequest | null {
    let text: string;
    try {
        text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
        if (isJsonObject(error) && error.code === "ENOENT") return null;
        throw error;
    }
    const value: unknown = JSON.parse(text);
    if (!isJsonObject(value) || typeof value.full !== "boolean" || !Array.isArray(value.paths) || !value.paths.every((path): path is string => typeof path === "string")) throw new Error(`Malformed pending test request: ${name}`);
    const requirements = parseRequirements(value.requirements);
    if (!requirements) throw new Error(`Malformed pending test request: ${name}`);
    return { id: name.slice(0, -".json".length), paths: value.paths, full: value.full, requirements };
}

/** `covering`'s run satisfies `covered`'s requirements: coverage is required by the covered request only if the covering one produces it. */
function meetsRequirements(covering: RunRequirements, covered: RunRequirements): boolean {
    if (covering.staticSelection && !covered.staticSelection) return false;
    if (!covered.coverage) return true;
    if (!covering.coverage) return false;
    const reporters = new Set(covering.coverage.reporters ?? []);
    return (covered.coverage.reporters ?? []).every(reporter => reporters.has(reporter));
}

/** The union of requirements a batch must produce to satisfy every pending request. */
function mergeRequirements(requests: readonly { requirements: RunRequirements }[]): RunRequirements {
    // Selection is permitted only when every pending request permits it; one default request forces the full, fresh run.
    const selection: RunRequirements = requests.length > 0 && requests.every(request => request.requirements.staticSelection) ? { staticSelection: true } : {};
    const coverage = requests.filter(request => request.requirements.coverage);
    if (!coverage.length) return selection;
    return { ...selection, coverage: { reporters: [...new Set(coverage.flatMap(request => request.requirements.coverage?.reporters ?? []))].sort() } };
}

function storedRequests(root: string): StoredRequest[] {
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const names = readdirSync(dir).filter(name => name.endsWith(".json")).sort().slice(0, PENDING_REQUEST_CAP);
    return names.map(name => parseRequest(dir, name)).filter((request): request is StoredRequest => request !== null);
}

/** Audit trail for retired requests: the old obligation and the request that now carries it. Returns false when the audit line could not be written. */
function recordSuperseded(root: string, old: StoredRequest, by: string): boolean {
    try {
        appendFileSync(join(directory(root), "superseded.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), id: old.id, by, full: old.full, paths: old.paths })}\n`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Queues one request, coalescing against the durable queue:
 * - an existing pending request that already covers this one is returned instead of a new file;
 * - pending requests this one covers, and that no caller in this process awaits, are retired (their
 *   obligation now rides on the new request; a full request is never retired by a selected one).
 */
/** Atomic write of one request file; the paths are the freshness inputs `captureKnownTestInputs` tracks, so they are never dropped. */
function writeRequest(dir: string, id: string, request: Obligation): void {
    const temporary = join(dir, `${id}.tmp`);
    writeFileSync(temporary, JSON.stringify({ paths: [...new Set(request.paths)].sort(), full: request.full, requirements: request.requirements }), { mode: 0o600 });
    renameSync(temporary, join(dir, `${id}.json`));
}

export function requestTests(root: string, paths: readonly string[], full: boolean, requirements: RunRequirements = {}): string {
    const dir = directory(root);
    mkdirSync(dir, { recursive: true });
    const request: Obligation = { paths: [...paths], full, requirements };
    const existing = storedRequests(root);
    // Request files are IMMUTABLE once written: a running batch completes the ids it read with the inputs it
    // tracked, so growing an in-flight request's paths would let completion discharge an input it never verified,
    // and two processes rewriting one file would overwrite each other's unions. A request that adds nothing to a
    // covering one is the covering one; a request that adds a path is its own file.
    const covering = existing.find(old => covers(old, request) && request.paths.every(path => old.paths.includes(path)));
    if (covering) return covering.id;
    const retired = existing.filter(old => !localSubscribers.has(old.id) && covers(request, old));
    const id = randomUUID();
    writeRequest(dir, id, { paths: [...request.paths, ...retired.flatMap(old => old.paths)], full, requirements });
    // Evidence BEFORE removal: a waiter that finds the old file gone must also find who carries it. When the audit row
    // cannot be written the old request stays (a duplicate obligation is harmless; an unexplained gap is not).
    for (const old of retired) {
        if (recordSuperseded(root, old, id)) rmSync(join(dir, `${old.id}.json`), { force: true });
    }
    return id;
}

/** Requests preserve edits arriving during an active run or after a timeout. */
export function pendingTests(root: string): PendingTests {
    const requests = storedRequests(root);
    const paths = new Set(requests.flatMap(request => request.paths));
    return { ids: requests.map(request => `${request.id}.json`), paths: [...paths].sort(), full: requests.some(request => request.full), requirements: mergeRequirements(requests) };
}

/** The pending request files (as `pendingTests` names them) whose requirements a run that PRODUCED `produced` satisfies. */
export function pendingRequestsMet(root: string, produced: RunRequirements): string[] {
    return storedRequests(root).filter(request => meetsRequirements(produced, request.requirements)).map(request => `${request.id}.json`);
}

/**
 * Records that `oldId`'s obligation now rides on `newId` (a drain requeued it after rejecting a stale completion).
 * Returns false when the audit row could not be written; the caller must then keep the old evidence in place.
 */
export function recordRequeue(root: string, oldId: string, newId: string, paths: readonly string[], full: boolean): boolean {
    return recordSuperseded(root, { id: oldId, paths: [...paths], full, requirements: {} }, newId);
}

/** One audit row, or null for a torn line (a torn row can only HIDE a retirement, so the waiter keeps its own id). */
function parseAuditRow(line: string): unknown {
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

/**
 * The request that retired `id` (from `superseded.jsonl`), or null when `id` was never retired. A request file that is
 * gone was either COMPLETED or RETIRED into a wider one; only this log tells them apart, so a waiter follows it instead
 * of treating a missing file as a pass (review 2026-10-06). The newest row for `id` wins.
 */
export function supersededBy(root: string, id: string): string | null {
    const path = join(directory(root), "superseded.jsonl");
    if (!existsSync(path)) return null;
    let by: string | null = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const row = line.trim() ? parseAuditRow(line) : null;
        if (isJsonObject(row) && row.id === id && typeof row.by === "string") by = row.by;
    }
    return by;
}

export function completeTestRequests(root: string, ids: string[]): void {
    for (const id of ids) rmSync(join(directory(root), id), { force: true });
}
