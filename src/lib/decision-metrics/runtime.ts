import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { object } from "./answers.js";
import { loopbackUrl } from "./config.js";
import { digest, privateDirectory, readJson, saveImmutable } from "./store.js";
import { boundedResponse } from "./transport.js";
import type { DecisionConfig } from "./types.js";
import {
    formatEmbeddingInputs,
    isEmbeddingGemma2,
    type EmbeddingInput,
} from "./embedding-input.js";

export function residentPolicy(resident: string[], target: string, managed: string[]): string[] {
    const unrelated = resident.filter((model) => model !== target && !managed.includes(model));
    if (unrelated.length)
        throw new Error("unrelated local model is resident; defer decision inference");
    return resident.filter((model) => model !== target);
}

export async function ollamaJson(
    config: DecisionConfig,
    route: string,
    deadline: number,
    body?: unknown,
): Promise<Record<string, unknown>> {
    const base = loopbackUrl(config.ollamaUrl).toString().replace(/\/$/, "");
    const options: RequestInit = {
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    };
    if (body !== undefined) {
        options.method = "POST";
        options.headers = { "content-type": "application/json" };
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`${base}${route}`, options);
    if (!response.ok) throw new Error(`Ollama ${route} returned ${response.status}`);
    return object(JSON.parse(await boundedResponse(response, 16000000)));
}

async function residentModels(config: DecisionConfig, deadline: number): Promise<string[]> {
    const payload = await ollamaJson(config, "/api/ps", deadline);
    if (!Array.isArray(payload.models)) throw new Error("invalid Ollama residency response");
    return payload.models.map((value) => {
        const model = object(value).name;
        if (typeof model !== "string") throw new Error("invalid resident model name");
        return model;
    });
}

async function unload(config: DecisionConfig, model: string, deadline: number): Promise<void> {
    await ollamaJson(config, "/api/generate", deadline, { model, keep_alive: 0, stream: false });
}

export async function localModelIdentity(
    config: DecisionConfig,
    model: string,
    deadline: number,
): Promise<string> {
    const payload = await ollamaJson(config, "/api/tags", deadline);
    if (!Array.isArray(payload.models)) throw new Error("invalid Ollama model inventory");
    const entry = payload.models
        .map(object)
        .find((item) => item.name === model || item.model === model);
    if (!entry || typeof entry.digest !== "string" || !entry.digest)
        throw new Error(`local model not installed: ${model}`);
    return `${model}@${entry.digest}`;
}

export async function withLocalModel<T>(
    config: DecisionConfig,
    target: string,
    deadline: number,
    action: (identity: string) => Promise<T>,
): Promise<T> {
    const endpoint = loopbackUrl(config.ollamaUrl);
    const lock = join(
        tmpdir(),
        `interlinked-model-${digest(`${endpoint.protocol}:${endpoint.port || "default"}`).slice(0, 24)}.lock`,
    );
    try {
        mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
        throw new Error("local model coordinator is busy; defer this run", { cause: error });
    }
    try {
        writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, target }), {
            mode: 0o600,
        });
        const identity = await localModelIdentity(config, target, deadline);
        const resident = await residentModels(config, deadline);
        for (const model of residentPolicy(resident, target, [config.model, config.embeddingModel]))
            await unload(config, model, deadline);
        const remaining = await residentModels(config, deadline);
        if (remaining.some((model) => model !== target))
            throw new Error("local model unload not confirmed");
        try {
            return await action(identity);
        } finally {
            const cleanupDeadline = Date.now() + 5000;
            await unload(config, target, cleanupDeadline);
            if ((await residentModels(config, cleanupDeadline)).length)
                throw new Error("model remained resident after inference");
        }
    } finally {
        rmSync(lock, { recursive: true });
    }
}

export function validateVectors(value: unknown, count: number): number[][] {
    if (!Array.isArray(value) || value.length !== count)
        throw new Error("embedding cardinality mismatch");
    let dimension = 0;
    return value.map((vector) => {
        if (
            !Array.isArray(vector) ||
            vector.length === 0 ||
            vector.some((n) => typeof n !== "number" || !Number.isFinite(n))
        )
            throw new Error("invalid embedding vector");
        if (dimension && vector.length !== dimension)
            throw new Error("embedding dimension mismatch");
        dimension = vector.length;
        if (vector.every((n) => n === 0)) throw new Error("zero embedding vector");
        return vector as number[]; // SAFETY: all coordinates validated above.
    });
}

export async function embedTexts(
    config: DecisionConfig,
    texts: string[],
    deadline: number,
    cacheDirectory?: string,
): Promise<{ identity: string; vectors: number[][] }> {
    return withLocalModel(config, config.embeddingModel, deadline, async (identity) => {
        const vectors: (number[] | null)[] = texts.map((text) =>
            cachedVector(cacheDirectory, identity, text),
        );
        const missing = texts
            .map((text, i) => ({ text, i }))
            .filter((item) => vectors[item.i] === null);
        for (let offset = 0; offset < missing.length; offset += 4) {
            const batch = missing.slice(offset, offset + 4);
            const input = batch.map((item) => item.text);
            const response = await ollamaJson(config, "/api/embed", deadline, {
                model: config.embeddingModel,
                input,
                truncate: false,
                keep_alive: "1m",
                ...(isEmbeddingGemma2(config.embeddingModel) ? { options: { num_ctx: 8192 } } : {}),
            });
            const embedded = validateVectors(response.embeddings, input.length);
            for (const [index, item] of batch.entries()) {
                vectors[item.i] = embedded[index]!;
                if (cacheDirectory)
                    saveImmutable(vectorPath(cacheDirectory, identity, item.text), {
                        identity,
                        vector: embedded[index],
                    });
            }
        }
        return { identity, vectors: validateVectors(vectors, texts.length) };
    });
}

export async function embedInputs(
    config: DecisionConfig,
    inputs: EmbeddingInput[],
    deadline: number,
    cacheDirectory?: string,
): Promise<{ identity: string; modelIdentity: string; profile: string; vectors: number[][] }> {
    const formatted = formatEmbeddingInputs(config.embeddingModel, inputs);
    const result = await embedTexts(config, formatted.texts, deadline, cacheDirectory);
    if (
        isEmbeddingGemma2(config.embeddingModel) &&
        result.vectors.some((vector) => vector.length !== 768)
    )
        throw new Error("EmbeddingGemma 2 must return its full 768-dimensional representation");
    return {
        ...result,
        modelIdentity: result.identity,
        profile: formatted.profile,
        identity: `${result.identity}|${formatted.profile}`,
    };
}

function vectorPath(directory: string, identity: string, text: string): string {
    privateDirectory(directory);
    return join(directory, `${digest({ identity, text })}.json`);
}

function cachedVector(
    directory: string | undefined,
    identity: string,
    text: string,
): number[] | null {
    if (!directory) return null;
    const path = vectorPath(directory, identity, text);
    if (!existsSync(path)) return null;
    const cached = object(readJson(path));
    if (cached.identity !== identity) throw new Error("embedding cache identity mismatch");
    return validateVectors([cached.vector], 1)[0]!;
}
