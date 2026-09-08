import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { coverageIndexContext } from "./context.js";
import { coverageIndexStatus, runIndexedCoverage } from "./controller.js";
import { promoteMatchingProposal } from "./staged-state.js";
import { recordWarmEvidence, recordWarmFailure } from "./warm-evidence.js";
import { captureCoverageRuntime, prepareCoverageRuntime } from "./runtime-inputs.js";

export async function warmCoverageIndex(root: string, timeoutMs: number): Promise<{ indexed: boolean; durationMs: number; reason: string | null; status: Awaited<ReturnType<typeof coverageIndexStatus>> }> {
    const started = performance.now(), deadline = Date.now() + timeoutMs, inventory = collectRepositoryInventory(root);
    const file = inventory.files.find(file => file.role === "product");
    if (!file) throw new Error("No product source available to measure");
    prepareCoverageRuntime(root, deadline);
    const original = await captureCoverageRuntime(root, { originalRoot: inventory.root, deadline });
    const overlay = createCoverageOverlay(root, file.path, file.content);
    try {
        const context = await coverageIndexContext(inventory, new Map(), { workspace: overlay.overlayRoot, original, deadline });
        const result = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs, full: true });
        const current = await coverageIndexContext(collectRepositoryInventory(root), new Map(), { deadline });
        const promoted = result.indexed && current.fingerprint === context.fingerprint && await promoteMatchingProposal(current);
        if (promoted && result.artifact) recordWarmEvidence(current, result.artifact, Math.round(performance.now() - started));
        if (!promoted) recordWarmFailure(context, { durationMs: performance.now() - started, reason: result.reason ?? "Input changed or promotion failed", testsPassed: result.result.testsPassed });
        return { indexed: promoted, durationMs: performance.now() - started, reason: promoted ? null : result.reason ?? "Repository changed or manifest promotion lost a race", status: await coverageIndexStatus(current) };
    } finally { overlay.cleanup(); }
}
