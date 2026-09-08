import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { coverageIndexContext } from "./context.js";
import { coverageIndexStatus, runIndexedCoverage } from "./controller.js";
import { promoteMatchingProposal } from "./staged-state.js";
import { recordWarmEvidence, recordWarmFailure } from "./warm-evidence.js";

export async function warmCoverageIndex(root: string, timeoutMs: number): Promise<{ indexed: boolean; durationMs: number; reason: string | null; status: ReturnType<typeof coverageIndexStatus> }> {
    const started = performance.now(), inventory = collectRepositoryInventory(root), context = coverageIndexContext(inventory);
    const file = inventory.files.find(file => file.role === "product");
    if (!file) throw new Error("No product source available to measure");
    const overlay = createCoverageOverlay(root, file.path, file.content);
    try {
        const result = await runIndexedCoverage({ context, workspace: overlay.overlayRoot, timeoutMs, full: true });
        const current = coverageIndexContext(collectRepositoryInventory(root));
        const promoted = result.indexed && current.fingerprint === context.fingerprint && promoteMatchingProposal(current);
        if (promoted && result.artifact) recordWarmEvidence(current, result.artifact, Math.round(performance.now() - started));
        if (!promoted) recordWarmFailure(context, { durationMs: performance.now() - started, reason: result.reason ?? "Input changed or promotion failed", testsPassed: result.result.testsPassed });
        return { indexed: promoted, durationMs: performance.now() - started, reason: promoted ? null : result.reason ?? "Repository changed or manifest promotion lost a race", status: coverageIndexStatus(current) };
    } finally { overlay.cleanup(); }
}
