import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryInventory } from "./e2e-inventory.js";
import { preflightE2eRun } from "./e2e-preflight.js";
import { compareE2e } from "./e2e-ratchet.js";

const roots: string[] = [];
const boundary = "src/hook-entry.ts";
const entry = (pct: number) => ({ lines_pct: pct, branches_pct: pct, statements_pct: pct, functions_pct: pct, lines_total: 100, lines_covered: pct });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "e2e-preflight-"));
    roots.push(root);
    for (const directory of ["src", "dist", ".interlinked"]) mkdirSync(join(root, directory));
    writeFileSync(join(root, boundary), "export const value = 1;\n");
    writeFileSync(join(root, "dist/index.js"), "export const value = 1;\n");
    writeFileSync(join(root, "dist/index.js.map"), JSON.stringify({ version: 3, mappings: "AAAA", sources: ["../src/hook-entry.ts"] }));
    const metafile = { inputs: { [boundary]: {} }, outputs: { ".dist-build-test/index.js": { entryPoint: "src/index.ts", inputs: { [boundary]: { bytesInOutput: 1 } } } } };
    writeFileSync(join(root, "dist/metafile-esm.json"), JSON.stringify(metafile));
    const baselinePath = join(root, ".interlinked/coverage-e2e-baseline.json");
    const putBaseline = (files: Record<string, ReturnType<typeof entry>>) => writeFileSync(baselinePath, JSON.stringify({ version: 1, updated_at: "prior", files }));
    putBaseline({ [boundary]: entry(50) });
    const deps = { build: vi.fn(() => "build"), tests: vi.fn(async () => "tests"), inventory: boundaryInventory, base: vi.fn(() => ({})) };
    return { root, deps, metafile, baselinePath, putBaseline };
}

describe("early E2E lane preflight", () => {
    it("fails unresolved migration before even collecting tests, preserving the baseline", async () => {
        const { root, deps, baselinePath, putBaseline } = fixture();
        putBaseline({ "src/hook-entry-old.ts": entry(80) });
        const before = readFileSync(baselinePath, "utf8");
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("UNRESOLVED");
        expect(deps.tests).not.toHaveBeenCalled();
        expect(readFileSync(baselinePath, "utf8")).toBe(before);
    });

    it("accepts an explicit move without lowering its later measured floor", async () => {
        const { root, deps, putBaseline } = fixture();
        const before = { "src/hook-entry-old.ts": entry(80) };
        const mappings = [`src/hook-entry-old.ts=${boundary}`];
        putBaseline(before);
        const result = await preflightE2eRun(root, { mappings }, deps);
        expect(result).toMatchObject({ measured: false, inventory: [boundary] });
        expect(() => compareE2e({ before, base: {}, mappings, inventory: result.inventory, report: { [boundary]: entry(79) } })).toThrow("fell");
        expect(compareE2e({ before, base: {}, mappings, inventory: result.inventory, report: { [boundary]: entry(80) } })).toEqual({ [boundary]: entry(80) });
    });

    it("requires a push baseline but preserves explicit standalone initialization preparation", async () => {
        const { root, deps, baselinePath } = fixture();
        rmSync(baselinePath);
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("Missing e2e baseline");
        expect(deps.tests).not.toHaveBeenCalled();
        await expect(preflightE2eRun(root, { requireBaseline: false }, deps)).resolves.toMatchObject({ measured: false });
        expect(() => readFileSync(baselinePath)).toThrow();
        writeFileSync(baselinePath, "{}");
        await expect(preflightE2eRun(root, { requireBaseline: false }, deps)).rejects.toThrow("Malformed");
    });

    it("fails invalid bases and stale builds before test collection", async () => {
        const { root, deps } = fixture();
        deps.base.mockImplementationOnce(() => { throw new Error("missing commit"); });
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("missing commit");
        deps.build.mockImplementationOnce(() => { throw new Error("stale build"); });
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("stale build");
        expect(deps.tests).not.toHaveBeenCalled();
    });

    it("rejects emitted internal entry modules and missing maps before collection", async () => {
        const { root, deps, metafile } = fixture();
        const path = join(root, "dist/metafile-esm.json");
        writeFileSync(path, JSON.stringify({ ...metafile, outputs: { ".dist-build-test/index.js": { entryPoint: "src/index.ts", inputs: { "src/commands/jev.ts": { bytesInOutput: 1 } } } } }));
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("Source-only evaluation module");
        writeFileSync(path, JSON.stringify(metafile));
        rmSync(join(root, "dist/index.js.map"));
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow();
        expect(deps.tests).not.toHaveBeenCalled();
    });

    it("propagates unavailable collection and rejects an empty inventory", async () => {
        const { root, deps } = fixture();
        await expect(preflightE2eRun(root, {}, { ...deps, inventory: () => [] })).rejects.toThrow("empty");
        expect(deps.tests).not.toHaveBeenCalled();
        deps.tests.mockRejectedValueOnce(new Error("no tests collected"));
        await expect(preflightE2eRun(root, {}, deps)).rejects.toThrow("no tests collected");
    });
});
