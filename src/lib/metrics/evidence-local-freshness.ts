import { captureEvidenceEnvironment } from "./evidence-environment.js";
import type { EvidenceReceipt } from "./evidence-types.js";
import { captureWorkspaceInputsSync } from "./evidence-workspace-inputs-sync.js";
import { assertWorkspaceActive } from "./evidence-workspace.js";

export interface LocalEvidenceFreshness { stale: boolean; issues: string[]; }
export interface EvidenceFreshnessOptions { deadline?: number; signal?: AbortSignal; }
type SnapshotResult = { hash: string; issue?: never } | { hash?: never; issue: string };

function freshnessWindow(options: EvidenceFreshnessOptions): { deadline: number; signal?: AbortSignal } {
    let deadline = Date.now() + 10_000;
    if (options.deadline !== undefined && Number.isFinite(options.deadline)) deadline = Math.min(deadline, options.deadline);
    return { deadline, ...(options.signal ? { signal: options.signal } : {}) };
}

/** One environment snapshot, hash cache and shared deadline for an entire synchronous store load. */
export function localEvidenceFreshness(root: string, options: EvidenceFreshnessOptions = {}): (receipt: EvidenceReceipt) => LocalEvidenceFreshness {
    const { environmentHash } = captureEvidenceEnvironment(), snapshotOptions = freshnessWindow(options);
    const hashes = new Map<string, SnapshotResult>();
    function runtimeHash(artifact: string): SnapshotResult {
        let result: SnapshotResult;
        try {
            assertWorkspaceActive(snapshotOptions);
            const cached = hashes.get(artifact);
            if (cached) return cached;
            result = { hash: captureWorkspaceInputsSync(root, { artifact, ...snapshotOptions }).hash };
        }
        catch (error) { result = { issue: `Local runtime inputs unavailable: ${error instanceof Error ? error.message : "Cannot verify workspace"}` }; }
        hashes.set(artifact, result);
        return result;
    }
    return receipt => {
        if (receipt.origin === "ci") return { stale: false, issues: [] };
        const { workspaceHash, artifactSelector } = receipt.runner;
        if (!workspaceHash || !artifactSelector) return { stale: false, issues: [
            "Local evidence lacks verified runtime provenance; run metrics evidence run. Coverage warming alone does not establish this provenance.",
        ] };
        if (receipt.runner.environmentHash !== environmentHash) return { stale: true, issues: ["environmentHash changed"] };
        const current = runtimeHash(artifactSelector);
        if (current.issue !== undefined) return { stale: false, issues: [current.issue] };
        return current.hash === workspaceHash ? { stale: false, issues: [] } : { stale: true, issues: ["workspaceHash changed"] };
    };
}
