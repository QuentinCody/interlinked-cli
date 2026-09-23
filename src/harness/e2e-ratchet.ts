import assert from "node:assert/strict";
import { isJsonObject } from "../lib/json-types.js";
import { normalizeReportPct } from "./coverage-ratchet-compare.js";

export const E2E_METRICS = ["lines_pct", "branches_pct", "statements_pct", "functions_pct"] as const;
export interface E2eEntry {
    lines_pct: number;
    branches_pct: number;
    statements_pct: number;
    functions_pct: number;
    lines_total: number;
    lines_covered: number;
}
export type E2eFiles = Record<string, E2eEntry>;
export interface E2eBaseline { version: 1; updated_at: string; files: E2eFiles }
export interface E2eComparison {
    before: E2eFiles;
    base: E2eFiles;
    inventory: readonly string[];
    mappings: readonly string[];
}

export function parseE2eEntry(value: unknown, path: string): E2eEntry {
    assert(isJsonObject(value), `Malformed e2e entry: ${path}`);
    for (const metric of E2E_METRICS) assert(typeof value[metric] === "number" && Number.isFinite(value[metric]) && value[metric] >= 0 && value[metric] <= 100, `Invalid ${metric}: ${path}`);
    const covered = value.lines_covered;
    const total = value.lines_total;
    assert(typeof covered === "number" && Number.isSafeInteger(covered) && covered >= 0, `Invalid lines_covered: ${path}`);
    assert(typeof total === "number" && Number.isSafeInteger(total) && total >= 1 && covered <= total, `Invalid lines_total: ${path}`);
    assert(typeof value.lines_pct === "number" && typeof value.branches_pct === "number" && typeof value.statements_pct === "number" && typeof value.functions_pct === "number");
    assert.equal(normalizeReportPct(100 * covered / total), normalizeReportPct(value.lines_pct), `Counts disagree with lines_pct: ${path}`);
    return { lines_pct: value.lines_pct, branches_pct: value.branches_pct, statements_pct: value.statements_pct,
        functions_pct: value.functions_pct, lines_total: total, lines_covered: covered };
}

export function parseE2eBaseline(value: unknown): E2eBaseline {
    assert(isJsonObject(value) && value.version === 1 && typeof value.updated_at === "string" && isJsonObject(value.files), "Malformed e2e baseline");
    const files = Object.fromEntries(Object.entries(value.files).map(([path, entry]) => [path, parseE2eEntry(entry, path)]));
    return { version: 1, updated_at: value.updated_at, files };
}

export function parseE2eReport(value: unknown): E2eFiles {
    assert(isJsonObject(value), "Malformed e2e report");
    const files: [string, E2eEntry][] = [];
    for (const [path, entry] of Object.entries(value)) {
        if (path === "total") continue;
        assert(isJsonObject(entry), `Malformed report entry: ${path}`);
        assert(isJsonObject(entry.lines) && isJsonObject(entry.branches) && isJsonObject(entry.statements) && isJsonObject(entry.functions), `Incomplete report metrics: ${path}`);
        files.push([path, parseE2eEntry({ lines_pct: entry.lines.pct, branches_pct: entry.branches.pct,
            statements_pct: entry.statements.pct, functions_pct: entry.functions.pct,
            lines_covered: entry.lines.covered, lines_total: entry.lines.total }, path)]);
    }
    return Object.fromEntries(files);
}

function mappingPairs(input: E2eComparison): [string, string][] {
    const pairs = input.mappings.map((mapping): [string, string] => {
        const parts = mapping.split("=");
        assert(parts.length === 2 && parts[0] && parts[1] && parts[0] !== parts[1], `Invalid mapping: ${mapping}`);
        return [parts[0], parts[1]];
    });
    const sources = new Set(pairs.map(([source]) => source));
    const destinations = new Set(pairs.map(([, destination]) => destination));
    assert(sources.size === pairs.length && destinations.size === pairs.length, "Mapping sources and destinations must be distinct");
    for (const [source, destination] of pairs) {
        assert(Object.hasOwn(input.before, source), `No baseline source: ${source}`);
        assert(input.inventory.includes(destination), `Destination absent from inventory: ${destination}`);
        assert(!input.inventory.includes(source) || destinations.has(source), `Source still exists: ${source}`);
        assert(!Object.hasOwn(input.before, destination) || sources.has(destination), `Destination already has a floor: ${destination}`);
    }
    return pairs;
}

function mappedPrior(input: E2eComparison): E2eFiles {
    const pairs = mappingPairs(input);
    const mapped = { ...input.before };
    for (const [source] of pairs) delete mapped[source];
    for (const [source, destination] of pairs) {
        const entry = input.before[source];
        assert(entry);
        mapped[destination] = entry;
    }
    return mapped;
}

export function assertFloors(path: string, measured: E2eEntry, floors: (E2eEntry | undefined)[]): void {
    for (const metric of E2E_METRICS) {
        const floor = Math.max(0, ...floors.map((entry) => normalizeReportPct(entry?.[metric] ?? 0)));
        assert(normalizeReportPct(measured[metric]) >= floor, `${path}: ${metric} fell from ${floor} to ${measured[metric]}`);
    }
}

function aggregate(files: E2eFiles): { touched: bigint; files: bigint; covered: bigint; total: bigint } {
    const entries = Object.values(files);
    return { touched: BigInt(entries.filter((entry) => entry.lines_covered > 0).length), files: BigInt(entries.length),
        covered: entries.reduce((sum, entry) => sum + BigInt(entry.lines_covered), 0n),
        total: entries.reduce((sum, entry) => sum + BigInt(entry.lines_total), 0n) };
}

export function assertAggregates(prior: E2eFiles, measured: E2eFiles): void {
    const a = aggregate(prior);
    const b = aggregate(measured);
    if (a.files === 0n) return;
    assert(b.touched * a.files >= a.touched * b.files, "touched_share fell");
    assert(b.covered * a.total >= a.covered * b.total, "weighted_lines fell");
}

function surviving(files: E2eFiles, inventory: readonly string[]): E2eFiles {
    return Object.fromEntries(Object.entries(files).filter(([path]) => inventory.includes(path)));
}

export function moveE2e(input: E2eComparison): E2eFiles {
    const mapped = mappedPrior(input);
    for (const [path, entry] of Object.entries(surviving(mapped, input.inventory))) assertFloors(path, entry, [input.before[path], input.base[path]]);
    return mapped;
}

export function retireE2e(before: E2eFiles, path: string, inventory: readonly string[]): E2eFiles {
    assert(Object.hasOwn(before, path) && !inventory.includes(path), `Cannot retire a missing baseline key or surviving boundary: ${path}`);
    const next = { ...before };
    delete next[path];
    return next;
}

/** Metadata moves preserve a multiset of complete entries; an ordinary
 * measured update must additionally preserve the aggregate floors. */
export function assertE2eTransition(before: E2eFiles, after: E2eFiles, inventory: readonly string[], base: E2eFiles): void {
    for (const path of inventory) {
        if (!before[path] && !base[path]) continue;
        const next = after[path];
        assert(next, `Surviving floor removed: ${path}`);
        assertFloors(path, next, [before[path], base[path]]);
    }
    const displaced = Object.entries(before).filter(([path, entry]) => JSON.stringify(after[path]) !== JSON.stringify(entry)).map(([, entry]) => JSON.stringify(entry));
    const changed = Object.entries(after).filter(([path, entry]) => JSON.stringify(before[path]) !== JSON.stringify(entry));
    const unchangedTransfers = changed.every(([, entry]) => {
        const index = displaced.indexOf(JSON.stringify(entry));
        if (index < 0) return false;
        displaced.splice(index, 1);
        return true;
    });
    if (unchangedTransfers) return;
    assertAggregates(surviving(before, inventory), surviving(after, inventory));
    assertAggregates(surviving(base, inventory), surviving(after, inventory));
}

export function compareE2e(input: E2eComparison & { report: E2eFiles }): E2eFiles {
    assert.deepEqual(Object.keys(input.report).sort(), [...input.inventory].sort(), "Report keys must equal the full inventory");
    const prior = mappedPrior(input);
    const removed = Object.keys(prior).filter((path) => !input.inventory.includes(path));
    const added = input.inventory.filter((path) => !Object.hasOwn(prior, path));
    assert(removed.length === 0 || added.length === 0, `UNRESOLVED: removed ${removed.join(", ")}; new ${added.join(", ")}. Record coverage move or retire first.`);
    for (const [path, entry] of Object.entries(input.report)) {
        parseE2eEntry(entry, path);
        assertFloors(path, entry, [prior[path], input.before[path], input.base[path]]);
    }
    assertAggregates(surviving(prior, input.inventory), input.report);
    assertAggregates(surviving(input.base, input.inventory), input.report);
    return { ...input.report };
}
