import { resolve } from "node:path";
import { buildSemanticIndex } from "../harness/semantic/index-builder.js";
import { semanticIndexStatus } from "../harness/semantic/index-status.js";
import {
    installSemanticModel,
    semanticModelInstalled,
    verifySemanticModelArtifact,
} from "../harness/semantic/model-install.js";
import {
    EMBEDDING_MODEL_REGISTRY,
    findModel,
    modelFingerprint,
    modelReference,
} from "../harness/semantic/model-registry.js";
import { semanticSearch, semanticSimilar, type SemanticSearchResponse } from "../harness/semantic/search.js";
import { modelArtifactPath } from "../harness/semantic/config.js";

interface CommonOptions {
    cwd?: string;
    json?: boolean;
}

function rootFor(options: CommonOptions): string {
    return resolve(options.cwd ?? process.cwd());
}

function printError(error: unknown, json: boolean): number {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ schemaVersion: 1, ok: false, error: message }, null, 2));
    else console.error(`error: ${message}`);
    return 1;
}

export async function semanticModelsAction(options: CommonOptions): Promise<number> {
    const models = await Promise.all(EMBEDDING_MODEL_REGISTRY.map(async (manifest) => ({
        alias: manifest.alias,
        reference: modelReference(manifest),
        modelId: manifest.modelId,
        revision: manifest.revision,
        installed: semanticModelInstalled(manifest),
        verified: await verifySemanticModelArtifact(manifest),
        bytes: manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0),
        license: manifest.license,
        dimension: manifest.dimension,
        maxInputTokens: manifest.maxInputTokens,
        quantization: manifest.quantization,
        runtime: manifest.runtime,
        fingerprint: modelFingerprint(manifest),
        experimental: manifest.experimental,
    })));
    if (options.json) {
        console.log(JSON.stringify({ schemaVersion: 1, localOnly: true, models }, null, 2));
        return 0;
    }
    console.log("Local semantic models (explicit install; no automatic downloads):");
    for (const model of models) {
        const size = (model.bytes / 1_000_000).toFixed(1);
        console.log(`  ${model.alias}  ${model.installed ? "installed" : "not installed"}  ${size} MB  ${model.dimension}d  ${model.maxInputTokens} context`);
        console.log(`    ${model.license} · ${model.quantization} · revision ${model.revision}${model.experimental ? " · experimental" : ""}`);
    }
    return 0;
}

export async function semanticInstallAction(model: string, options: CommonOptions): Promise<number> {
    const manifest = findModel(model);
    if (manifest === undefined) return printError(`unknown semantic model: ${model}`, options.json === true);
    const bytes = manifest.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
    if (!options.json) {
        console.log(`Installing ${manifest.modelId}@${manifest.revision}`);
        console.log(`  Size: ${(bytes / 1_000_000).toFixed(1)} MB · License: ${manifest.license}`);
        console.log(`  Source: ${manifest.artifacts[0]?.url ?? "unavailable"}`);
        console.log(`  Target: ${modelArtifactPath(manifest)}`);
    }
    try {
        const result = await installSemanticModel(manifest);
        const output = { schemaVersion: 1, ok: true, model: modelReference(manifest), ...result };
        if (options.json) console.log(JSON.stringify(output, null, 2));
        else console.log(result.reused ? "Model already verified." : "Model downloaded, hash-verified, and installed atomically.");
        return 0;
    } catch (error) {
        return printError(error, options.json === true);
    }
}

export async function semanticIndexAction(
    options: CommonOptions & { rebuild?: boolean; includeTests?: boolean },
): Promise<number> {
    try {
        const result = await buildSemanticIndex(rootFor(options), {
            ...(options.rebuild === true ? { rebuild: true } : {}),
            ...(options.includeTests === true ? { includeTests: true } : {}),
        });
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else {
            console.log(`Semantic index ${result.generation} built locally (${result.functions} functions).`);
            console.log(`  direct ${result.direct} · aggregated ${result.aggregated} · reused ${result.reused} · not indexed ${result.notIndexed} · unsupported files ${result.unsupported}`);
            console.log(`  fingerprint ${result.fingerprint}${result.durationMs > 0 ? ` · ${result.durationMs} ms` : ""}`);
            for (const item of result.notIndexedReasons.slice(0, 5)) {
                console.log(`  not indexed: ${item.file}::${item.symbol} — ${item.reason}`);
            }
        }
        return 0;
    } catch (error) {
        return printError(error, options.json === true);
    }
}

export async function semanticStatusAction(options: CommonOptions): Promise<number> {
    try {
        const status = await semanticIndexStatus(rootFor(options));
        if (options.json) console.log(JSON.stringify(status, null, 2));
        else {
            console.log(`Semantic index: ${status.state}`);
            console.log(`  fingerprint ${status.modelFingerprint}`);
            if (status.generation !== null) console.log(`  generation ${status.generation}`);
            if (status.meta !== null) {
                console.log(`  ${status.meta.functionCount} vectors · direct ${status.meta.direct} · aggregated ${status.meta.aggregated} · local-only${status.meta.experimental ? " · experimental" : ""}`);
            }
            if (status.reason !== null) console.log(`  ${status.reason}`);
        }
        return ["corrupt", "model-mismatch", "measurement-mismatch"].includes(status.state) ? 1 : 0;
    } catch (error) {
        return printError(error, options.json === true);
    }
}

function printSearch(response: SemanticSearchResponse, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(response, null, 2));
        return;
    }
    if (response.stale) console.log("warning: semantic index is stale; results use the last complete generation");
    console.log(`Exact cosine results · fingerprint ${response.fingerprint}`);
    for (const result of response.results) {
        const chunks = result.chunkCount > 1 ? ` · ${result.chunkCount} chunks` : "";
        console.log(`  ${result.rank}. ${result.score.toFixed(4)}  ${result.file}:${result.line}-${result.endLine}  ${result.symbol}`);
        console.log(`     ${result.language} · ${result.canonicalTokens} canonical tokens · ${result.modelTokens} model tokens${chunks}`);
    }
}

export async function semanticSearchAction(
    query: string,
    options: CommonOptions & { top?: string; language?: string; path?: string },
): Promise<number> {
    try {
        const top = options.top === undefined ? undefined : Number(options.top);
        if (top !== undefined && (!Number.isInteger(top) || top < 1 || top > 100)) throw new Error("--top must be an integer from 1 to 100");
        const response = await semanticSearch(rootFor(options), query, {
            ...(top !== undefined ? { top } : {}),
            ...(options.language !== undefined ? { language: options.language } : {}),
            ...(options.path !== undefined ? { path: options.path } : {}),
        });
        printSearch(response, options.json === true);
        return 0;
    } catch (error) {
        return printError(error, options.json === true);
    }
}

export async function semanticSimilarAction(
    file: string,
    options: CommonOptions & { line: string; top?: string },
): Promise<number> {
    try {
        const line = Number(options.line);
        const top = options.top === undefined ? undefined : Number(options.top);
        if (top !== undefined && (!Number.isInteger(top) || top < 1 || top > 100)) throw new Error("--top must be an integer from 1 to 100");
        const response = await semanticSimilar(rootFor(options), file, line, top === undefined ? {} : { top });
        printSearch(response, options.json === true);
        return 0;
    } catch (error) {
        return printError(error, options.json === true);
    }
}
