import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCoverageOverlay } from "../coverage-overlay.js";
import { captureCoverageRuntime, coverageRuntimeSupportHash, prepareCoverageRuntime } from "./runtime-inputs.js";
import { withProcessCancellation } from "../check-engine/process-cancellation.js";

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

it("stops a cancelled census before reading files and reports incomplete evidence", async () => {
    const root = fixture(), events: unknown[] = [], controller = new AbortController();
    const diagnostics = channel("interlinked.coverage-runtime-scan"), collect = (value: unknown) => { events.push(value); };
    controller.abort(new Error("census cancelled"));
    diagnostics.subscribe(collect);
    try {
        await expect(withProcessCancellation(controller.signal, () => captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 }))).rejects.toThrow("census cancelled");
        expect(events).toEqual([expect.objectContaining({ root, completed: false, bytesRead: 0, entriesVisited: 0 })]);
    } finally { diagnostics.unsubscribe(collect); }
});

it("reports bounded scan cost for successful and failed captures without changing identities", async () => {
    const root = fixture(), events: unknown[] = [];
    const diagnostics = channel("interlinked.coverage-runtime-scan"), collect = (value: unknown) => { events.push(value); };
    diagnostics.subscribe(collect);
    try {
        const options = { originalRoot: root, deadline: Date.now() + 10_000 };
        const first = await captureCoverageRuntime(root, options);
        const second = await captureCoverageRuntime(root, options);
        expect(second.hash).toBe(first.hash);
        await expect(captureCoverageRuntime(root, { ...options, deadline: Date.now() - 1 })).rejects.toThrow("deadline");
        expect(events).toEqual([
            expect.objectContaining({ root, completed: true, bytesRead: expect.any(Number), durationMs: expect.any(Number) }),
            expect.objectContaining({ root, completed: true, bytesRead: expect.any(Number), durationMs: expect.any(Number) }),
            expect.objectContaining({ root, completed: false, bytesRead: 0, entriesVisited: 0 }),
        ]);
        expect(JSON.stringify(events)).not.toContain("MODE=before");
        expect(JSON.stringify(events).length).toBeLessThan(1500);
    } finally { diagnostics.unsubscribe(collect); }
});
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

// test-contract: public-api — a dangling link inside the census is an input (its link text), never an absent file, and its target appearing changes the identity
it("P1: records a dangling link inside the census and invalidates when its target appears", async () => {
    const root = fixture();
    const options = { originalRoot: root, deadline: Date.now() + 10_000 };
    symlinkSync("missing-input.json", join(root, "runtime-input.json"));
    const dangling = await captureCoverageRuntime(root, options);
    expect(dangling.inputs.find(input => input.path === "runtime-input.json")).toMatchObject({ kind: "dangling-link", mode: 0 });
    writeFileSync(join(root, "missing-input.json"), "{}\n");
    expect((await captureCoverageRuntime(root, options)).hash).not.toBe(dangling.hash);
    rmSync(join(root, "runtime-input.json"));
    symlinkSync("other-input.json", join(root, "runtime-input.json"));
    const retargeted = await captureCoverageRuntime(root, options);
    expect(retargeted.hash).not.toBe(dangling.hash);
    expect(retargeted.inputs.find(input => input.path === "runtime-input.json")?.hash).not.toBe(dangling.inputs.find(input => input.path === "runtime-input.json")?.hash);
});

// test-contract: public-api — the stale `node_modules/node_modules -> toString/node_modules` install artifact (2026-11-04) no longer fails the census of an export whose node_modules is a link
it("P2: tolerates a dangling link inside a linked dependency mount", async () => {
    const root = fixture(), outside = fixture();
    const options = { originalRoot: root, deadline: Date.now() + 10_000 };
    rmSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(outside, "node_modules"), join(root, "node_modules"), "dir");
    symlinkSync("toString/node_modules", join(outside, "node_modules", "node_modules"), "dir");
    const snapshot = await captureCoverageRuntime(root, options);
    expect(snapshot.inputs.find(input => input.path === join("node_modules", "node_modules"))).toMatchObject({ kind: "dangling-link" });
});

// test-contract: invariant — accepting an absent in-project symlink target must preserve the same runtime inputs in the actual overlay.
it("preserves root and nested dangling links through the actual coverage overlay", async () => {
    const root = fixture(), options = { originalRoot: root, deadline: Date.now() + 10_000 };
    mkdirSync(join(root, "nested"));
    symlinkSync("missing.json", join(root, "runtime-input.json"));
    symlinkSync("../missing.json", join(root, "nested", "runtime-input.json"));
    symlinkSync(join(root, "absent.json"), join(root, "absolute-input.json"));
    symlinkSync("source.ts", join(root, "existing-input.ts"));
    const before = await captureCoverageRuntime(root, options);
    const overlay = createCoverageOverlay(root, "source.ts", "export const value = 1;\n");
    try {
        const mirrored = await captureCoverageRuntime(overlay.overlayRoot, options);
        expect(mirrored.hash).toBe(before.hash);
        expect(mirrored.inputs.filter(input => input.kind === "dangling-link")).toHaveLength(3);
        writeFileSync(join(root, "missing.json"), "{}");
        expect((await captureCoverageRuntime(root, options)).hash).not.toBe(before.hash);
    } finally { overlay.cleanup(); }
});

// test-contract: invariant — a dangling link whose target lies outside the census stays refused: its target could appear unseen
it("N1: still rejects a dangling link that points outside the census", async () => {
    const root = fixture(), outside = fixture();
    symlinkSync(join(outside, "absent.json"), join(root, "runtime-input.json"));
    await expect(captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 })).rejects.toThrow("Dangling coverage symlink outside the census");
});

// test-contract: invariant — an unresolvable symlink cycle is an I/O failure, never an accepted absent target.
it("rejects a self-referential symlink instead of treating it as dangling", async () => {
    const root = fixture();
    symlinkSync("cyclic-input.json", join(root, "cyclic-input.json"));
    await expect(captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 })).rejects.toMatchObject({ code: "ELOOP" });
});

it("rejects a file removed after enumeration while the streamed census yields", async () => {
    const root = fixture();
    for (let index = 0; index < 70; index++) writeFileSync(join(root, `input-${index}.json`), "{}");
    writeFileSync(join(root, "zz-last.json"), "{}");
    const removed = new Promise<void>(resolve => setImmediate(() => { rmSync(join(root, "zz-last.json")); resolve(); }));
    await expect(captureCoverageRuntime(root, { originalRoot: root, deadline: Date.now() + 10_000 })).rejects.toThrow();
    await removed;
});

// test-contract: invariant — Vite's cache under the dependency mount (`node_modules/.vite`) is written by the very runs the census brackets and is derived from inputs already hashed, so it is not an input; a dependency's own bytes next to it still are
it("ignores Vite's cache inside the dependency mount while a dependency byte still separates", async () => {
    const root = fixture(), options = { originalRoot: root, deadline: Date.now() + 10_000 };
    const before = await captureCoverageRuntime(root, options);
    mkdirSync(join(root, "node_modules", ".vite", "vitest", "da39a3ee"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".vite", "vitest", "da39a3ee", "results.json"), '{"a.test.ts":{"duration":5}}');
    expect((await captureCoverageRuntime(root, options)).hash).toBe(before.hash);
    writeFileSync(join(root, "node_modules", ".vite", "vitest", "da39a3ee", "results.json"), '{"a.test.ts":{"duration":9}}');
    expect((await captureCoverageRuntime(root, options)).hash).toBe(before.hash);
    writeFileSync(join(root, "node_modules", "dependency", "index.js"), "export const value = 2;\n");
    expect((await captureCoverageRuntime(root, options)).hash).not.toBe(before.hash);
});

// test-contract: invariant — the index's own capture scratch at the root (`.interlinked-coverage-capture-*`, live or left by a died process) is the harness's output, never an input; a same-named directory deeper in the tree is ordinary content
it("ignores the index's capture scratch at the root and nowhere else", async () => {
    const root = fixture(), options = { originalRoot: root, deadline: Date.now() + 10_000 };
    const before = await captureCoverageRuntime(root, options);
    mkdirSync(join(root, ".interlinked-coverage-capture-abc123", "shards"), { recursive: true });
    writeFileSync(join(root, ".interlinked-coverage-capture-abc123", "shards", "x.json"), "{}");
    expect((await captureCoverageRuntime(root, options)).hash).toBe(before.hash);
    mkdirSync(join(root, "nested", ".interlinked-coverage-capture-abc123"), { recursive: true });
    writeFileSync(join(root, "nested", ".interlinked-coverage-capture-abc123", "x.json"), "{}");
    expect((await captureCoverageRuntime(root, options)).hash).not.toBe(before.hash);
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
