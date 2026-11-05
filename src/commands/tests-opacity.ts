import { realpathSync } from "node:fs";
import { rankOpacity, renderOpacityReport } from "../harness/test-opacity.js";
import { historicalTests, srcFixtureModules } from "../harness/test-plan-inputs.js";
import { captureVitestEnvironment, discoverVitestUniverse } from "../harness/coverage-shards/discovery.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface OpacityOptions { cwd?: string; limit?: string; json?: boolean; short?: boolean; full?: boolean; }

/**
 * `interlinked tests opacity [--limit n]`: rank the modules that make test results non-reusable by the recorded
 * execution time of the tests that reach them, with one import chain each. Durations come from the coverage
 * index's accepted manifest when one exists; a test without one is counted as unmeasured, never as free.
 */
export async function testsOpacityCommand(options: OpacityOptions): Promise<void> {
    const mode = getOutputMode(options);
    try {
        const limit = options.limit === undefined ? undefined : Number(options.limit);
        if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) { outputError(mode, "--limit must be a positive integer"); process.exitCode = 2; return; }
        const root = realpathSync(options.cwd ?? process.cwd());
        const universe = await discoverVitestUniverse(root, Date.now() + 60_000, captureVitestEnvironment().environment);
        const inventory = collectRepositoryInventory(root);
        const report = rankOpacity(inventory, srcFixtureModules(inventory), historicalTests(root), { ...universe, ...(limit === undefined ? {} : { limit }) });
        output(mode, report, { normal: () => renderOpacityReport(report) });
    } catch (error) { outputError(mode, error instanceof Error ? error.message : "opacity ranking unavailable"); process.exitCode = 2; }
}
