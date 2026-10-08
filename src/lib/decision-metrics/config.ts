import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { object } from "./answers.js";
import { CATALOG } from "./contracts.js";
import type { Band, DecisionConfig } from "./types.js";

export function decisionChildEnvironment(backend: DecisionConfig["backend"]): NodeJS.ProcessEnv {
    const keys = {
        typesafe: "TYPESAFE_API_KEY",
        liquid: "LIQUID_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        perplexity: "PERPLEXITY_API_KEY",
        ollama: "OLLAMA_API_KEY",
    };
    // Only the recorder receives the real upstream credential; the child uses loopback.
    return {
        PATH: process.env.PATH,
        LANG: "en_US.UTF-8",
        [keys[backend]]: "interlinked-loopback-proxy",
    };
}

export const DEFAULT_CONFIG: DecisionConfig = {
    version: 1,
    enabled: false,
    command: "thinkthen",
    backend: "ollama",
    url: "http://127.0.0.1:11434/v1",
    model: "clef-flash:9b",
    allowRemote: false,
    band: [0.2, 0.8],
    metrics: ["behavior_change", "name_matches"],
    deadlineMs: 120000,
    maxRecords: 100,
    maxEvidenceBytes: 24000,
    maxRequestBytes: 60000,
    embeddingModel: "embeddinggemma-2:740m-bf16",
    ollamaUrl: "http://127.0.0.1:11434",
    hook: { enabled: false, deadlineMs: 1500, maxRecords: 2, metrics: ["name_matches"] },
};

export function parseBand(value: unknown): Band {
    if (typeof value === "string" && value.split(":").some((part) => !part.trim()))
        throw new Error("band endpoints must be explicit numbers");
    const parts: unknown[] =
        typeof value === "string"
            ? value.split(":").map(Number)
            : Array.isArray(value)
              ? value
              : [];
    const [low, high] = parts;
    if (
        parts.length !== 2 ||
        typeof low !== "number" ||
        typeof high !== "number" ||
        !Number.isFinite(low) ||
        !Number.isFinite(high) ||
        low < 0 ||
        high > 1 ||
        low > high
    )
        throw new Error("band must be LOW:HIGH within [0,1]");
    return [low, high];
}

export function loopbackUrl(value: string, allowRemote = false): URL {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
        throw new Error("endpoint must not contain credentials, query or fragment");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!local && !allowRemote) throw new Error("remote inference requires allowRemote: true");
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
        throw new Error("remote inference requires HTTPS");
    return url;
}

function positive(value: unknown, key: string, max: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
        throw new Error(`${key} must be an integer from 1 to ${max}`);
    return value;
}

function metrics(value: unknown): string[] {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((id) => typeof id !== "string" || !Object.hasOwn(CATALOG, id))
    )
        throw new Error("metrics must name known contracts");
    return [...new Set(value as string[])]; // SAFETY: every entry checked above.
}

function knownKeys(input: Record<string, unknown>, defaults: object): void {
    const invalid = Object.keys(input).find((key) => !Object.hasOwn(defaults, key));
    if (invalid) throw new Error(`unknown config key: ${invalid}`);
}

function validateScalars(input: Record<string, unknown>): void {
    for (const key of ["enabled", "allowRemote"]) {
        if (typeof input[key] !== "boolean") throw new Error(`invalid ${key}`);
    }
    for (const key of ["command", "url", "model", "embeddingModel", "ollamaUrl"]) {
        const value = input[key];
        if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${key}`);
    }
    if (
        !["ollama", "typesafe", "liquid", "openrouter", "perplexity"].includes(
            String(input.backend),
        )
    )
        throw new Error("unsupported backend");
}

function parseHook(value: unknown): DecisionConfig["hook"] {
    const hook = { ...DEFAULT_CONFIG.hook, ...object(value ?? {}) };
    knownKeys(hook, DEFAULT_CONFIG.hook);
    if (typeof hook.enabled !== "boolean") throw new Error("invalid hook.enabled");
    for (const id of metrics(hook.metrics))
        if (CATALOG[id]!.unit !== "function")
            throw new Error(
                "hook metrics must be per-function contracts; run relational/hunk measurements explicitly",
            );
    return {
        enabled: hook.enabled,
        metrics: metrics(hook.metrics),
        deadlineMs: positive(hook.deadlineMs, "hook deadline", 10000),
        maxRecords: positive(hook.maxRecords, "hook records", 10),
    };
}

export function parseConfig(value: unknown): DecisionConfig {
    const input = object(value);
    knownKeys(input, DEFAULT_CONFIG);
    if (input.version !== 1) throw new Error("decision config version must be 1");
    const merged = { ...DEFAULT_CONFIG, ...input };
    validateScalars(merged);
    // SAFETY: scalar types checked above; nested fields validated below.
    const config = merged as DecisionConfig;
    loopbackUrl(config.url, config.allowRemote);
    loopbackUrl(config.ollamaUrl);
    validateLocalEndpoints(config);
    config.band = parseBand(config.band);
    config.metrics = metrics(config.metrics);
    config.deadlineMs = positive(config.deadlineMs, "deadlineMs", 3600000);
    config.maxRecords = positive(config.maxRecords, "maxRecords", 10000);
    config.maxEvidenceBytes = positive(config.maxEvidenceBytes, "maxEvidenceBytes", 96000);
    config.maxRequestBytes = positive(config.maxRequestBytes, "maxRequestBytes", 96000);
    config.hook = parseHook(input.hook);
    return config;
}

function validateLocalEndpoints(config: DecisionConfig): void {
    if (config.backend !== "ollama") return;
    const api = loopbackUrl(config.ollamaUrl),
        decision = loopbackUrl(config.url);
    const expectedPath = `${api.pathname.replace(/\/$/, "")}/v1`;
    if (
        api.port !== decision.port ||
        api.protocol !== decision.protocol ||
        decision.pathname.replace(/\/$/, "") !== expectedPath
    )
        throw new Error("Ollama decision endpoint must match the coordinated ollamaUrl/v1");
}

export function readDecisionConfig(root: string): DecisionConfig {
    const path = join(root, ".interlinked", "decision-metrics.json");
    return parseConfig(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1 });
}
