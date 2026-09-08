import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { captureWorkspaceInputs } from "./evidence-workspace-inputs.js";
import { copyEvidenceWorkspace } from "./evidence-workspace.js";
import type { WorkspaceInputOptions } from "./evidence-workspace-state.js";

export interface RemovalWorkspaces { baseline: string; candidate: string; runtimeHash: string; }

/** Prepare both phases before any command can mutate the captured input tree. */
export async function prepareRemovalWorkspaces(root: string, parent: string, options: WorkspaceInputOptions): Promise<RemovalWorkspaces> {
    const baseline = join(parent, "baseline"), candidate = join(parent, "candidate");
    await mkdir(baseline);
    await mkdir(candidate);
    await copyEvidenceWorkspace({ source: root, destination: baseline, ...options });
    await copyEvidenceWorkspace({ source: baseline, destination: candidate, ...options });
    const runtimeHash = (await captureWorkspaceInputs(baseline, options)).hash;
    const candidateHash = (await captureWorkspaceInputs(candidate, options)).hash;
    const originalHash = (await captureWorkspaceInputs(root, options)).hash;
    if (runtimeHash !== candidateHash || runtimeHash !== originalHash) throw new Error("Removal trial inputs changed while preparing isolated phases");
    return { baseline, candidate, runtimeHash };
}
