import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundaryInventory } from "./e2e-inventory.js";

describe("executable boundary inventory", () => {
    it("excludes type-only declarations and proven erased barrels, but retains unexecuted functions", async () => {
        const root = mkdtempSync(join(tmpdir(), "inventory-"));
        try {
            mkdirSync(join(root, "src/harness/adapters"), { recursive: true });
            writeFileSync(join(root, "src/harness/adapters/types.ts"), "export interface Event { id: string }\n");
            writeFileSync(join(root, "src/harness/adapters/index.ts"), 'export { run } from "./runtime.js";');
            writeFileSync(join(root, "src/harness/adapters/runtime.ts"), "export function run() { return 42; }");
            const meta = { inputs: { "src/harness/adapters/index.ts": {} }, outputs: {} };
            expect(await boundaryInventory(root, meta)).toEqual(["src/harness/adapters/runtime.ts"]);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
