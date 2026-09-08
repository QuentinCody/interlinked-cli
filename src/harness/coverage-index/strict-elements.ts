import type { JsonObject } from "../../lib/json-types.js";
import { artifactSourcePath, natural, record, sourceSpan } from "../../lib/metrics/evidence-json.js";
import { parseIstanbulEvidence } from "../../lib/metrics/evidence-coverage.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CanonicalCoverageElementSet, ShardCoverageContribution } from "./types.js";
import { readFileSync } from "node:fs";
import { containedFile } from "../../lib/metrics/inventory.js";
import { functionLocationKey } from "./function-location.js";
import { coverageBranchLocations } from "../../lib/metrics/coverage-span.js";

/** Location identities include both endpoints; reporter-local numeric IDs never cross shards. */
function spanKey(value: unknown): string {
    const span = sourceSpan(value);
    return JSON.stringify([span.line, span.column, span.endLine, span.endColumn]);
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
        locations.forEach((_, index) => put(output, `${context}:${index}`, hits[index]));
    }
    return output;
}
function fileElements(raw: unknown, content: string, path: string): CanonicalCoverageElementSet {
    const data = record(raw, "coverage file"), statements = locationElements(data, "statementMap", "s", spanKey), lines = new Map<number, number>();
    for (const [key, hits] of statements) { const [line] = JSON.parse(key) as number[]; if (line !== undefined) lines.set(line, Math.max(lines.get(line) ?? 0, hits)); }
    const functions = locationElements(data, "fnMap", "f", entry => functionLocationKey(entry, content, path));
    return { lines, statements, functions, branches: branches(data) };
}
export function strictElements(raw: unknown, root: string): Map<string, CanonicalCoverageElementSet> {
    parseIstanbulEvidence(raw, root);
    return new Map(Object.entries(record(raw, "report")).map(([path, file]) => [artifactSourcePath(root, path), fileElements(file, readFileSync(containedFile(root, path), "utf8"), path)]));
}
function functionCoverage(key: string, hits: number, statements: Map<string, number>): PerFileCoverage["functions"][number] {
    const [line = 0, column = 0, endLine = 0, endColumn = 0] = JSON.parse(key) as number[];
    const within = [...statements].filter(([span]) => {
        const [start = 0, startColumn = 0, end = 0, finishColumn = 0] = JSON.parse(span) as number[];
        return (start > line || start === line && startColumn >= column) && (end < endLine || end === endLine && finishColumn <= endColumn);
    });
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
