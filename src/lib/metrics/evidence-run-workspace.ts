import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { evidenceIdentity, identityDifferences } from "./evidence-identity.js";
import type { EvidenceIdentity } from "./evidence-types.js";
import { captureWorkspaceInputs, changedWorkspaceInputs, type EvidenceWorkspaceSnapshot, type WorkspaceSnapshotOptions } from "./evidence-workspace-inputs.js";
import { assertWorkspaceActive, copyEvidenceWorkspace } from "./evidence-workspace.js";
import { collectRepositoryInventory } from "./inventory.js";
import type { RepositoryInventory } from "./measurement-types.js";

export async function prepareEvidenceWorkspace(inventory: RepositoryInventory, identity: EvidenceIdentity, workspace: string, options: WorkspaceSnapshotOptions): Promise<EvidenceWorkspaceSnapshot> {
    const artifact = join(workspace, options.artifact), path = relative(workspace, artifact);
    if (path === ".." || path.startsWith("../") || path.startsWith("..\\") || !path) throw new Error("Artifact must be a relative file inside the workspace");
    await copyEvidenceWorkspace({ source: inventory.root, destination: workspace, ...options });
    rmSync(artifact, { force: true });
    const copied = await captureWorkspaceInputs(workspace, options);
    const current = await captureWorkspaceInputs(inventory.root, options);
    const issues = identityDifferences(identity, evidenceIdentity(collectRepositoryInventory(inventory.root)));
    if (copied.hash !== current.hash || issues.length) throw new Error("Workspace inputs changed while preparing evidence");
    assertWorkspaceActive(options);
    return copied;
}

export async function verifyEvidenceWorkspace(inventory: RepositoryInventory, identity: EvidenceIdentity, workspace: string, snapshot: EvidenceWorkspaceSnapshot, options: WorkspaceSnapshotOptions): Promise<string[]> {
    const issues = await changedWorkspaceInputs(workspace, snapshot, options);
    const current = await captureWorkspaceInputs(inventory.root, options);
    if (current.hash !== snapshot.hash) issues.push("Repository runtime inputs changed during evidence execution");
    issues.push(...identityDifferences(identity, evidenceIdentity(collectRepositoryInventory(inventory.root))),
        ...identityDifferences(identity, evidenceIdentity({ ...inventory, root: workspace })).map(issue => `Workspace ${issue}`));
    assertWorkspaceActive(options);
    return issues;
}
