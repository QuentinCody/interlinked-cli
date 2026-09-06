import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Two dependency seams are mocked (never the SUT itself) so the discovery
// unreadable-path and analyzer-crash branches in metrics-function-tokens.ts
// are reachable without real filesystem races:
//   - node:fs's `realpathSync`/`readFileSync` throw only for paths a test adds
//     to `fsFailures`, and pass through to the real implementation otherwise
//     (`vi.spyOn(fs, ...)` can't redefine a live ESM named export here — same
//     workaround as src/harness/__tests__/cross-file-checks.mutation-kill-w38.test.ts).
//   - the function-token analyzer's `computeFunctionTokens` throws only for
//     absolute paths a test adds to `functionTokenFailures`.
const fsFailures = vi.hoisted(() => ({
    realpathThrows: new Set<string>(),
    readThrows: new Set<string>(),
}));

vi.mock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        ...actual,
        realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
            const target = String(args[0]);
            if (fsFailures.realpathThrows.has(target)) {
                throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${target}'`), {
                    code: "ENOENT",
                });
            }
            return actual.realpathSync(...args);
        },
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
            const target = String(args[0]);
            if (fsFailures.readThrows.has(target)) {
                throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
                    code: "EACCES",
                });
            }
            return actual.readFileSync(...args);
        },
    };
});

const functionTokenFailures = vi.hoisted(() => ({ throwFor: new Set<string>() }));

vi.mock("../harness/function-tokens/index.js", async () => {
    const actual = await vi.importActual<typeof import("../harness/function-tokens/index.js")>(
        "../harness/function-tokens/index.js",
    );
    return {
        ...actual,
        computeFunctionTokens: (content: string, filePath: string) => {
            if (functionTokenFailures.throwFor.has(filePath)) {
                throw new Error("synthetic analyzer crash");
            }
            return actual.computeFunctionTokens(content, filePath);
        },
    };
});

import {
    buildFunctionTokenMetricsReport,
    compareFunctionTokenText,
    functionTokenDistribution,
    nearestRank,
    summedFileFunctionTokenDistribution,
    summarizeFunctionTokenValues,
} from "./metrics-function-tokens.js";
import {
    renderFunctionTokenInventoryLines,
    renderFunctionTokenOutlierLines,
    renderFunctionTokenSummaryLines,
} from "./metrics-function-token-renderer.js";
import { tokenCountsByFileForMetrics } from "./metrics-function-token-compat.js";
import { uniqueMetricComplexities } from "./metrics-function-token-joins.js";
import type { FnMetric } from "./metrics-renderers.js";

const roots: string[] = [];

function project(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-function-tokens-"));
    roots.push(root);
    mkdirSync(join(root, "src", "generated"), { recursive: true });
    return root;
}

function write(root: string, relativePath: string, content: string): void {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    fsFailures.realpathThrows.clear();
    fsFailures.readThrows.clear();
    functionTokenFailures.throwFor.clear();
});

describe("function-token metric summaries", () => {
    it("uses deterministic nearest-rank percentiles and preserves exact sums", () => {
        expect(nearestRank([], 0.95)).toBeNull();
        expect(nearestRank([40, 10, 30, 20], 0.5)).toBe(20);
        expect(nearestRank([40, 10, 30, 20], 0.95)).toBe(40);
        expect(summarizeFunctionTokenValues([1, 2, 6])).toEqual({
            count: 3,
            sum: 9,
            min: 1,
            mean: 3,
            p50: 2,
            p75: 6,
            p90: 6,
            p95: 6,
            p99: 6,
            max: 6,
        });
    });

    it("pins every function and summed-file distribution boundary", () => {
        expect(functionTokenDistribution([0, 100, 101, 250, 251, 500, 501])).toEqual({
            "≤100": 2,
            "101–250": 2,
            "251–500": 2,
            ">500": 1,
        });
        expect(summedFileFunctionTokenDistribution([
            0, 1, 250, 251, 500, 501, 1_000, 1_001, 2_000, 2_001, 5_000, 5_001,
        ])).toEqual({
            "0": 1,
            "1–250": 2,
            "251–500": 2,
            "501–1,000": 2,
            "1,001–2,000": 2,
            "2,001–5,000": 2,
            ">5,000": 1,
        });
    });

    it("uses locale-independent code-unit ordering", () => {
        expect(compareFunctionTokenText("Z.ts", "a.ts")).toBe(-1);
        expect(compareFunctionTokenText("a.ts", "Z.ts")).toBe(1);
        expect(compareFunctionTokenText("same", "same")).toBe(0);
    });
});

describe("buildFunctionTokenMetricsReport", () => {
    it("reports exhaustive product functions, nested-inclusive file sums, and unsupported files", () => {
        const root = project();
        write(root, "src/a.ts", [
            "export function outer(value: number): number {",
            "    function nested(): number { return value + 1; }",
            "    return nested();",
            "}",
        ].join("\n"));
        write(root, "src/b.ts", "export function peer(value: number): number { return value + 1; }");
        write(root, ".storybook/config.ts", "export function config() { return 1; }");
        write(root, "src/a.test.ts", "it('works', () => { expect(1).toBe(1); });");
        write(root, "src/generated/client.ts", "// @generated\nexport function hidden() { return 1; }");
        write(root, "src/native.go", "package demo\nfunc Native() int { return 1 }");
        write(root, "src/tool.sh", "run() { printf '%s\\n' ok; }\n");
        write(root, "src/data.xml", "<function>not code</function>");
        write(root, "vendor/copied.ts", "export function vendored() { return 1; }");

        const report = buildFunctionTokenMetricsReport({ cwd: root, topN: 2 });
        expect(report.schemaVersion).toBe(1);
        expect(report.tokenizer).toBe("interlinked-code-v2");
        expect(report.scope.includeTests).toBe(false);
        expect(report.functions.map((row) => row.qualifiedName)).toEqual([
            "config",
            "outer",
            "outer.nested",
            "peer",
        ]);
        expect(report.functions.every((row) => row.capEnforced)).toBe(true);
        expect(report.functions.some((row) => row.qualifiedName === "hidden")).toBe(false);
        expect(report.functions.some((row) => row.qualifiedName === "vendored")).toBe(false);
        expect(report.functions.some((row) => row.file.endsWith(".test.ts"))).toBe(false);
        expect(report.notMeasured).toEqual([
            expect.objectContaining({
                file: "src/native.go",
                language: "go",
                kind: "unsupported",
                sourceScope: "product",
                capEnforced: true,
            }),
            expect.objectContaining({
                file: "src/tool.sh",
                language: "sh",
                kind: "unsupported",
                sourceScope: "product",
                capEnforced: true,
            }),
        ]);
        expect(renderFunctionTokenSummaryLines(report).join("\n")).toContain(
            "src/tool.sh — the sh exact function-token adapter is not installed",
        );

        const a = report.files.find((row) => row.file === "src/a.ts");
        expect(a).toBeDefined();
        const aFunctions = report.functions.filter((row) => row.file === "src/a.ts");
        expect(a?.summedFunctionTokens).toBe(
            aFunctions.reduce((sum, row) => sum + row.canonicalTokens, 0),
        );
        expect(a?.functionCount).toBe(2);
        expect(report.topFunctions).toHaveLength(2);
        expect(report.topFunctions[0]?.canonicalTokens).toBeGreaterThanOrEqual(
            report.topFunctions[1]?.canonicalTokens ?? 0,
        );
        expect(report.topFiles[0]?.summedFunctionTokens).toBeGreaterThanOrEqual(
            report.topFiles[1]?.summedFunctionTokens ?? 0,
        );
    });

    it("adds test/spec functions only when explicitly requested and marks them advisory", () => {
        const root = project();
        write(root, "src/product.ts", "export function product() { return 1; }");
        write(root, "src/product.test.ts", "it('works', () => { expect(1).toBe(1); });");

        const defaultReport = buildFunctionTokenMetricsReport({ cwd: root });
        const withTests = buildFunctionTokenMetricsReport({ cwd: root, includeTests: true });

        expect(defaultReport.scope.testFunctions).toBe(0);
        expect(withTests.scope.testFunctions).toBeGreaterThan(0);
        expect(withTests.functions.filter((row) => row.sourceScope === "test"))
            .toEqual(expect.arrayContaining([expect.objectContaining({ capEnforced: false })]));
        expect(withTests.scope.productFunctions).toBe(defaultReport.scope.productFunctions);
        expect(renderFunctionTokenOutlierLines(withTests).join("\n")).toContain("[advisory test]");
        expect(renderFunctionTokenInventoryLines(withTests).join("\n")).toContain(
            "src/product.test.ts",
        );
        expect(renderFunctionTokenInventoryLines(withTests).join("\n")).toContain(
            "[advisory test]",
        );
    });

    it("uses stable function and file distribution boundaries", () => {
        const root = project();
        write(root, "src/empty.ts", "export const answer = 42;");
        const report = buildFunctionTokenMetricsReport({ cwd: root });
        expect(report.distributions.functions).toEqual({
            "≤100": 0,
            "101–250": 0,
            "251–500": 0,
            ">500": 0,
        });
        expect(report.distributions.files["0"]).toBe(1);
        expect(report.totals.functionTokens.mean).toBeNull();
    });

    it("does not attach an arbitrary token or complexity value to same-line collisions", () => {
        const root = project();
        write(
            root,
            "src/collisions.ts",
            "export const values = [1, 2].map((value) => value + 1).filter((value) => value > 1);",
        );
        const report = buildFunctionTokenMetricsReport({ cwd: root });
        const callbacks = report.functions.filter((row) => row.name === "(callback)");
        expect(callbacks).toHaveLength(2);
        expect(tokenCountsByFileForMetrics(report).get("src/collisions.ts")?.has("(callback):1"))
            .toBe(false);

        const shared = (cyclomatic: number): FnMetric => ({
            file: "src/collisions.ts",
            name: "(callback)",
            line: 1,
            cyclomatic,
            coveragePct: null,
            crap: null,
        });
        expect(uniqueMetricComplexities([shared(2), shared(9)]).has(
            "src/collisions.ts:(callback):1",
        )).toBe(false);
    });

    it("records an unreadable-path finding, sorted, when discovery cannot realpath or read a file", () => {
        const root = project();
        write(root, "src/keep.ts", "export function keep() { return 1; }");
        write(root, "src/broken-realpath.ts", "export function brokenRealpath() { return 1; }");
        write(root, "src/broken-read.ts", "export function brokenRead() { return 1; }");
        const canonicalRoot = realpathSync(root);
        const realpathTarget = join(canonicalRoot, "src", "broken-realpath.ts");
        const readTarget = join(canonicalRoot, "src", "broken-read.ts");
        fsFailures.realpathThrows.add(realpathTarget);
        fsFailures.readThrows.add(readTarget);

        const report = buildFunctionTokenMetricsReport({ cwd: root });

        expect(report.scope.discoveredFiles).toBe(3);
        expect(report.scope.candidateFiles).toBe(3);
        expect(report.scope.unmeasuredFiles).toBe(2);
        expect(report.notMeasured).toEqual([
            expect.objectContaining({
                file: "src/broken-read.ts",
                reason: "tracked source is missing or unreadable",
                kind: "unreadable",
                sourceScope: "product",
                capEnforced: true,
            }),
            expect.objectContaining({
                file: "src/broken-realpath.ts",
                reason: "tracked source is missing or unreadable",
                kind: "unreadable",
                sourceScope: "product",
                capEnforced: true,
            }),
        ]);
        expect(report.functions.map((row) => row.qualifiedName)).toEqual(["keep"]);
    });

    it("records an analysis-failure finding when the token analyzer throws on an otherwise readable file", () => {
        const root = project();
        write(root, "src/crashy.ts", "export function ok() { return 1; }");
        const canonicalRoot = realpathSync(root);
        functionTokenFailures.throwFor.add(join(canonicalRoot, "src", "crashy.ts"));

        const report = buildFunctionTokenMetricsReport({ cwd: root });

        expect(report.scope.unmeasuredFiles).toBe(1);
        expect(report.functions).toHaveLength(0);
        expect(report.notMeasured).toEqual([
            expect.objectContaining({
                file: "src/crashy.ts",
                language: "typescript",
                reason: "the typescript exact analyzer could not parse or analyze the source",
                kind: "analysis_failed",
                sourceScope: "product",
                capEnforced: true,
            }),
        ]);
    });
});
