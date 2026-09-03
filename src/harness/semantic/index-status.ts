import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadSemanticConfig, modelArtifactPath } from "./config.js";
import { discoverSemanticSources, semanticSourceHash } from "./index-discovery.js";
import { semanticModelInstalled, verifySemanticModelArtifact } from "./model-install.js";
import { createLlamaRuntime } from "./runtime.js";
import type { ResolvedSemanticConfig, SemanticStatus } from "./types.js";
import { loadSemanticIndex, semanticBuildInProgress, semanticIndexRoot } from "./vector-store.js";

async function resolveMissingIndexStatus(config: ResolvedSemanticConfig, expectedModel: string): Promise<SemanticStatus> {
    const installed = semanticModelInstalled(config.manifest);
    const verified = installed && await verifySemanticModelArtifact(config.manifest);
    const state = verified ? "absent" : "model-missing";
    return {
        schemaVersion: 1,
        state,
        generation: null,
        modelFingerprint: expectedModel,
        reason: state === "model-missing"
            ? installed
                ? "the configured model artifact failed SHA-256 verification"
                : `model artifact is absent from ${modelArtifactPath(config.manifest)}`
            : null,
        meta: null,
    };
}

export async function semanticIndexStatus(root: string): Promise<SemanticStatus> {
    const config = loadSemanticConfig(root);
    const expectedModel = `${config.manifest.alias}@${config.manifest.revision}`;
    if (semanticBuildInProgress(root)) {
        return { schemaVersion: 1, state: "building", generation: null, modelFingerprint: expectedModel, reason: null, meta: null };
    }
    if (!existsSync(join(semanticIndexRoot(root), "CURRENT"))) {
        return await resolveMissingIndexStatus(config, expectedModel);
    }
    let index;
    try {
        index = loadSemanticIndex(root);
    } catch (error) {
        return {
            schemaVersion: 1,
            state: "corrupt",
            generation: null,
            modelFingerprint: expectedModel,
            reason: error instanceof Error ? error.message : String(error),
            meta: null,
        };
    }
    if (!semanticModelInstalled(config.manifest)) {
        return {
            schemaVersion: 1,
            state: "model-missing",
            generation: index.generation,
            modelFingerprint: index.meta.modelFingerprint,
            reason: "the index is readable, but its configured model artifact is not installed",
            meta: index.meta,
        };
    }
    if (!(await verifySemanticModelArtifact(config.manifest))) {
        return {
            schemaVersion: 1,
            state: "model-missing",
            generation: index.generation,
            modelFingerprint: index.meta.modelFingerprint,
            reason: "the configured model artifact failed SHA-256 verification",
            meta: index.meta,
        };
    }
    let runtimeFingerprint: string;
    try {
        runtimeFingerprint = (await createLlamaRuntime(config.manifest, config.local)).fingerprint;
    } catch (error) {
        return {
            schemaVersion: 1,
            state: "runtime-missing",
            generation: index.generation,
            modelFingerprint: index.meta.modelFingerprint,
            reason: error instanceof Error ? error.message : String(error),
            meta: index.meta,
        };
    }
    if (runtimeFingerprint !== index.meta.modelFingerprint) {
        return {
            schemaVersion: 1,
            state: "model-mismatch",
            generation: index.generation,
            modelFingerprint: runtimeFingerprint,
            reason: "active model/runtime fingerprint differs from the index generation",
            meta: index.meta,
        };
    }
    const sources = discoverSemanticSources(root, config.team, index.meta.includeTests);
    const stale = semanticSourceHash(sources) !== index.meta.sourceHash;
    return {
        schemaVersion: 1,
        state: stale ? "stale" : "current",
        generation: index.generation,
        modelFingerprint: runtimeFingerprint,
        reason: stale ? "source content changed after the active generation was built" : null,
        meta: index.meta,
    };
}
