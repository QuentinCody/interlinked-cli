import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { captureVitestEnvironment } from "../coverage-shards/discovery.js";
import { containedFile, hashBytes } from "../../lib/metrics/inventory.js";
import type { RepositoryInventory } from "../../lib/metrics/measurement-types.js";
import { captureCoverageRuntime, prepareCoverageRuntime, type CoverageRuntimeSnapshot } from "./runtime-inputs.js";

export interface IndexRuntimeContext {
    original: CoverageRuntimeSnapshot;
    workspace: CoverageRuntimeSnapshot;
    workspaceRoot: string;
    deadline: number;
    environment: NodeJS.ProcessEnv;
    environmentHash: string;
}
export interface IndexContextOptions { workspace?: string; deadline?: number; original?: CoverageRuntimeSnapshot; }
function comparable(snapshot: CoverageRuntimeSnapshot, other: CoverageRuntimeSnapshot, changes: ReadonlyMap<string, string | null>): string {
    const directories = new Set(other.inputs.filter(input => input.kind === "directory").map(input => input.path));
    const parents = new Set<string>();
    for (const path of changes.keys()) for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) parents.add(parent);
    return hashBytes(JSON.stringify(snapshot.inputs.filter(input => !changes.has(input.path) &&
        !(input.kind === "directory" && parents.has(input.path) && !directories.has(input.path)))));
}
function verifyInventoryWorkspace(inventory: RepositoryInventory, workspace: string): void {
    for (const file of inventory.files) {
        if (hashBytes(readFileSync(containedFile(workspace, file.path))) !== file.sha256) throw new Error(`Coverage workspace differs from measured source: ${file.path}`);
    }
}
function verifyProposalChanges(workspace: string, snapshot: CoverageRuntimeSnapshot, changes: ReadonlyMap<string, string | null>): void {
    for (const [path, content] of changes) {
        if (!path || isAbsolute(path) || /^\.\.(?:[\\/]|$)/.test(path) || relative(workspace, resolve(workspace, path)) !== path) throw new Error("Noncanonical coverage proposal path");
        const actual = snapshot.inputs.filter(input => input.path === path);
        if (content === null) {
            if (actual.length) throw new Error(`Coverage proposal deletion was not applied: ${path}`);
        } else if (actual.length !== 1 || actual[0]?.kind !== "file" || actual[0].hash !== hashBytes(content)) {
            throw new Error(`Coverage proposal bytes differ: ${path}`);
        }
    }
}
/** Copy failures and copy-time races cannot be mistaken for the intended proposal. */
export async function captureIndexRuntime(inventory: RepositoryInventory, changes: ReadonlyMap<string, string | null>, options: IndexContextOptions): Promise<IndexRuntimeContext> {
    const deadline = options.deadline ?? Date.now() + 60_000, originalRoot = realpathSync(inventory.root);
    const workspaceRoot = realpathSync(options.workspace ?? inventory.root), environment = captureVitestEnvironment();
    prepareCoverageRuntime(originalRoot, deadline);
    const original = options.original ?? await captureCoverageRuntime(originalRoot, { originalRoot, deadline });
    const workspace = workspaceRoot === originalRoot ? original : await captureCoverageRuntime(workspaceRoot, { originalRoot, deadline });
    verifyProposalChanges(workspaceRoot, workspace, changes);
    if (comparable(original, workspace, changes) !== comparable(workspace, original, changes)) throw new Error("Coverage overlay differs from original runtime inputs");
    verifyInventoryWorkspace(inventory, workspaceRoot);
    return { original, workspace, workspaceRoot, deadline, ...environment };
}
export function verifyIndexEnvironment(runtime: IndexRuntimeContext): void {
    if (captureVitestEnvironment().environmentHash !== runtime.environmentHash) throw new Error("Coverage runner environment changed; index unavailable");
}
export async function verifyOriginalRuntime(root: string, runtime: IndexRuntimeContext, excluded: readonly string[] = []): Promise<void> {
    verifyIndexEnvironment(runtime);
    const original = await captureCoverageRuntime(root, { originalRoot: realpathSync(root), deadline: runtime.deadline, excluded });
    if (original.hash !== runtime.original.hash) throw new Error("Original coverage runtime inputs changed; index unavailable");
    verifyIndexEnvironment(runtime);
}
/** Runs before selection, after execution, and even when no test shard needs rerunning. */
export async function verifyIndexRuntime(root: string, runtime: IndexRuntimeContext, workspace = runtime.workspaceRoot, excluded: readonly string[] = []): Promise<void> {
    await verifyOriginalRuntime(root, runtime, realpathSync(root) === realpathSync(workspace) ? excluded : []);
    const actual = await captureCoverageRuntime(workspace, { originalRoot: realpathSync(root), deadline: runtime.deadline, excluded });
    if (actual.hash !== runtime.workspace.hash) throw new Error("Coverage workspace runtime inputs changed; index unavailable");
    verifyIndexEnvironment(runtime);
}
