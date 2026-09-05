import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMetricsScoreReport } from "./metrics-score.js";

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "metrics-score-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/index.ts"), "export function answer() { return 42; }\n");
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("metrics score", () => {
    it("reports a repeatable structural score with explicit missing full-score evidence", () => {
        const root = fixture();
        const report = buildMetricsScoreReport(root);
        expect(report).toEqual(buildMetricsScoreReport(root));
        expect(report.structuralScore).toBe(0);
        expect(report.slopScore).toBeNull();
        expect(report.rankEligible).toBe(false);
        expect(report.measurement.modelCalls).toBe(0);
        expect(report.scope.measuredFiles).toBe(1);
    });

    it("keeps invalid and unsupported product code visible", () => {
        const root = fixture();
        writeFileSync(join(root, "src/broken.ts"), "export function broken(");
        writeFileSync(join(root, "src/worker.py"), "def worker():\n    return 1\n");
        const report = buildMetricsScoreReport(root);
        expect(report.status).toBe("partial");
        expect(report.scope.notMeasured.map(row => row.file)).toEqual(["src/broken.ts", "src/worker.py"]);
    });

    it("discovers Git source without executing a configured filesystem monitor", () => {
        const root = fixture();
        const git = (args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
        git(["init", "--quiet"]);
        git(["add", "src/index.ts"]);
        const monitor = join(root, ".git/monitor");
        writeFileSync(monitor, '#!/bin/sh\n: > "$0.ran"\necho /\n', { mode: 0o755 });
        git(["config", "core.fsmonitor", monitor]);
        const report = buildMetricsScoreReport(root);
        expect(report.scope.discovery).toBe("git");
        expect(report.scope.measuredFiles).toBe(1);
        expect(existsSync(`${monitor}.ran`)).toBe(false);
    });

    it("excludes test and build output and includes modules without functions", () => {
        const root = fixture();
        mkdirSync(join(root, "dist"));
        writeFileSync(join(root, "dist/index.js"), "function generated() { return 1; }");
        writeFileSync(join(root, "src/index.test.ts"), "test('case', () => {});");
        writeFileSync(join(root, "src/constants.ts"), "export const limit = 1;\n");
        const report = buildMetricsScoreReport(root);
        expect(report.files.map(file => file.file)).toEqual(["src/constants.ts", "src/index.ts"]);
        expect(report.scope.functions).toBe(1);
        expect(report.scope.moduleTokensOutsideFunctions).toBeGreaterThan(0);
    });
});
