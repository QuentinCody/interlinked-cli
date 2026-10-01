import type { JsonObject } from "../../lib/json-types.js";
import { artifactSourcePath, natural, record, sourceSpan } from "../../lib/metrics/evidence-json.js";
import { branchOutcomeHits, parseIstanbulEvidence } from "../../lib/metrics/evidence-coverage.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CanonicalCoverageElementSet, ShardCoverageContribution } from "./types.js";
import { readFileSync } from "node:fs";
import { containedFile } from "../../lib/metrics/inventory.js";
import { functionLocationKey } from "./function-location.js";
import { coverageBranchLocations, coverageSpan } from "../../lib/metrics/coverage-span.js";

/**
 * Location identities include both endpoints; reporter-local numeric IDs never cross shards. The V8→istanbul
 * converter serializes an open-ended statement end as `column: null` (2 of every 3 statements in this repo's own
 * report); `coverageSpan` keeps that boundary as end-of-line, where the strict parser refused it and the first
 * full capture of this repository produced no index (2026-09-29).
 */
function spanKey(value: unknown): string {
    const span = coverageSpan(value);
    return JSON.stringify([span.line, span.column, span.endLine, span.endColumn]);
}
function readSpanKey(key: string): ReturnType<typeof sourceSpan> {
    const values: unknown = JSON.parse(key);
    if (!Array.isArray(values) || values.length !== 4) throw new Error("Invalid coverage span key");
    return sourceSpan({ start: { line: values[0], column: values[1] }, end: { line: values[2], column: values[3] } });
}
function put(map: Map<string, number>, key: string, hits: unknown): void {
    if (map.has(key)) throw new Error("Ambiguous coverage element identity");
    map.set(key, natural(hits, "coverage hits"));
}
function locationElements(data: JsonObject, mapName: string, countName: string, location: (entry: unknown) => string): Map<string, number> {
    const output = new Map<string, number>(), counts = record(data[countName], countName);
    for (const [id, entry] of Object.entries(record(data[mapName], mapName))) put(output, location(entry), counts[id]);
    return output;
}
function branches(data: JsonObject): Map<string, number> {
    const output = new Map<string, number>(), counts = record(data.b, "b");
    for (const [id, value] of Object.entries(record(data.branchMap, "branchMap"))) {
        const branch = record(value, "branch"), locations = coverageBranchLocations(value), hits = counts[id];
        if (!Array.isArray(locations) || !Array.isArray(hits)) throw new Error("Invalid branch arrays");
        const context = JSON.stringify([branch.type, locations.map(spanKey)]);
        // A negative implicit-else count (converter subtraction noise) is 0 hits here as in the evidence validator.
        locations.forEach((_, index) => put(output, `${context}:${index}`, branchOutcomeHits(hits[index])));
    }
    return output;
}
function fileElements(raw: unknown, content: string, path: string): CanonicalCoverageElementSet {
    const data = record(raw, "coverage file"), statements = locationElements(data, "statementMap", "s", spanKey), lines = new Map<number, number>();
    for (const [key, hits] of statements) { const { line } = readSpanKey(key); lines.set(line, Math.max(lines.get(line) ?? 0, hits)); }
    const functions = locationElements(data, "fnMap", "f", entry => functionLocationKey(entry, content, path));
    return { lines, statements, functions, branches: branches(data) };
}
export function strictElements(raw: unknown, root: string): Map<string, CanonicalCoverageElementSet> {
    parseIstanbulEvidence(raw, root);
    return new Map(Object.entries(record(raw, "report")).map(([path, file]) => [artifactSourcePath(root, path), fileElements(file, readFileSync(containedFile(root, path), "utf8"), path)]));
}
/**
 * A statement belongs to a function when it starts inside it and ends inside it. A statement with an OPEN-ENDED end
 * (`column: null` → end-of-line) on the function's last line is contained too: the function's end is resolved to a
 * finite column from the source while the statement's is not, and comparing the two excluded every terminal statement
 * from the function's statement ratio (a two-statement function with hits [1, 0] read 100%; review 2026-09-30).
 */
function containsStatement(fn: ReturnType<typeof readSpanKey>, statement: ReturnType<typeof readSpanKey>): boolean {
    const startsInside = statement.line > fn.line || statement.line === fn.line && statement.column >= fn.column;
    // The open-ended exception applies only to a statement that BEGINS before the function's end: one starting after
    // the closing column on that line belongs to whatever follows the function (review 2026-09-30, round 4).
    const startsBeforeEnd = statement.line < fn.endLine || statement.line === fn.endLine && statement.column < fn.endColumn;
    const openEnded = statement.endColumn === Number.MAX_SAFE_INTEGER && startsBeforeEnd;
    const endsInside = statement.endLine < fn.endLine || statement.endLine === fn.endLine && (openEnded || statement.endColumn <= fn.endColumn);
    return startsInside && endsInside;
}
function functionCoverage(key: string, hits: number, statements: Map<string, number>): PerFileCoverage["functions"][number] {
    const fn = readSpanKey(key), { line, column, endLine } = fn;
    const within = [...statements].filter(([span]) => containsStatement(fn, readSpanKey(span)));
    return { name: `function@${line}:${column}`, line, endLine, hits, statement_pct: within.length ? within.filter(([, count]) => count > 0).length / within.length * 100 : hits > 0 ? 100 : 0 };
}
export function elementsToCoverage(files: Map<string, CanonicalCoverageElementSet>): Map<string, PerFileCoverage> {
    return new Map([...files].map(([path, set]) => [path, { filePath: path, mtime: Date.now(),
        coveredLines: new Set([...set.lines].filter(([, count]) => count > 0).map(([line]) => line)),
        uncoveredLines: new Set([...set.lines].filter(([, count]) => count === 0).map(([line]) => line)),
        functions: [...set.functions].map(([key, hits]) => functionCoverage(key, hits, set.statements ?? new Map())) }]));
}
export function denominatorContribution(files: Map<string, CanonicalCoverageElementSet>): ShardCoverageContribution {
    const zero = <K>(map: Map<K, number>): Map<K, number> => new Map([...map.keys()].map(key => [key, 0]));
    return { shardId: "@denominators", files: new Map([...files].map(([file, set]) => [file, { lines: zero(set.lines), branches: zero(set.branches), functions: zero(set.functions), statements: zero(set.statements ?? new Map()) }])) };
}
export function coverageSignature(files: Map<string, CanonicalCoverageElementSet>): string {
    const dimension = <K>(map: Map<K, number>) => [...map].map(([key, hits]) => [key, hits > 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, set]) => [file, dimension(set.lines), dimension(set.functions), dimension(set.branches), dimension(set.statements ?? new Map())]));
}
