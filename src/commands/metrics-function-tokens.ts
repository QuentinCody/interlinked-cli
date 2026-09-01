import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
    CANONICAL_TOKENIZER_ID,
    computeFunctionTokens,
    functionTokenAnalyzerStatus,
    selectFunctionTokenAnalyzer,
    type FunctionTokenAnalyzerStatus,
    type FunctionTokenEntry,
} from "../harness/function-tokens/index.js";
import {
    isCappableFile,
    isHandwrittenCodeFile,
    isInsideRoot,
    isTestOrSpecPath,
} from "../harness/large-file-policy.js";
import { maxFunctionTokensFor } from "../harness/metric-caps.js";
import { discoverFunctionTokenFiles } from "./verify/file-discovery.js";

type FunctionTokenSourceScope = "product" | "test";

export interface FunctionTokenMetricRow {
    file: string;
    name: string;
    qualifiedName: string;
    declarationKind: FunctionTokenEntry["declarationKind"];
    language: string;
    line: number;
    endLine: number;
    canonicalTokens: number;
    sourceScope: FunctionTokenSourceScope;
    capEnforced: boolean;
    overCap: boolean;
}

export interface FunctionTokenFileMetric {
    file: string;
    sourceScope: FunctionTokenSourceScope;
    capEnforced: boolean;
    functionCount: number;
    /**
     * Sum of per-function canonical counts. Nested implementations are counted
     * in their own span and in the enclosing span by metric definition.
     */
    summedFunctionTokens: number;
    meanFunctionTokens: number | null;
    medianFunctionTokens: number | null;
    p95FunctionTokens: number | null;
    maxFunctionTokens: number | null;
    functionsOverCap: number;
}

export interface FunctionTokenNumericSummary {
    count: number;
    sum: number;
    min: number | null;
    mean: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
}

interface FunctionTokenNotMeasured {
    file: string;
    language: string;
    reason: string;
    kind: "unsupported" | "unavailable" | "analysis_failed" | "unreadable";
    sourceScope: FunctionTokenSourceScope;
    capEnforced: boolean;
}

export interface FunctionTokenMetricsReport {
    schemaVersion: 1;
    tokenizer: typeof CANONICAL_TOKENIZER_ID;
    cap: number;
    elapsedMs: number;
    scope: {
        includeTests: boolean;
        discoveredFiles: number;
        candidateFiles: number;
        measuredFiles: number;
        filesWithFunctions: number;
        productFiles: number;
        testFiles: number;
        unmeasuredFiles: number;
        functionCount: number;
        productFunctions: number;
        testFunctions: number;
    };
    totals: {
        /** Nested-inclusive sum of all per-function canonical counts. */
        summedFunctionTokens: number;
        functionsOverCap: number;
        enforcedFunctionsOverCap: number;
        functionTokens: FunctionTokenNumericSummary;
        summedFileFunctionTokens: FunctionTokenNumericSummary;
    };
    distributions: {
        functions: Record<string, number>;
        files: Record<string, number>;
    };
    topFunctions: FunctionTokenMetricRow[];
    topFiles: FunctionTokenFileMetric[];
    /** Exhaustive, deterministic inventories. These are never capped by --top. */
    functions: FunctionTokenMetricRow[];
    files: FunctionTokenFileMetric[];
    notMeasured: FunctionTokenNotMeasured[];
}

interface ReportSource {
    absolutePath: string;
    relativePath: string;
    content: string;
    sourceScope: FunctionTokenSourceScope;
    status: FunctionTokenAnalyzerStatus;
}

interface SourceDiscovery {
    discoveredFiles: number;
    candidateFiles: number;
    sources: ReportSource[];
    issues: FunctionTokenNotMeasured[];
}

interface MeasuredSource {
    source: ReportSource;
    entries: FunctionTokenEntry[];
}

function slashPath(path: string): string {
    return path.replace(/\\/g, "/");
}

export function compareFunctionTokenText(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

function isInsideResolvedRoot(root: string, file: string): boolean {
    return file === root || file.startsWith(`${root}${sep}`);
}

function isEligibleTestSource(root: string, file: string, content: string): boolean {
    if (!isInsideRoot(root, file)) return false;
    const rel = slashPath(relative(root, file));
    return isTestOrSpecPath(rel)
        && isHandwrittenCodeFile({ filePath: file, content, root });
}

function isCandidatePath(file: string, includeTests: boolean): boolean {
    if (file.endsWith(".d.ts") || selectFunctionTokenAnalyzer(file) === null) return false;
    return includeTests || !isTestOrSpecPath(file);
}

function sourceScopeFor(args: {
    root: string;
    file: string;
    content: string;
    includeTests: boolean;
}): FunctionTokenSourceScope | null {
    if (isCappableFile({ filePath: args.file, content: args.content, root: args.root })) {
        return "product";
    }
    return args.includeTests && isEligibleTestSource(args.root, args.file, args.content)
        ? "test"
        : null;
}

function issueForUnreadable(
    root: string,
    file: string,
    sourceScope: FunctionTokenSourceScope,
): FunctionTokenNotMeasured {
    const rel = slashPath(relative(root, file));
    return {
        file: rel,
        language: functionTokenAnalyzerStatus(rel).language,
        reason: "tracked source is missing or unreadable",
        kind: "unreadable",
        sourceScope,
        capEnforced: sourceScope === "product",
    };
}

function discoverReportSources(root: string, includeTests: boolean): SourceDiscovery {
    const discovered = discoverFunctionTokenFiles(root);
    const sources: ReportSource[] = [];
    const issues: FunctionTokenNotMeasured[] = [];
    const seen = new Set<string>();
    let candidateFiles = 0;

    for (const discoveredPath of discovered) {
        if (!isCandidatePath(discoveredPath, includeTests)) continue;
        const pathScope = sourceScopeFor({ root, file: discoveredPath, content: "", includeTests });
        if (pathScope === null) continue;
        let absolutePath: string;
        try {
            absolutePath = realpathSync(discoveredPath);
        } catch {
            candidateFiles++;
            issues.push(issueForUnreadable(root, discoveredPath, pathScope));
            continue;
        }
        if (!isInsideResolvedRoot(root, absolutePath) || seen.has(absolutePath)) continue;
        seen.add(absolutePath);

        let content: string;
        try {
            content = readFileSync(absolutePath, "utf8");
        } catch {
            candidateFiles++;
            issues.push(issueForUnreadable(root, absolutePath, pathScope));
            continue;
        }

        const sourceScope = sourceScopeFor({ root, file: absolutePath, content, includeTests });
        if (sourceScope === null) continue;
        const relativePath = slashPath(relative(root, absolutePath));
        candidateFiles++;
        sources.push({
            absolutePath,
            relativePath,
            content,
            sourceScope,
            status: functionTokenAnalyzerStatus(relativePath),
        });
    }

    sources.sort((a, b) => compareFunctionTokenText(a.relativePath, b.relativePath));
    issues.sort((a, b) => compareFunctionTokenText(a.file, b.file));
    return { discoveredFiles: discovered.length, candidateFiles, sources, issues };
}

function unavailableIssue(source: ReportSource): FunctionTokenNotMeasured {
    const unsupported = source.status.confidence === "unsupported";
    return {
        file: source.relativePath,
        language: source.status.language,
        reason: source.status.reason
            ?? (unsupported
                ? `the ${source.status.language} exact function-token adapter is not installed`
                : `the ${source.status.language} exact function-token analyzer was unavailable`),
        kind: unsupported ? "unsupported" : "unavailable",
        sourceScope: source.sourceScope,
        capEnforced: source.sourceScope === "product",
    };
}

function analysisFailureIssue(source: ReportSource): FunctionTokenNotMeasured {
    return {
        file: source.relativePath,
        language: source.status.language,
        reason: `the ${source.status.language} exact analyzer could not parse or analyze the source`,
        kind: "analysis_failed",
        sourceScope: source.sourceScope,
        capEnforced: source.sourceScope === "product",
    };
}

function measureSources(sources: ReportSource[]): {
    measured: MeasuredSource[];
    issues: FunctionTokenNotMeasured[];
} {
    const measured: MeasuredSource[] = [];
    const issues: FunctionTokenNotMeasured[] = [];
    for (const source of sources) {
        if (source.status.confidence !== "exact") {
            issues.push(unavailableIssue(source));
            continue;
        }
        let entries: FunctionTokenEntry[] | null;
        try {
            entries = computeFunctionTokens(source.content, source.absolutePath);
        } catch {
            entries = null;
        }
        if (entries === null) {
            issues.push(analysisFailureIssue(source));
            continue;
        }
        measured.push({ source, entries });
    }
    return { measured, issues };
}

function roundHundredths(value: number): number {
    return Math.round(value * 100) / 100;
}

export function nearestRank(values: number[], percentile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
    return sorted[index] ?? null;
}

export function summarizeFunctionTokenValues(values: number[]): FunctionTokenNumericSummary {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        count: sorted.length,
        sum,
        min: sorted[0] ?? null,
        mean: sorted.length === 0 ? null : roundHundredths(sum / sorted.length),
        p50: nearestRank(sorted, 0.5),
        p75: nearestRank(sorted, 0.75),
        p90: nearestRank(sorted, 0.9),
        p95: nearestRank(sorted, 0.95),
        p99: nearestRank(sorted, 0.99),
        max: sorted.at(-1) ?? null,
    };
}

export function functionTokenDistribution(values: number[]): Record<string, number> {
    return {
        "≤100": values.filter((value) => value <= 100).length,
        "101–250": values.filter((value) => value >= 101 && value <= 250).length,
        "251–500": values.filter((value) => value >= 251 && value <= 500).length,
        ">500": values.filter((value) => value > 500).length,
    };
}

export function summedFileFunctionTokenDistribution(values: number[]): Record<string, number> {
    return {
        "0": values.filter((value) => value === 0).length,
        "1–250": values.filter((value) => value >= 1 && value <= 250).length,
        "251–500": values.filter((value) => value >= 251 && value <= 500).length,
        "501–1,000": values.filter((value) => value >= 501 && value <= 1_000).length,
        "1,001–2,000": values.filter((value) => value >= 1_001 && value <= 2_000).length,
        "2,001–5,000": values.filter((value) => value >= 2_001 && value <= 5_000).length,
        ">5,000": values.filter((value) => value > 5_000).length,
    };
}

function functionRows(measured: MeasuredSource[], cap: number): FunctionTokenMetricRow[] {
    const rows = measured.flatMap(({ source, entries }) => entries.map((entry) => ({
        file: source.relativePath,
        name: entry.name,
        qualifiedName: entry.qualifiedName,
        declarationKind: entry.declarationKind,
        language: entry.language,
        line: entry.line,
        endLine: entry.endLine,
        canonicalTokens: entry.canonicalTokens,
        sourceScope: source.sourceScope,
        capEnforced: source.sourceScope === "product",
        overCap: entry.canonicalTokens > cap,
    })));
    return rows.sort((a, b) => compareFunctionTokenText(a.file, b.file)
        || a.line - b.line
        || compareFunctionTokenText(a.qualifiedName, b.qualifiedName));
}

function fileRow(source: MeasuredSource, cap: number): FunctionTokenFileMetric {
    const values = source.entries.map((entry) => entry.canonicalTokens);
    const summary = summarizeFunctionTokenValues(values);
    const enforced = source.source.sourceScope === "product";
    return {
        file: source.source.relativePath,
        sourceScope: source.source.sourceScope,
        capEnforced: enforced,
        functionCount: values.length,
        summedFunctionTokens: summary.sum,
        meanFunctionTokens: summary.mean,
        medianFunctionTokens: summary.p50,
        p95FunctionTokens: summary.p95,
        maxFunctionTokens: summary.max,
        functionsOverCap: values.filter((value) => value > cap).length,
    };
}

function compareFunctionOutlier(a: FunctionTokenMetricRow, b: FunctionTokenMetricRow): number {
    return b.canonicalTokens - a.canonicalTokens
        || compareFunctionTokenText(a.file, b.file)
        || a.line - b.line
        || compareFunctionTokenText(a.qualifiedName, b.qualifiedName);
}

function compareFileOutlier(a: FunctionTokenFileMetric, b: FunctionTokenFileMetric): number {
    return b.summedFunctionTokens - a.summedFunctionTokens
        || (b.maxFunctionTokens ?? 0) - (a.maxFunctionTokens ?? 0)
        || compareFunctionTokenText(a.file, b.file);
}

function reportScope(args: {
    includeTests: boolean;
    discovery: SourceDiscovery;
    functions: FunctionTokenMetricRow[];
    files: FunctionTokenFileMetric[];
    notMeasured: FunctionTokenNotMeasured[];
}): FunctionTokenMetricsReport["scope"] {
    return {
        includeTests: args.includeTests,
        discoveredFiles: args.discovery.discoveredFiles,
        candidateFiles: args.discovery.candidateFiles,
        measuredFiles: args.files.length,
        filesWithFunctions: args.files.filter((row) => row.functionCount > 0).length,
        productFiles: args.files.filter((row) => row.sourceScope === "product").length,
        testFiles: args.files.filter((row) => row.sourceScope === "test").length,
        unmeasuredFiles: args.notMeasured.length,
        functionCount: args.functions.length,
        productFunctions: args.functions.filter((row) => row.sourceScope === "product").length,
        testFunctions: args.functions.filter((row) => row.sourceScope === "test").length,
    };
}

function reportTotals(args: {
    functions: FunctionTokenMetricRow[];
    functionValues: number[];
    fileValues: number[];
}): FunctionTokenMetricsReport["totals"] {
    return {
        summedFunctionTokens: args.functionValues.reduce((sum, value) => sum + value, 0),
        functionsOverCap: args.functions.filter((row) => row.overCap).length,
        enforcedFunctionsOverCap: args.functions.filter((row) => row.overCap && row.capEnforced).length,
        functionTokens: summarizeFunctionTokenValues(args.functionValues),
        summedFileFunctionTokens: summarizeFunctionTokenValues(args.fileValues),
    };
}

export function buildFunctionTokenMetricsReport(args: {
    cwd: string;
    topN?: number;
    includeTests?: boolean;
    cap?: number;
}): FunctionTokenMetricsReport {
    const startedAt = Date.now();
    const root = realpathSync(resolve(args.cwd));
    const includeTests = args.includeTests ?? false;
    const topN = Math.max(1, Math.min(200, args.topN ?? 10));
    const cap = args.cap ?? maxFunctionTokensFor(root);
    const discovery = discoverReportSources(root, includeTests);
    const measurement = measureSources(discovery.sources);
    const functions = functionRows(measurement.measured, cap);
    const files = measurement.measured.map((source) => fileRow(source, cap))
        .sort((a, b) => compareFunctionTokenText(a.file, b.file));
    const functionValues = functions.map((row) => row.canonicalTokens);
    const fileValues = files.map((row) => row.summedFunctionTokens);
    const notMeasured = [...discovery.issues, ...measurement.issues]
        .sort((a, b) => compareFunctionTokenText(a.file, b.file));

    return {
        schemaVersion: 1,
        tokenizer: CANONICAL_TOKENIZER_ID,
        cap,
        elapsedMs: Date.now() - startedAt,
        scope: reportScope({ includeTests, discovery, functions, files, notMeasured }),
        totals: reportTotals({ functions, functionValues, fileValues }),
        distributions: {
            functions: functionTokenDistribution(functionValues),
            files: summedFileFunctionTokenDistribution(fileValues),
        },
        topFunctions: [...functions].sort(compareFunctionOutlier).slice(0, topN),
        topFiles: [...files].sort(compareFileOutlier).slice(0, topN),
        functions,
        files,
        notMeasured,
    };
}
