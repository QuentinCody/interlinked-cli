import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { functionTokenProvenance } from "../function-tokens/provenance.js";
import { buildSemanticIndex } from "./index-builder.js";
import { semanticIndexStatus } from "./index-status.js";
import { semanticSimilar } from "./search.js";
import { loadSemanticIndex, publishSemanticGeneration } from "./vector-store.js";
import type { LocalEmbeddingRuntime } from "./types.js";

let root = "";
afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
});

function runtime(): LocalEmbeddingRuntime {
    return { fingerprint: "migration-test-runtime", countTokens: async () => 20,
        embed: vi.fn(async (inputs: string[]) => inputs.map(() => {
            const vector = new Float32Array(768);
            vector[0] = 1;
            return vector;
        })) };
}

async function seed() {
    root = mkdtempSync(join(tmpdir(), "interlinked-semantic-migration-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "function f(x){return `a${x}b`;}\n");
    await buildSemanticIndex(root, { runtime: runtime() });
    return loadSemanticIndex(root);
}

describe("semantic function-token metadata migration", () => {
    it("refuses old counts, then refreshes metadata while reusing the unchanged vector", async () => {
        const initial = await seed();
        const { tokenMeasurement: _measurement, ...legacyMeta } = initial.meta;
        publishSemanticGeneration(root, initial.rows.map(row => ({ ...row, canonicalTokens: 999 })),
            [initial.vectors], { ...legacyMeta, canonicalTokenizer: "interlinked-code-v1" });
        expect((await semanticIndexStatus(root)).state).toBe("measurement-mismatch");
        await expect(semanticSimilar(root, "src/a.ts", 1)).rejects.toThrow("measurement-mismatch");

        const active = runtime();
        const refreshed = await buildSemanticIndex(root, { runtime: active });
        const current = loadSemanticIndex(root);
        expect(refreshed.reused).toBe(1);
        expect(active.embed).not.toHaveBeenCalled();
        expect(current.rows[0]?.canonicalTokens).toBe(12);
        expect(current.meta.tokenMeasurement).toEqual(functionTokenProvenance(["typescript"]));
        expect(current.vectors).toEqual(initial.vectors);
    });

    it("requires a refresh when the recorded parser version differs", async () => {
        const initial = await seed();
        const tokenMeasurement = functionTokenProvenance(["typescript"]);
        tokenMeasurement.adapters = tokenMeasurement.adapters.map(row => ({ ...row, parserVersion: "old-parser" }));
        publishSemanticGeneration(root, initial.rows, [initial.vectors], { ...initial.meta, tokenMeasurement });
        expect((await semanticIndexStatus(root)).state).toBe("measurement-mismatch");
    });

    it("re-embeds changed inputs even when the measurement metadata also needs migration", async () => {
        const initial = await seed();
        publishSemanticGeneration(root, initial.rows, [initial.vectors], { ...initial.meta, canonicalTokenizer: "interlinked-code-v1" });
        writeFileSync(join(root, "src/a.ts"), "function f(x){return `changed${x}b`;}\n");
        const active = runtime();
        expect((await buildSemanticIndex(root, { runtime: active })).reused).toBe(0);
        expect(active.embed).toHaveBeenCalledTimes(1);
    });
});
