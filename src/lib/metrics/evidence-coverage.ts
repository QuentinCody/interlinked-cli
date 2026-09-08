import type { CoverageCount, CoverageObservation } from "./behavioral-types.js";
import { artifactSourcePath, natural, record, sourceSpan } from "./evidence-json.js";
import type { JsonObject } from "../json-types.js";
import { coverageBranchLocations, coverageFunctionSpan, coverageSpan } from "./coverage-span.js";

interface Statement { line: number; endLine: number; hits: number; }
function counts(values: number[]): CoverageCount { return { total: values.length, covered: values.filter(value => value > 0).length }; }

function statements(data: JsonObject): Statement[] {
    const map = record(data.statementMap, "statementMap"), hits = record(data.s, "statement counts");
    if (Object.keys(map).length !== Object.keys(hits).length) throw new Error("Statement map/count mismatch");
    return Object.entries(map).map(([id, loc]) => ({ ...coverageSpan(loc), hits: natural(hits[id], "statement hit count") }));
}

function branchCounts(data: JsonObject): CoverageCount {
    const map = record(data.branchMap, "branchMap"), hits = record(data.b, "branch counts");
    if (Object.keys(map).length !== Object.keys(hits).length) throw new Error("Branch map/count mismatch");
    const values: number[] = [];
    for (const [id, raw] of Object.entries(map)) {
        const locations = coverageBranchLocations(raw), row = hits[id];
        if (!Array.isArray(locations) || !Array.isArray(row) || row.length !== locations.length) throw new Error("Branch outcome/count mismatch");
        for (const location of locations) sourceSpan(location);
        values.push(...row.map(value => natural(value, "branch hit count")));
    }
    return counts(values);
}

function functions(data: JsonObject, rows: Statement[]): { count: CoverageCount; spans: CoverageObservation["spans"] } {
    const map = record(data.fnMap, "fnMap"), hits = record(data.f, "function counts");
    if (Object.keys(map).length !== Object.keys(hits).length) throw new Error("Function map/count mismatch");
    const values: number[] = [], spans: CoverageObservation["spans"] = [];
    for (const [id, raw] of Object.entries(map)) {
        const location = coverageFunctionSpan(record(raw, "function").loc);
        values.push(natural(hits[id], "function hit count"));
        spans.push({ line: location.line, endLine: location.endLine,
            count: counts(rows.filter(row => row.line >= location.line && row.endLine <= location.endLine).map(row => row.hits)) });
    }
    return { count: counts(values), spans };
}

export function parseIstanbulEvidence(value: unknown, root: string): CoverageObservation[] {
    const files = record(value, "Istanbul report"), paths = new Set<string>();
    return Object.entries(files).map(([rawPath, raw]) => {
        const path = artifactSourcePath(root, rawPath);
        if (paths.has(path)) throw new Error(`Duplicate coverage source path: ${path}`);
        paths.add(path);
        const data = record(raw, "file coverage"), rows = statements(data), lines = new Map<number, number>();
        for (const row of rows) lines.set(row.line, Math.max(lines.get(row.line) ?? 0, row.hits));
        const fn = functions(data, rows);
        return { path, lines: counts([...lines.values()]), branches: branchCounts(data),
            functions: fn.count, spans: fn.spans, uncoveredLines: [...lines].filter(([, hits]) => hits === 0).map(([line]) => line) };
    });
}
