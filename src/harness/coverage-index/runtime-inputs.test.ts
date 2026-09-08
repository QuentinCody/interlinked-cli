import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { captureCoverageRuntime, coverageRuntimeSupportHash, prepareCoverageRuntime } from "./runtime-inputs.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "index-runtime-"))); roots.push(root);
    writeFileSync(join(root, "source.ts"), "export const value = 1;\n");
    writeFileSync(join(root, ".env"), "MODE=before\n");
    mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dependency", "index.js"), "export const value = 1;\n");
    symlinkSync("dependency/index.js", join(root, "node_modules", "linked.js"));
    return root;
}
it("matches actual copied ignored inputs and linked dependencies, then detects either changing", async () => {
    const root = fixture(), options = { originalRoot: root, deadline: Date.now() + 10_000 };
    const before = await captureCoverageRuntime(root, options);
    const overlay = createCoverageOverlay(root, "source.ts", "export const value = 1;\n");
    try {
        expect((await captureCoverageRuntime(overlay.overlayRoot, options)).hash).toBe(before.hash);
        writeFileSync(join(root, ".env"), "MODE=after\n");
        const afterEnv = await captureCoverageRuntime(root, options);
        expect(afterEnv.hash).not.toBe(before.hash);
        expect((await captureCoverageRuntime(overlay.overlayRoot, options)).hash).toBe(before.hash);
        writeFileSync(join(root, "node_modules/dependency/index.js"), "export const value = 2;\n");
        expect((await captureCoverageRuntime(overlay.overlayRoot, options)).hash).not.toBe(before.hash);
    } finally { overlay.cleanup(); }
});
it("keeps source bytes per shard while support bytes and file presence invalidate globally", async () => {
    const root = fixture(), options = { originalRoot: root, deadline: Date.now() + 10_000 }, sources = new Set(["source.ts"]);
    writeFileSync(join(root, "setup.ts"), "export const enabled = true;");
    const before = coverageRuntimeSupportHash(await captureCoverageRuntime(root, options), sources);
    writeFileSync(join(root, "source.ts"), "export const value = 2;\n");
    expect(coverageRuntimeSupportHash(await captureCoverageRuntime(root, options), sources)).toBe(before);
    writeFileSync(join(root, "new-source.ts"), "export const added = true;\n");
    sources.add("new-source.ts");
    expect(coverageRuntimeSupportHash(await captureCoverageRuntime(root, options), sources)).not.toBe(before);
    rmSync(join(root, "new-source.ts"));
    expect(coverageRuntimeSupportHash(await captureCoverageRuntime(root, options), sources)).toBe(before);
    writeFileSync(join(root, "setup.ts"), "export const enabled = false;");
    expect(coverageRuntimeSupportHash(await captureCoverageRuntime(root, options), sources)).not.toBe(before);
    await expect(captureCoverageRuntime(root, { ...options, deadline: Date.now() - 1 })).rejects.toThrow("deadline");
});

it("hashes linked dependency mounts but refuses external source aliases and directory cycles", async () => {
    const root = fixture(), outside = fixture();
    const options = { originalRoot: root, deadline: Date.now() + 10_000 };
    rmSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(outside, "node_modules"), join(root, "node_modules"), "dir");
    const before = await captureCoverageRuntime(root, options);
    writeFileSync(join(outside, "node_modules/dependency/index.js"), "export const value = 3;\n");
    expect((await captureCoverageRuntime(root, options)).hash).not.toBe(before.hash);
    symlinkSync(join(outside, "source.ts"), join(root, "external.ts"));
    await expect(captureCoverageRuntime(root, options)).rejects.toThrow("External coverage symlink");
    rmSync(join(root, "external.ts"));
    symlinkSync(".", join(root, "cycle"), "dir");
    await expect(captureCoverageRuntime(root, options)).rejects.toThrow("Cyclic coverage directory link");
});

it("rejects dangling runtime links instead of treating their inputs as absent", async () => {
    const root = fixture();
    symlinkSync("missing-input.json", join(root, "runtime-input.json"));
    await expect(captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 })).rejects.toThrow();
});

it("rejects a file removed after enumeration while the streamed census yields", async () => {
    const root = fixture();
    for (let index = 0; index < 70; index++) writeFileSync(join(root, `input-${index}.json`), "{}");
    writeFileSync(join(root, "zz-last.json"), "{}");
    const removed = new Promise<void>(resolve => setImmediate(() => { rmSync(join(root, "zz-last.json")); resolve(); }));
    await expect(captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 })).rejects.toThrow();
    await removed;
});

it("initializes Vite's bundle directory while retaining its existing bytes as inputs", async () => {
    const root = fixture(), deadline = Date.now() + 10_000, options = { originalRoot: root, deadline };
    prepareCoverageRuntime(root, deadline);
    const existing = join(root, "node_modules/.vite-temp/retained.mjs");
    writeFileSync(existing, "export default 1;");
    const before = await captureCoverageRuntime(root, options);
    prepareCoverageRuntime(root, deadline);
    expect((await captureCoverageRuntime(root, options)).hash).toBe(before.hash);
    writeFileSync(existing, "export default 2;");
    expect((await captureCoverageRuntime(root, options)).hash).not.toBe(before.hash);
    rmSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules"), "not a dependency directory");
    expect(() => prepareCoverageRuntime(root, deadline)).toThrow("Local dependency directory required");
});
