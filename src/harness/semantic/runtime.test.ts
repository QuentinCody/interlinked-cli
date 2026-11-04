import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verified: vi.fn() }));
vi.mock("./model-install.js", () => ({ verifySemanticModelArtifact: mocks.verified }));
vi.mock("./config.js", () => ({ modelArtifactPath: () => "/fixture/model.gguf" }));

import { findModel } from "./model-registry.js";
import { createLlamaRuntime } from "./runtime.js";
import type { EmbeddingModelManifest, SemanticLocalConfig } from "./types.js";

let directory = "";
let sequence = 0;

function manifest(): EmbeddingModelManifest {
    const value = findModel("nomic-embed-text-v1.5-q4");
    if (value === undefined) throw new Error("fixture model missing");
    return value;
}

interface FixtureOptions {
    embeddingOutput?: string;
    tokenOutput?: string;
    exitCode?: number;
    version?: string;
    noise?: string;
}

/** A real subprocess that models llama.cpp's output channels and option dialects. */
function fixture(options: FixtureOptions = {}): { config: SemanticLocalConfig; calls: () => string[][] } {
    const stem = join(directory, String(sequence++));
    const command = `${stem}.cjs`;
    const log = `${stem}.jsonl`;
    writeFileSync(command, `#!${process.execPath}\n
const fs = require("node:fs");
const args = process.argv.slice(2);
const options = ${JSON.stringify(options)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
    process.stderr.write((options.noise ?? "backend loaded in 0.015 sec") + "\\n");
    process.stderr.write("version: " + (options.version ?? "8860 (fixture)") + "\\nbuilt with fixture compiler\\n");
    process.exit(0);
}
if (args.includes("--stdin")) {
    if (args.some(arg => ["--threads", "--batch-size", "--gpu-layers"].includes(arg))) {
        process.stderr.write("Error: unknown tokenizer option"); process.exit(1);
    }
    process.stdin.resume();
    process.stdin.on("end", () => process.stdout.write(options.tokenOutput ?? "total number of tokens: 7\\n"));
} else {
    if (options.exitCode) { process.stderr.write("fixture failed"); process.exit(options.exitCode); }
    // llama.cpp8860 suppresses the embedding payload as well as diagnostics.
    if (args.includes("--log-disable")) process.exit(0);
    const prompt = fs.readFileSync(args[args.indexOf("--file") + 1], "utf8");
    const separator = args[args.indexOf("--embd-separator") + 1];
    const vectors = prompt.split(separator).map((_, row) => Array.from({ length: 768 }, (_, i) => i === row ? 1 : 0));
    process.stderr.write("backend diagnostic, not embedding JSON\\n");
    process.stdout.write(options.embeddingOutput ?? JSON.stringify(vectors));
}
`, { mode: 0o700 });
    return {
        config: {
            version: 1, device: "cpu", threads: 4, batch_size: 8192,
            idle_unload_ms: 0, incremental_indexing: true,
            llama_embedding_command: command, llama_tokenize_command: command,
        },
        calls: () => readFileSync(log, "utf8").trim().split("\n").map((line: string) => JSON.parse(line) as string[]),
    };
}

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "semantic-runtime-test-"));
    mocks.verified.mockResolvedValue(true);
});
afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.clearAllMocks();
});

describe("local llama runtime subprocess contract", () => {
    it("MUST-FIRE: configures the registry context and complete physical batches", async () => {
        const child = fixture();
        const runtime = await createLlamaRuntime(manifest(), { ...child.config, batch_size: 0 });
        await runtime.embed(["long function"]);
        const args = child.calls().at(-1) ?? [];
        for (const flag of ["--ctx-size", "--batch-size", "--ubatch-size"]) {
            expect(args[args.indexOf(flag) + 1]).toBe(String(manifest().maxInputTokens));
        }
    });
    it("MUST-NOT-FIRE: rejects undersized configured batches before launching native work", async () => {
        const child = fixture();
        await expect(createLlamaRuntime(manifest(), { ...child.config, batch_size: 2048 })).rejects.toThrow("at least the model context");
    });
    it("MUST-FIRE: changed effective embedding arguments invalidate the index fingerprint", async () => {
        const child = fixture();
        const a = await createLlamaRuntime(manifest(), child.config);
        const b = await createLlamaRuntime(manifest(), { ...child.config, threads: 2 });
        expect(a.fingerprint).not.toBe(b.fingerprint);
    });
    it("MUST-NOT-FIRE: preserves real embedding stdout with stderr diagnostics and multiple inputs", async () => {
        const child = fixture();
        const runtime = await createLlamaRuntime(manifest(), child.config);
        const vectors = await runtime.embed(["search_document: first", "search_document: second"]);
        expect(vectors).toHaveLength(2);
        expect(vectors.every(vector => vector.length === 768 && [...vector].every(Number.isFinite))).toBe(true);
        expect(vectors[0]?.[0]).toBe(1);
        expect(vectors[1]?.[1]).toBe(1);
        expect(child.calls().at(-1)).not.toContain("--log-disable");
    });

    it("MUST-NOT-FIRE: passes only tokenizer-supported arguments when embedding tuning is configured", async () => {
        const child = fixture();
        const runtime = await createLlamaRuntime(manifest(), child.config);
        expect(await runtime.countTokens("hello world")).toBe(7);
        expect(child.calls().at(-1)).toEqual(["--model", "/fixture/model.gguf", "--stdin", "--show-count"]);
    });

    it("MUST-NOT-FIRE: accepts an integer-only tokenizer response", async () => {
        const child = fixture({ tokenOutput: "12\n" });
        const runtime = await createLlamaRuntime(manifest(), child.config);
        expect(await runtime.countTokens("text")).toBe(12);
    });

    it("MUST-NOT-FIRE: an empty batch does not launch an embedding subprocess", async () => {
        const child = fixture();
        const runtime = await createLlamaRuntime(manifest(), child.config);
        const callsBefore = child.calls();
        expect(await runtime.embed([])).toEqual([]);
        expect(child.calls()).toEqual(callsBefore);
    });

    it("MUST-NOT-FIRE: backend timing diagnostics do not change a runtime fingerprint", async () => {
        const first = await createLlamaRuntime(manifest(), fixture({ noise: "loaded in 0.015 sec" }).config);
        const second = await createLlamaRuntime(manifest(), fixture({ noise: "loaded in 0.972 sec" }).config);
        expect(first.fingerprint).toBe(second.fingerprint);
    });

    it("MUST-FIRE: a changed runtime version changes the fingerprint", async () => {
        const first = await createLlamaRuntime(manifest(), fixture({ version: "8860 (a)" }).config);
        const second = await createLlamaRuntime(manifest(), fixture({ version: "8861 (b)" }).config);
        expect(first.fingerprint).not.toBe(second.fingerprint);
    });

    it.each(["", " \n\t"])("MUST-FIRE: blank embedding stdout is not an empty successful batch (%j)", async output => {
        const child = fixture({ embeddingOutput: output });
        const runtime = await createLlamaRuntime(manifest(), child.config);
        await expect(runtime.embed(["nonempty"])).rejects.toThrow("embedding runtime returned empty stdout");
    });

    it.each([
        { label: "malformed JSON", output: "not-json", error: /JSON|Unexpected/ },
        { label: "non-array result", output: "{}", error: /expected 1/ },
        { label: "missing vector", output: "[]", error: /expected 1/ },
        { label: "wrong dimension", output: "[[1,2]]", error: /768-dimension/ },
        { label: "nonnumeric component", output: JSON.stringify([Array(768).fill("not a number")]), error: /finite/ },
        { label: "nonfinite JSON number", output: `[[1e400,${Array(767).fill(0).join(",")}]]`, error: /finite/ },
        { label: "float32 overflow", output: JSON.stringify([Array(768).fill(1e40)]), error: /finite/ },
    ])("MUST-FIRE: $label is rejected", async ({ output, error }) => {
        const child = fixture({ embeddingOutput: output });
        const runtime = await createLlamaRuntime(manifest(), child.config);
        await expect(runtime.embed(["nonempty"])).rejects.toThrow(error);
    });

    it("MUST-FIRE: a missing version identity cannot produce a usable fingerprint", async () => {
        await expect(createLlamaRuntime(manifest(), fixture({ version: "" }).config))
            .rejects.toThrow("did not report a version identity");
    });

    it("MUST-FIRE: an invalid tokenizer response is rejected", async () => {
        const runtime = await createLlamaRuntime(manifest(), fixture({ tokenOutput: "no count here" }).config);
        await expect(runtime.countTokens("nonempty")).rejects.toThrow("unrecognized token-count response");
    });

    it("MUST-FIRE: nonzero native exits cannot masquerade as valid embeddings", async () => {
        const runtime = await createLlamaRuntime(manifest(), fixture({ exitCode: 17 }).config);
        await expect(runtime.embed(["nonempty"])).rejects.toThrow("exited 17: fixture failed");
    });

    it("MUST-FIRE: missing executables are rejected", async () => {
        const child = fixture();
        await expect(createLlamaRuntime(manifest(), { ...child.config, llama_embedding_command: join(directory, "absent") }))
            .rejects.toThrow("unable to start");
    });

    it("MUST-FIRE: unverified model artifacts prevent runtime creation", async () => {
        mocks.verified.mockResolvedValue(false);
        const child = fixture();
        await expect(createLlamaRuntime(manifest(), child.config)).rejects.toThrow("failed SHA-256 verification");
    });
});
