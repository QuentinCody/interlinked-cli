import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { interlinkedPath } from "../../lib/interlinked-path.js";
import { DEFAULT_SEMANTIC_MODEL_ALIAS, findModel, modelReference } from "./model-registry.js";
import type {
    EmbeddingModelManifest,
    ResolvedSemanticConfig,
    SemanticLocalConfig,
    SemanticTeamConfig,
} from "./types.js";

function defaultManifest(): EmbeddingModelManifest {
    const manifest = findModel(DEFAULT_SEMANTIC_MODEL_ALIAS);
    if (manifest === undefined) throw new Error("default semantic model is missing from the registry");
    return manifest;
}

export function defaultSemanticTeamConfig(): SemanticTeamConfig {
    return {
        version: 1,
        enabled: false,
        model: modelReference(defaultManifest()),
        include_tests: false,
        include: ["src/**"],
        exclude: [],
    };
}

function defaultSemanticLocalConfig(): SemanticLocalConfig {
    return {
        version: 1,
        device: "auto",
        threads: 0,
        batch_size: 0,
        idle_unload_ms: 300_000,
        incremental_indexing: true,
    };
}

function readObject(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must contain a JSON object`);
    }
    return value as Record<string, unknown>;
}

function stringArray(value: unknown, fallback: string[], label: string): string[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new Error(`${label} must be an array of strings`);
    }
    return value as string[];
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return value as number;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`${label} contains unsupported key(s): ${unknown.join(", ")}`);
}

function parseTeam(raw: Record<string, unknown> | undefined): SemanticTeamConfig {
    const defaults = defaultSemanticTeamConfig();
    if (raw === undefined) return defaults;
    rejectUnknownKeys(raw, new Set(["version", "enabled", "model", "include_tests", "include", "exclude"]), "semantic.json");
    if (raw.version !== 1) throw new Error("semantic.json version must be 1");
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        throw new Error("semantic.enabled must be boolean");
    }
    if (raw.model !== undefined && typeof raw.model !== "string") {
        throw new Error("semantic.model must be a string");
    }
    if (raw.include_tests !== undefined && typeof raw.include_tests !== "boolean") {
        throw new Error("semantic.include_tests must be boolean");
    }
    return {
        version: 1,
        enabled: raw.enabled ?? defaults.enabled,
        model: raw.model ?? defaults.model,
        include_tests: raw.include_tests ?? defaults.include_tests,
        include: stringArray(raw.include, defaults.include, "semantic.include"),
        exclude: stringArray(raw.exclude, defaults.exclude, "semantic.exclude"),
    };
}

function optionalCommand(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}

function parseLocal(raw: Record<string, unknown> | undefined): SemanticLocalConfig {
    const defaults = defaultSemanticLocalConfig();
    if (raw === undefined) return defaults;
    rejectUnknownKeys(raw, new Set([
        "version",
        "device",
        "threads",
        "batch_size",
        "idle_unload_ms",
        "incremental_indexing",
        "llama_embedding_command",
        "llama_tokenize_command",
    ]), "semantic.local.json");
    if (raw.version !== 1) throw new Error("semantic.local.json version must be 1");
    const device = raw.device ?? defaults.device;
    if (device !== "auto" && device !== "cpu") throw new Error("semantic.device must be auto or cpu");
    const incremental = raw.incremental_indexing ?? defaults.incremental_indexing;
    if (typeof incremental !== "boolean") throw new Error("semantic.incremental_indexing must be boolean");
    const parsed: SemanticLocalConfig = {
        version: 1,
        device,
        threads: nonNegativeInteger(raw.threads, defaults.threads, "semantic.threads"),
        batch_size: nonNegativeInteger(raw.batch_size, defaults.batch_size, "semantic.batch_size"),
        idle_unload_ms: nonNegativeInteger(raw.idle_unload_ms, defaults.idle_unload_ms, "semantic.idle_unload_ms"),
        incremental_indexing: incremental,
    };
    const embeddingCommand = optionalCommand(raw.llama_embedding_command, "semantic.llama_embedding_command");
    const tokenizeCommand = optionalCommand(raw.llama_tokenize_command, "semantic.llama_tokenize_command");
    if (embeddingCommand !== undefined) parsed.llama_embedding_command = embeddingCommand;
    if (tokenizeCommand !== undefined) parsed.llama_tokenize_command = tokenizeCommand;
    return parsed;
}

export function loadSemanticConfig(root: string): ResolvedSemanticConfig {
    const team = parseTeam(readObject(interlinkedPath(root, "semantic.json")));
    const local = parseLocal(readObject(interlinkedPath(root, "semantic.local.json")));
    const manifest = findModel(team.model);
    if (manifest === undefined || modelReference(manifest) !== team.model) {
        throw new Error(`semantic model must name an exact registry revision: ${team.model}`);
    }
    return { team, local, manifest };
}

function semanticModelCacheRoot(): string {
    const override = process.env.INTERLINKED_MODEL_CACHE?.trim();
    if (override) return override;
    if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "interlinked", "models");
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        return join(process.env.LOCALAPPDATA, "interlinked", "models");
    }
    return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "interlinked", "models");
}

export function modelArtifactPath(manifest: EmbeddingModelManifest): string {
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) throw new Error(`model ${manifest.alias} has no artifact`);
    return join(semanticModelCacheRoot(), manifest.alias, manifest.revision, artifact.fileName);
}
