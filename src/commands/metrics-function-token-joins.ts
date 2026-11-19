export { compareCodeUnits as compareMetricText } from "../lib/compare-code-units.js";
import type { FnMetric } from "./metrics-renderers.js";

function metricIdentity(file: string, name: string, line: number): string {
    return `${file}:${name}:${line}`;
}

function recordUniqueComplexity(args: {
    values: Map<string, number>;
    collisions: Set<string>;
    row: FnMetric;
}): void {
    const key = metricIdentity(args.row.file, args.row.name, args.row.line);
    if (args.values.has(key)) {
        args.values.delete(key);
        args.collisions.add(key);
    } else if (!args.collisions.has(key)) {
        args.values.set(key, args.row.cyclomatic);
    }
}

export function uniqueMetricComplexities(functions: FnMetric[]): Map<string, number> {
    const values = new Map<string, number>();
    const collisions = new Set<string>();
    for (const row of functions) recordUniqueComplexity({ values, collisions, row });
    return values;
}
