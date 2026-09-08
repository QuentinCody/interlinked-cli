import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectRepositoryInventory } from "../../lib/metrics/inventory.js";
import { inventoryWithOverrides } from "../../lib/metrics/inventory-overrides.js";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { captureIndexRuntime, verifyIndexRuntime } from "./runtime-context.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
