import { maxFunctionTokensFor } from "../harness/metric-caps.js";
import {
    buildFunctionTokenMetricsReport,
    type FunctionTokenFileMetric,
    type FunctionTokenMetricsReport,
} from "./metrics-function-tokens.js";

interface FunctionTokenMetricsContext {
    cap: number;
    report: FunctionTokenMetricsReport;
    countsByFile: Map<string, Map<string, number>>;
    filesByPath: Map<string, FunctionTokenFileMetric>;
}

function setUniqueTokenCount(args: {
    counts: Map<string, number>;
    collisions: Set<string>;
    key: string;
    value: number;
}): void {
    if (args.counts.has(args.key)) {
        args.counts.delete(args.key);
        args.collisions.add(args.key);
    } else if (!args.collisions.has(args.key)) {
        args.counts.set(args.key, args.value);
    }
}

/** Exported as a narrow regression seam for ambiguous same-line function identities. */
export function tokenCountsByFileForMetrics(
    report: FunctionTokenMetricsReport,
): Map<string, Map<string, number>> {
    const byFile = new Map<string, Map<string, number>>();
    const collisionsByFile = new Map<string, Set<string>>();
    for (const row of report.functions) {
        const counts = byFile.get(row.file) ?? new Map<string, number>();
        const collisions = collisionsByFile.get(row.file) ?? new Set<string>();
        setUniqueTokenCount({
            counts,
            collisions,
            key: `${row.name}:${row.line}`,
            value: row.canonicalTokens,
        });
        byFile.set(row.file, counts);
        collisionsByFile.set(row.file, collisions);
    }
    return byFile;
}

export function functionTokenMetricsContext(args: {
    cwd: string;
    topN: number;
    includeTests: boolean;
}): FunctionTokenMetricsContext {
    const cap = maxFunctionTokensFor(args.cwd);
    const report = buildFunctionTokenMetricsReport({ ...args, cap });
    return {
        cap,
        report,
        countsByFile: tokenCountsByFileForMetrics(report),
        filesByPath: new Map(report.files.map((row) => [row.file, row])),
    };
}
