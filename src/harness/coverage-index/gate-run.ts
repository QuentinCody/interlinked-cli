import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../../lib/metrics/inventory-overrides.js";
import type { GateContext } from "../evaluator/coverage-write-guard.js";
import type { CoverageRunner, CoverageRunOpts, CoverageRunResult } from "../coverage-runner.js";
import { coverageIndexContext } from "./context.js";
import { runIndexedCoverage } from "./controller.js";
import { indexStore, promoteMatchingProposal } from "./staged-state.js";

export interface GateCoverageRun { result: CoverageRunResult; fullUniverse: boolean; selectedTests: string[] | undefined; }
export function hasCoverageIndex(root: string, language: string): boolean {
    return (language === "ts" || language === "js") && existsSync(join(indexStore(root), "manifest.json"));
}
export async function runCoverageForGate(ctx: GateContext, runner: CoverageRunner, options: CoverageRunOpts): Promise<GateCoverageRun> {
    if (!hasCoverageIndex(ctx.projectRoot, ctx.language)) return { result: await runner.run(options), fullUniverse: options.selectedTests === undefined, selectedTests: options.selectedTests };
    try {
        const deadline = Date.now() + ctx.budgetMs, inventory = collectRepositoryInventory(ctx.projectRoot);
        await promoteMatchingProposal(await coverageIndexContext(inventory, new Map(), { deadline }));
        const changes = new Map((ctx.overlayFiles ?? []).map(file => [file.relPath, file.delete ? null : file.content]));
        changes.set(ctx.relPath, ctx.proposed);
        const context = await coverageIndexContext(inventoryWithOverrides(inventory, changes), changes, { workspace: options.projectRoot, deadline });
        const measured = await runIndexedCoverage({ context, workspace: options.projectRoot, timeoutMs: ctx.budgetMs });
        if (!measured.indexed) return { result: { ...measured.result, ok: false, error: `Incremental coverage unmeasured: ${measured.reason}` }, fullUniverse: false, selectedTests: measured.selectedTests };
        return { result: measured.result, fullUniverse: true, selectedTests: measured.selectedTests };
    } catch (error) { return { result: { ok: false, perFile: new Map(), testsPassed: null, suiteMs: 0, error: `Coverage index unavailable: ${error instanceof Error ? error.message : "unknown error"}` }, fullUniverse: false, selectedTests: undefined }; }
}
