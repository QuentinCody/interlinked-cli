import { isJsonObject } from "../lib/json-types.js";
import type { FunctionComplexityEntry } from "./checks/cyclomatic.js";

export interface PythonFunctionRegion {
    name: string;
    startLine: number;
    coveredLines: ReadonlySet<number>;
    uncoveredLines: ReadonlySet<number>;
}

/** Native line ownership; deliberately does not invent invocation counts. */
export interface PythonFunctionCoverage {
    adapter: "coverage-py-functions-v1";
    regions: PythonFunctionRegion[];
    unavailable?: string;
}

function lineSet(raw: unknown): Set<number> | null {
    if (!Array.isArray(raw) || raw.some((v) => !Number.isSafeInteger(v) || v < 1)) return null;
    return new Set(raw);
}

function parseRegion(name: string, raw: unknown): PythonFunctionRegion | null {
    if (!isJsonObject(raw)) return null;
    const startLine = raw.start_line;
    if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1) return null;
    const executed = lineSet(raw.executed_lines);
    const missing = lineSet(raw.missing_lines);
    const excluded = lineSet(raw.excluded_lines);
    if (!executed || !missing || !excluded) return null;
    const coveredLines = new Set([...executed].filter((line) => !excluded.has(line)));
    const uncoveredLines = new Set([...missing].filter((line) => !excluded.has(line)));
    if ([...coveredLines].some((line) => uncoveredLines.has(line))) return null;
    return { name, startLine, coveredLines, uncoveredLines };
}

export function parsePythonFunctionCoverage(raw: unknown): PythonFunctionCoverage {
    const result: PythonFunctionCoverage = { adapter: "coverage-py-functions-v1", regions: [] };
    if (!isJsonObject(raw)) return { ...result, unavailable: "coverage.py report has no native function regions with start_line" };
    for (const [name, value] of Object.entries(raw)) {
        if (!name) continue; // coverage.py's module remainder, not a function
        const region = parseRegion(name, value);
        if (!region) return { ...result, unavailable: `invalid or unanchored coverage.py function region: ${name}` };
        result.regions.push(region);
    }
    return result;
}

export function pythonRegionFor(fn: FunctionComplexityEntry, coverage: PythonFunctionCoverage): PythonFunctionRegion | undefined {
    if (coverage.unavailable) return undefined;
    const matches = coverage.regions.filter((region) => region.startLine === fn.line && region.name.split(".").at(-1) === fn.name);
    return matches.length === 1 ? matches[0] : undefined;
}

export function pythonFunctionCoverageIssue(complexities: FunctionComplexityEntry[], coverage: PythonFunctionCoverage): string | null {
    if (complexities.length === 0) return null;
    if (coverage.unavailable) return coverage.unavailable;
    for (const fn of complexities) {
        const region = pythonRegionFor(fn, coverage);
        if (!region) return `no unique native function region for ${fn.name} at line ${fn.line}`;
        if (region.coveredLines.size + region.uncoveredLines.size === 0) return `no measured executable lines for ${fn.name} at line ${fn.line}`;
    }
    return null;
}
