import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelArtifactPath } from "./config.js";
import { modelFingerprint } from "./model-registry.js";
import { verifySemanticModelArtifact } from "./model-install.js";
import type { EmbeddingModelManifest, LocalEmbeddingRuntime, SemanticLocalConfig } from "./types.js";

interface ProcessResult {
    stdout: string;
    stderr: string;
}

async function runProcess(command: string, args: string[], stdin = "", timeoutMs = 120_000): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`${command} timed out`));
        }, timeoutMs);
        const collect = (target: Buffer[], chunk: Buffer): void => {
            outputBytes += chunk.length;
            if (outputBytes > 64 * 1024 * 1024) child.kill("SIGKILL");
            else target.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`unable to start ${command}: ${error.message}`));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
            if (outputBytes > 64 * 1024 * 1024) reject(new Error(`${command} exceeded output limit`));
            else if (code !== 0) reject(new Error(`${command} exited ${code}: ${result.stderr.trim()}`));
            else resolve(result);
        });
        child.stdin.end(stdin);
    });
}

function runtimeVersionIdentity(result: ProcessResult): string {
    const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map(line => line.trim());
    const version = lines.find(line => /^version:\s+\S/.test(line));
    if (version === undefined) throw new Error("embedding runtime did not report a version identity");
    const build = lines.find(line => /^built with\s+\S/.test(line));
    // Backend initialization can include elapsed timings and device diagnostics.
    // Only explicit version/build evidence identifies the runtime across processes.
    return build === undefined ? version : `${version}\n${build}`;
}

function runtimeArgs(config: SemanticLocalConfig, manifest: EmbeddingModelManifest): string[] {
    const batchSize = config.batch_size > 0 ? config.batch_size : manifest.maxInputTokens;
    if (batchSize < manifest.maxInputTokens) {
        throw new Error(`semantic batch_size must be at least the model context (${manifest.maxInputTokens})`);
    }
    // Non-causal embedding requires an entire sequence in one physical batch.
    // Native defaults (2048 for nomic) can be smaller than the registry context.
    const args: string[] = ["--ctx-size", String(manifest.maxInputTokens),
        "--batch-size", String(batchSize), "--ubatch-size", String(batchSize)];
    if (config.threads > 0) args.push("--threads", String(config.threads));
    if (config.device === "cpu") args.push("--gpu-layers", "0");
    return args;
}

function countFromOutput(output: string): number {
    const explicit = /total number of tokens:\s*(\d+)/i.exec(output);
    if (explicit !== null) return Number(explicit[1]);
    const trimmed = output.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    throw new Error("llama-tokenize returned an unrecognized token-count response");
}

function parseVectors(output: string, expected: number, dimension: number): Float32Array[] {
    if (output.trim().length === 0) throw new Error("embedding runtime returned empty stdout");
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed) || parsed.length !== expected) {
        throw new Error(`embedding runtime returned ${Array.isArray(parsed) ? parsed.length : "non-array"} vectors; expected ${expected}`);
    }
    return parsed.map((value, index) => {
        if (!Array.isArray(value) || value.length !== dimension || !value.every((item): item is number => typeof item === "number" && Number.isFinite(item))) {
            throw new Error(`embedding ${index} is not a finite ${dimension}-dimension vector`);
        }
        const vector = Float32Array.from(value);
        if (!vector.every(Number.isFinite)) {
            throw new Error(`embedding ${index} is not a finite ${dimension}-dimension float32 vector`);
        }
        return vector;
    });
}

async function withPromptFile<T>(content: string, action: (path: string) => Promise<T>): Promise<T> {
    mkdirSync(tmpdir(), { recursive: true });
    const directory = mkdtempSync(join(tmpdir(), "interlinked-semantic-"));
    const path = join(directory, "prompt.txt");
    writeFileSync(path, content, { mode: 0o600 });
    try {
        return await action(path);
    } finally {
        unlinkSync(path);
        rmdirSync(directory);
    }
}

function uniqueSeparator(inputs: string[]): string {
    for (;;) {
        const marker = `<|interlinked:${randomUUID()}|>`;
        if (inputs.every((input) => !input.includes(marker))) return marker;
    }
}

export async function createLlamaRuntime(
    manifest: EmbeddingModelManifest,
    config: SemanticLocalConfig,
): Promise<LocalEmbeddingRuntime> {
    if (!(await verifySemanticModelArtifact(manifest))) {
        throw new Error("semantic model artifact is missing or failed SHA-256 verification");
    }
    const embeddingCommand = config.llama_embedding_command ?? "llama-embedding";
    const tokenizeCommand = config.llama_tokenize_command ?? "llama-tokenize";
    const effectiveArgs = runtimeArgs(config, manifest);
    const version = await runProcess(embeddingCommand, ["--version"], "", 10_000);
    const versionIdentity = runtimeVersionIdentity(version);
    const fingerprint = createHash("sha256")
        .update(`${modelFingerprint(manifest)}\n${versionIdentity}\nembedding-args-v2:${JSON.stringify(effectiveArgs)}`)
        .digest("hex");
    const modelPath = modelArtifactPath(manifest);
    const modelArgs = ["--model", modelPath];
    // llama-embedding 8860 emits its JSON payload through the logging machinery:
    // --log-disable suppresses embeddings too. Diagnostics are captured on stderr.
    const embeddingArgs = [...modelArgs, ...effectiveArgs];
    return {
        fingerprint,
        async countTokens(input: string): Promise<number> {
            const result = await runProcess(tokenizeCommand, [...modelArgs, "--stdin", "--show-count"], input);
            return countFromOutput(result.stdout);
        },
        async embed(inputs: string[]): Promise<Float32Array[]> {
            if (inputs.length === 0) return [];
            const separator = uniqueSeparator(inputs);
            return withPromptFile(inputs.join(separator), async (path) => {
                const result = await runProcess(embeddingCommand, [
                    ...embeddingArgs,
                    "--file", path,
                    "--pooling", manifest.pooling === "model-native" ? "mean" : manifest.pooling,
                    "--embd-normalize", "2",
                    "--embd-output-format", "array",
                    "--embd-separator", separator,
                    "--no-warmup",
                ]);
                return parseVectors(result.stdout, inputs.length, manifest.dimension);
            });
        },
    };
}
