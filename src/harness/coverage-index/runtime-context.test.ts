import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../../lib/metrics/inventory-overrides.js";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { captureIndexRuntime, verifyIndexRuntime } from "./runtime-context.js";
import * as runtimeInputs from "./runtime-inputs.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "index-runtime-context-"))); roots.push(root);
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "source.ts"), "export const answer = 1;\n");
    writeFileSync(join(root, ".env"), "before");
    return root;
}
it("checks that proposed deletions and excluded asset writes were actually materialized", async () => {
    const root = fixture(), inventory = collectRepositoryInventory(root);
    const deletion = new Map([["source.ts", null]]);
    await expect(captureIndexRuntime(inventoryWithOverrides(inventory, deletion), deletion, {})).rejects.toThrow("deletion was not applied");
    const asset = new Map([["input.bin", "proposed"]]);
    writeFileSync(join(root, "input.bin"), "old bytes");
    await expect(captureIndexRuntime(inventoryWithOverrides(inventory, asset), asset, {})).rejects.toThrow("proposal bytes differ");
    writeFileSync(join(root, "input.bin"), "proposed");
    expect((await captureIndexRuntime(inventoryWithOverrides(inventory, asset), asset, {})).workspace.inputs.some(row => row.path === "input.bin")).toBe(true);
});
it("permits a new proposed directory while retaining every unchanged runtime input", async () => {
    const root = fixture(), inventory = collectRepositoryInventory(root), path = "new/added.ts", content = "export const added = true;\n";
    const changes = new Map([[path, content]]), overlay = createCoverageOverlay(root, path, content);
    try {
        const runtime = await captureIndexRuntime(inventoryWithOverrides(inventory, changes), changes, { workspace: overlay.overlayRoot });
        await verifyIndexRuntime(root, runtime);
        writeFileSync(join(overlay.overlayRoot, ".env"), "different");
        await expect(verifyIndexRuntime(root, runtime)).rejects.toThrow("workspace runtime inputs changed");
        expect(readFileSync(join(root, ".env"), "utf8")).toBe("before");
    } finally { overlay.cleanup(); }
});

it("captures the same physical root once per validation and rechecks on the next call", async () => {
    const root = fixture(), runtime = await captureIndexRuntime(collectRepositoryInventory(root), new Map(), {});
    const alias = join(root, ".interlinked", "runtime-alias");
    mkdirSync(join(root, ".interlinked"), { recursive: true });
    symlinkSync(root, alias, "junction");
    const capture = vi.spyOn(runtimeInputs, "captureCoverageRuntime");
    await verifyIndexRuntime(root, runtime, alias);
    expect(capture).toHaveBeenCalledTimes(1);
    await verifyIndexRuntime(root, runtime);
    expect(capture).toHaveBeenCalledTimes(2);
    writeFileSync(join(root, ".env"), "changed");
    await expect(verifyIndexRuntime(root, runtime)).rejects.toThrow("Original coverage runtime inputs changed");
    expect(capture).toHaveBeenCalledTimes(3);
});

it("compares both expected identities even when validation shares a capture", async () => {
    const root = fixture(), runtime = await captureIndexRuntime(collectRepositoryInventory(root), new Map(), {});
    const divergent = { ...runtime, workspace: { ...runtime.workspace, hash: "different-expected-workspace" } };
    await expect(verifyIndexRuntime(root, divergent)).rejects.toThrow("workspace runtime inputs changed");
});

it("still detects changed installed dependency bytes during same-root validation", async () => {
    const root = fixture(), dependency = join(root, "node_modules", "input.js");
    writeFileSync(dependency, "before");
    const runtime = await captureIndexRuntime(collectRepositoryInventory(root), new Map(), {});
    writeFileSync(dependency, "after!");
    await expect(verifyIndexRuntime(root, runtime)).rejects.toThrow("Original coverage runtime inputs changed");
});

it("keeps output exclusions scoped to the workspace and scans separate roots independently", async () => {
    const root = fixture(), inventory = collectRepositoryInventory(root);
    const overlay = createCoverageOverlay(root, "source.ts", readFileSync(join(root, "source.ts"), "utf8"));
    try {
        const runtime = await captureIndexRuntime(inventory, new Map(), { workspace: overlay.overlayRoot });
        const output = join(overlay.overlayRoot, "test-output");
        mkdirSync(output);
        writeFileSync(join(output, "report.json"), "{}");
        const capture = vi.spyOn(runtimeInputs, "captureCoverageRuntime");
        await verifyIndexRuntime(root, runtime, overlay.overlayRoot, [output]);
        expect(capture).toHaveBeenCalledTimes(2);
        writeFileSync(join(root, ".env"), "changed");
        await expect(verifyIndexRuntime(root, runtime, overlay.overlayRoot, [output])).rejects.toThrow("Original coverage runtime inputs changed");
    } finally { overlay.cleanup(); }
});

it("shares explicit output exclusions when original and workspace are the same root", async () => {
    const root = fixture(), runtime = await captureIndexRuntime(collectRepositoryInventory(root), new Map(), {});
    const output = join(root, "test-output");
    mkdirSync(output);
    writeFileSync(join(output, "report.json"), "{}");
    const capture = vi.spyOn(runtimeInputs, "captureCoverageRuntime");
    await verifyIndexRuntime(root, runtime, root, [output]);
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(verifyIndexRuntime(root, runtime)).rejects.toThrow("Original coverage runtime inputs changed");
});
