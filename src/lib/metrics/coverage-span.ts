import { record, sourceSpan } from "./evidence-json.js";

/** V8 source maps serialize open-ended end columns as null. Line-only joins retain that boundary. */
export function coverageSpan(value: unknown): ReturnType<typeof sourceSpan> {
    const span = record(value, "coverage location"), end = record(span.end, "coverage end");
    return sourceSpan({ ...span, end: { ...end, column: end.column === null ? Number.MAX_SAFE_INTEGER : end.column } });
}

export const coverageFunctionSpan = coverageSpan;

function normalizedCoverageSpan(value: unknown): unknown {
    const span = coverageSpan(value);
    return { start: { line: span.line, column: span.column }, end: { line: span.endLine, column: span.endColumn } };
}

/** Istanbul's implicit else outcome has empty locations; the enclosing if plus outcome index identifies it. */
export function coverageBranchLocations(value: unknown): unknown[] {
    const branch = record(value, "branch");
    if (!Array.isArray(branch.locations)) throw new Error("Branch locations must be an array");
    return branch.locations.map(value => {
        const location = record(value, "branch location"), start = record(location.start, "branch start"), end = record(location.end, "branch end");
        if (branch.type === "if" && Object.keys(start).length === 0 && Object.keys(end).length === 0) return normalizedCoverageSpan(branch.loc);
        return normalizedCoverageSpan(value);
    });
}
