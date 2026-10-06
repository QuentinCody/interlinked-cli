import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, vi } from "vitest";
import { harnessCoverageVerifyCommand } from "../commands/harness-coverage-verify.js";
import { COVERAGE_FLOW_SCENARIOS, type CoverageFlowDriver } from "./__fixtures__/hook-coverage-contract.js";
import { controlHookCoverage, isHookCoverageReport, type HookCoverageRequest } from "./hook-coverage-control.js";
import { createHookCoverageChecker } from "./hook-coverage-checks.js";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { DEFAULT_QUALITY_CHECKS } from "./rules/default-config-quality-checks.js";

const query = vi.hoisted(() => vi.fn());
vi.mock("../commands/harness-capabilities.js", () => ({ queryHookCoverage: query }));
const cleanups: Array<() => void> = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(): CoverageFlowDriver {
    const root = mkdtempSync(join(tmpdir(), "coverage-contract-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const checker = createHookCoverageChecker(root, () => ({
        package_json_consistency: DEFAULT_QUALITY_CHECKS.package_json_consistency!,
    }));
    const watcher = startHookFilesystemWatch({ root, reservations: () => [], checker });
    cleanups.push(watcher.stop);
    query.mockImplementation(async (_cwd: string, request: HookCoverageRequest) => controlHookCoverage(watcher, request));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const manifestPath = join(root, "package.json");
    return {
        manifestPath,
        async writeManifest(content) {
            if (content === null) rmSync(manifestPath);
            else writeFileSync(manifestPath, content);
        },
        async status() { return controlHookCoverage(watcher, { operation: "status" }); },
        async verify() {
            const previousExitCode = process.exitCode;
            process.exitCode = 0;
            output.mockClear();
            try {
                await harnessCoverageVerifyCommand({ json: true });
                assert.equal(output.mock.calls.length, 1, "JSON mode emits one completed document");
                const report: unknown = JSON.parse(output.mock.calls[0]![0]);
                assert(isHookCoverageReport(report));
                return { report, exitCode: Number(process.exitCode) };
            } finally { process.exitCode = previousExitCode; }
        },
    };
}

// Only the socket is replaced. The CLI, observer, recovery checker, configured
// package check, receipt qualification and filesystem persistence are real.
it.each(COVERAGE_FLOW_SCENARIOS)("$name", async scenario => {
    await scenario.run(fixture());
});
