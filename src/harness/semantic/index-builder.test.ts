import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalEmbeddingRuntime } from "./types.js";
import { buildSemanticIndex } from "./index-builder.js";
import { loadSemanticIndex } from "./vector-store.js";

let temporary = "";

afterEach(() => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    temporary = "";
});

function runtime(embed = vi.fn(async (inputs: string[]) => inputs.map(() => {
    const vector = new Float32Array(768);
    vector[0] = 1;
    return vector;
}))): LocalEmbeddingRuntime {
    return {
        fingerprint: "runtime-fingerprint",
        async countTokens(input) {
            return input.split(/\s+/).filter(Boolean).length;
        },
        embed,
    };
}

describe("semantic index builder", () => {
    it("MUST-FIRE: batches a repository without losing or reordering functions", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-build-"));
        mkdirSync(join(temporary, "src"));
        writeFileSync(join(temporary, "src", "many.ts"), Array.from({ length: 35 }, (_, i) =>
            `export function function${i}(value: number) { return value + ${i}; }`).join("\n"));
        const embed = vi.fn(async (inputs: string[]) => inputs.map(() => {
            const vector = new Float32Array(768); vector[0] = 1; return vector;
        }));
        const result = await buildSemanticIndex(temporary, { runtime: runtime(embed) });
        expect(result.functions).toBe(35);
        expect(embed.mock.calls.map(([inputs]) => inputs.length)).toEqual([16, 16, 3]);
        expect(new Set(loadSemanticIndex(temporary).rows.map(row => row.qualifiedName)).size).toBe(35);
    });
    it("MUST-NOT-FIRE: a short batch response cannot publish a partial generation", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-build-"));
        mkdirSync(join(temporary, "src"));
        writeFileSync(join(temporary, "src", "one.ts"), "export function one() { return 1; }");
        await expect(buildSemanticIndex(temporary, { runtime: runtime(vi.fn(async () => [])) })).rejects.toThrow("incorrect batch length");
        expect(() => loadSemanticIndex(temporary)).toThrow();
    });
    it("extracts exact functions and reuses an unchanged input hash", async () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-build-"));
        mkdirSync(join(temporary, "src"));
        writeFileSync(join(temporary, "src", "sample.ts"), "export function alpha(value: number) { return value + 1; }\n");
        const firstEmbed = vi.fn(async (inputs: string[]) => inputs.map(() => {
            const vector = new Float32Array(768);
            vector[0] = 1;
            return vector;
        }));
        const first = await buildSemanticIndex(temporary, { runtime: runtime(firstEmbed) });
        expect(first.functions).toBe(1);
        expect(first.direct).toBe(1);
        expect(firstEmbed).toHaveBeenCalledTimes(1);

        const secondEmbed = vi.fn(async (_inputs: string[]) => {
            throw new Error("unchanged input should not be re-embedded");
        });
        const second = await buildSemanticIndex(temporary, { runtime: runtime(secondEmbed) });
        expect(second.reused).toBe(1);
        expect(secondEmbed).not.toHaveBeenCalled();
        expect(loadSemanticIndex(temporary).rows[0]?.qualifiedName).toBe("alpha");
    });
});
