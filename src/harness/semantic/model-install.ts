import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { modelArtifactPath } from "./config.js";
import type { EmbeddingArtifactManifest, EmbeddingModelManifest } from "./types.js";

const MAX_REDIRECTS = 4;

interface VerificationCacheEntry {
    size: number;
    mtimeMs: number;
    sha256: string;
}

const verificationCache = new Map<string, VerificationCacheEntry>();

function allowedArtifactUrl(url: URL): boolean {
    if (url.protocol !== "https:") return false;
    return url.hostname === "huggingface.co" || url.hostname.endsWith(".hf.co");
}

async function fetchArtifact(url: string, redirects = 0): Promise<Response> {
    const parsed = new URL(url);
    if (!allowedArtifactUrl(parsed)) throw new Error(`model artifact host is not allowlisted: ${parsed.hostname}`);
    const response = await fetch(parsed, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
        if (redirects >= MAX_REDIRECTS) throw new Error("model artifact exceeded redirect limit");
        const location = response.headers.get("location");
        if (location === null) throw new Error("model artifact redirect has no location");
        return fetchArtifact(new URL(location, parsed).toString(), redirects + 1);
    }
    if (!response.ok || response.body === null) {
        throw new Error(`model artifact download failed: HTTP ${response.status}`);
    }
    return response;
}

async function hashFile(path: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on("data", (chunk: string | Buffer) => {
            hash.update(chunk);
        });
        stream.on("error", reject);
        stream.on("end", resolve);
    });
    return hash.digest("hex");
}

async function existingArtifactIsValid(path: string, artifact: EmbeddingArtifactManifest): Promise<boolean> {
    if (!existsSync(path) || statSync(path).size !== artifact.bytes) return false;
    return (await hashFile(path)) === artifact.sha256;
}

async function streamVerifiedArtifact(response: Response, artifact: EmbeddingArtifactManifest, target: string): Promise<void> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== artifact.bytes) {
        throw new Error(`model artifact size mismatch: expected ${artifact.bytes}, server declared ${declaredLength}`);
    }
    const temporary = `${target}.tmp-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o600);
    let bytes = 0;
    const hash = createHash("sha256");
    try {
        const reader = response.body?.getReader();
        if (reader === undefined) throw new Error("model artifact response has no body");
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > artifact.bytes) throw new Error("model artifact exceeded pinned size");
            hash.update(next.value);
            await handle.write(next.value);
        }
        await handle.sync();
        await handle.close();
        if (bytes !== artifact.bytes) throw new Error(`model artifact size mismatch: expected ${artifact.bytes}, got ${bytes}`);
        if (hash.digest("hex") !== artifact.sha256) throw new Error("model artifact SHA-256 mismatch");
        if (existsSync(target)) unlinkSync(target);
        renameSync(temporary, target);
    } catch (error) {
        await handle.close().catch(() => undefined);
        if (existsSync(temporary)) unlinkSync(temporary);
        throw error;
    }
}

function writeVerificationMarker(manifest: EmbeddingModelManifest, target: string): void {
    const marker = `${target}.verified.json`;
    const temporary = `${marker}.tmp-${randomUUID()}`;
    writeFileSync(temporary, `${JSON.stringify({
        version: 1,
        modelId: manifest.modelId,
        revision: manifest.revision,
        artifactSha256: manifest.artifacts[0]?.sha256,
        verifiedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, marker);
}

export async function installSemanticModel(manifest: EmbeddingModelManifest): Promise<{ path: string; bytes: number; reused: boolean }> {
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) throw new Error(`model ${manifest.alias} has no downloadable artifact`);
    const target = modelArtifactPath(manifest);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (await existingArtifactIsValid(target, artifact)) {
        writeVerificationMarker(manifest, target);
        return { path: target, bytes: artifact.bytes, reused: true };
    }
    const response = await fetchArtifact(artifact.url);
    await streamVerifiedArtifact(response, artifact, target);
    writeVerificationMarker(manifest, target);
    return { path: target, bytes: artifact.bytes, reused: false };
}

export function semanticModelInstalled(manifest: EmbeddingModelManifest): boolean {
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) return false;
    const target = modelArtifactPath(manifest);
    if (!existsSync(target) || !existsSync(`${target}.verified.json`)) return false;
    return statSync(target).size === artifact.bytes;
}

export async function verifySemanticModelArtifact(manifest: EmbeddingModelManifest): Promise<boolean> {
    const artifact = manifest.artifacts[0];
    if (artifact === undefined) return false;
    const target = modelArtifactPath(manifest);
    if (!semanticModelInstalled(manifest)) return false;
    const stat = statSync(target);
    const cached = verificationCache.get(target);
    if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.sha256 === artifact.sha256;
    }
    const digest = await hashFile(target);
    verificationCache.set(target, { size: stat.size, mtimeMs: stat.mtimeMs, sha256: digest });
    return digest === artifact.sha256;
}
