import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundaryInventory } from "./e2e-inventory.js";

describe("executable boundary inventory", () => {
    it.each([false, true])("excludes source-only entry modules absent from emitted runtime code (erased: %s)", (erased) => {
        const root = mkdtempSync(join(tmpdir(), "inventory-internal-"));
        const internal = ["src/commands/jev.ts", "src/harness/jev/internal-cli.ts"];
        const runtime = ["src/harness/jev/decision-shadow.ts", "src/harness/jev/edit-shadow.ts"];
        try {
            for (const path of [...internal, ...runtime]) {
                mkdirSync(join(root, path, ".."), { recursive: true });
                writeFileSync(join(root, path), "export function record() { return 42; }\n");
            }
            const inputs = Object.fromEntries([...runtime, ...(erased ? internal : [])].map(path => [path, {}]));
            const outputInputs = Object.fromEntries([...runtime.map(path => [path, { bytesInOutput: 50 }]),
                ...(erased ? internal.map(path => [path, { bytesInOutput: 0 }]) : [])]);
            expect(boundaryInventory(root, { inputs, outputs: { "dist/server.js": { inputs: outputInputs } } })).toEqual(runtime);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it.each(["src/commands/jev.ts", "src/harness/jev/internal-cli.ts"])("refuses to omit a source-only module that enters a runtime bundle: %s", (path) => {
        const root = mkdtempSync(join(tmpdir(), "inventory-emitted-"));
        try {
            mkdirSync(join(root, path, ".."), { recursive: true });
            writeFileSync(join(root, path), "export function internalOnly() { return 42; }\n");
            const meta = { inputs: { [path]: {} }, outputs: { "dist/index.js": { inputs: { [path]: { bytesInOutput: 50 } } } } };
            expect(() => boundaryInventory(root, meta)).toThrow(`Source-only evaluation module contributes runtime bytes: ${path}`);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

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
