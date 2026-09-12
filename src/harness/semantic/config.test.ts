import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSemanticTeamConfig, loadSemanticConfig } from "./config.js";

let temporary = "";

afterEach(() => {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    temporary = "";
});

describe("semantic configuration", () => {
    it.each([
        ["semantic.json", null, /must contain a JSON object/],
        ["semantic.json", { version: 2 }, /version must be 1/],
        ["semantic.json", { version: 1, enabled: "false" }, /enabled must be boolean/],
        ["semantic.json", { version: 1, include_tests: 1 }, /include_tests must be boolean/],
        ["semantic.json", { version: 1, model: 42 }, /model must be a string/],
        ["semantic.json", { version: 1, include: "src/**" }, /include must be an array of strings/],
        ["semantic.json", { version: 1, exclude: ["dist/**", null] }, /exclude must be an array of strings/],
        ["semantic.local.json", { version: 1, threads: -1 }, /threads must be a non-negative integer/],
        ["semantic.local.json", { version: 1, batch_size: 1.5 }, /batch_size must be a non-negative integer/],
        ["semantic.local.json", { version: 1, idle_unload_ms: "300" }, /idle_unload_ms must be a non-negative integer/],
        ["semantic.local.json", { version: 1, llama_embedding_command: "  " }, /llama_embedding_command must be a non-empty string/],
    ])("rejects invalid persisted %s configuration %j", (file, value, message) => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", file), JSON.stringify(value));
        expect(() => loadSemanticConfig(temporary)).toThrow(message);
    });

    it("preserves valid team scope and local runtime settings when resolving a pinned model", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        const team = { ...defaultSemanticTeamConfig(), enabled: true, include_tests: true, include: ["lib/**"], exclude: ["lib/vendor/**"] };
        const local = { version: 1, device: "cpu", threads: 2, batch_size: 32, idle_unload_ms: 0, incremental_indexing: false, llama_embedding_command: "local-embed", llama_tokenize_command: "local-tokenize" };
        writeFileSync(join(temporary, ".interlinked", "semantic.json"), JSON.stringify(team));
        writeFileSync(join(temporary, ".interlinked", "semantic.local.json"), JSON.stringify(local));
        const resolved = loadSemanticConfig(temporary);
        expect(resolved.team).toEqual(team);
        expect(resolved.local).toEqual(local);
        expect(resolved.team.model).toBe(`${resolved.manifest.alias}@${resolved.manifest.revision}`);
    });

    it("defaults to a disabled, exact pinned model reference", () => {
        const config = defaultSemanticTeamConfig();
        expect(config.enabled).toBe(false);
        expect(config.model).toMatch(/^[^@]+@[a-f0-9]{40}$/);
        expect(config.include).toEqual(["src/**"]);
    });

    it("rejects mutable aliases in committed team configuration", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.json"), JSON.stringify({
            version: 1,
            enabled: true,
            model: "nomic-embed-text-v1.5-q4",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/exact registry revision/);
    });

    it("keeps remote runtime topology out of the local v1 schema", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.local.json"), JSON.stringify({
            version: 1,
            device: "remote",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/auto or cpu/);
    });

    it("rejects remote fallback keys instead of silently accepting them", () => {
        temporary = mkdtempSync(join(tmpdir(), "interlinked-semantic-config-"));
        mkdirSync(join(temporary, ".interlinked"));
        writeFileSync(join(temporary, ".interlinked", "semantic.local.json"), JSON.stringify({
            version: 1,
            remote_url: "https://embeddings.example",
        }));
        expect(() => loadSemanticConfig(temporary)).toThrow(/unsupported key.*remote_url/);
    });
});
