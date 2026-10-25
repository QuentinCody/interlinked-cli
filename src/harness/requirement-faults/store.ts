// ===========================================
// Requirement faults — the outcome store: each fault's newest outcome, across corpora
// ===========================================
// `latest.json` holds one run, so running a second corpus erased the first one's evidence (2026-10-22: three
// E47a-exec corpora overwrote the detector-clause run twice). The store keeps the newest outcome per corpus and
// fault id; a complete run of a corpus also drops that corpus's faults it no longer contains, a partial run
// (`--ids`) never drops. `tests faults clauses` reads the store. Evidence, not configuration: never committed.
// Two runs that finish at the same moment can lose one update (read-merge-rename, no lock); a re-run restores it.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type { FaultOutcome } from "./corpus.js";

export const FAULT_OUTCOME_STORE = ".interlinked/test-runs/faults/outcomes.json";

export interface StoredOutcome { at: string; corpus: string; outcome: FaultOutcome; }
export type OutcomeStore = Record<string, StoredOutcome>;

const STATUSES: readonly string[] = ["killed", "survived", "inconclusive", "invalid"];
const isStatus = (value: unknown): value is FaultOutcome["status"] => typeof value === "string" && STATUSES.includes(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

function storedOutcome(value: unknown): StoredOutcome | null {
    if (!isJsonObject(value) || typeof value.at !== "string" || typeof value.corpus !== "string" || !isJsonObject(value.outcome)) return null;
    const row = value.outcome;
    if (typeof row.fault !== "string" || typeof row.requirement !== "string" || !isStatus(row.status) || !isStrings(row.killedBy) || !isStrings(row.inconclusive)) return null;
    const outcome: FaultOutcome = { fault: row.fault, requirement: row.requirement, status: row.status, killedBy: row.killedBy, inconclusive: row.inconclusive };
    if (typeof row.reason === "string") outcome.reason = row.reason;
    const reasons = isJsonObject(row.inconclusiveReasons) ? Object.entries(row.inconclusiveReasons) : [];
    if (reasons.length && reasons.every(([, text]) => typeof text === "string")) outcome.inconclusiveReasons = Object.fromEntries(reasons.map(([test, text]) => [test, String(text)]));
    return { at: value.at, corpus: value.corpus, outcome };
}

/** A torn file or another version is no store (null); an entry of the wrong shape is dropped, never guessed. */
export function parseOutcomeStore(text: string): OutcomeStore | null {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!isJsonObject(parsed) || parsed.version !== 1 || !isJsonObject(parsed.outcomes)) return null;
    const store: OutcomeStore = {};
    for (const [key, value] of Object.entries(parsed.outcomes)) {
        const row = storedOutcome(value);
        if (row) store[key] = row;
    }
    return store;
}

export function mergeOutcomes(store: OutcomeStore, corpus: string, at: string, outcomes: readonly FaultOutcome[], complete: boolean): OutcomeStore {
    const ran = new Set(outcomes.map(row => `${corpus}::${row.fault}`));
    const next: OutcomeStore = Object.fromEntries(Object.entries(store).filter(([key, row]) => !complete || row.corpus !== corpus || ran.has(key)));
    for (const outcome of outcomes) next[`${corpus}::${outcome.fault}`] = { at, corpus, outcome };
    return next;
}

export function readOutcomeStore(root: string): OutcomeStore | null {
    let text: string;
    try { text = readFileSync(join(root, FAULT_OUTCOME_STORE), "utf8"); } catch { return null; } // no store yet
    return parseOutcomeStore(text);
}

export function writeOutcomeStore(root: string, store: OutcomeStore): void {
    const path = join(root, FAULT_OUTCOME_STORE), temp = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify({ version: 1, outcomes: store }, null, 1));
    renameSync(temp, path);
}
