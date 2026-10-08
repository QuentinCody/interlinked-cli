import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loopbackUrl } from "./config.js";
import { digest, privateDirectory, saveImmutable } from "./store.js";
import type { DecisionConfig } from "./types.js";

const MAX_OUTPUT_BYTES = 4000000;
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
}

export function runCommand(
    command: string,
    args: string[],
    options: { timeoutMs: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            shell: false,
            stdio: "pipe",
            env: options.env ?? { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
        });
        let stdout = "",
            stderr = "",
            timedOut = false,
            overflow = false;
        const timer = setTimeout(
            () => {
                timedOut = true;
                child.kill("SIGKILL");
            },
            Math.max(1, options.timeoutMs),
        );
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
            stdout += text;
            if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
                overflow = true;
                child.kill("SIGKILL");
            }
        });
        child.stderr.on("data", (text: string) => {
            stderr += text;
            if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
                overflow = true;
                child.kill("SIGKILL");
            }
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (exitCode) => {
            clearTimeout(timer);
            if (overflow) reject(new Error("decision command output exceeded budget"));
            else resolve({ stdout, stderr, exitCode, timedOut });
        });
        child.stdin.on("error", () => {
            /* A closed child is reported by close/error above. */
        });
        child.stdin.end(options.input ?? "");
    });
}

async function readRequest(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > limit) throw new Error("request exceeds byte budget");
        chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function boundedResponse(
    response: Response,
    limit = MAX_OUTPUT_BYTES,
): Promise<string> {
    if (!response.body) throw new Error("empty backend response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) return Buffer.concat(chunks).toString("utf8");
            size += next.value.length;
            if (size > limit) throw new Error("backend response exceeds byte budget");
            chunks.push(next.value);
        }
    } finally {
        await reader.cancel();
    }
}

function upstreamHeaders(config: DecisionConfig): Record<string, string> {
    const variables = {
        typesafe: "TYPESAFE_API_KEY",
        liquid: "LIQUID_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        perplexity: "PERPLEXITY_API_KEY",
        ollama: "OLLAMA_API_KEY",
    };
    const key = process.env[variables[config.backend]];
    return {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
    };
}

async function forwardRequest(
    req: IncomingMessage,
    res: ServerResponse,
    config: DecisionConfig,
    folder: string,
    deadline: number,
): Promise<void> {
    if (req.method !== "POST" || req.url !== "/v1/systemone") {
        res.writeHead(404);
        res.end();
        return;
    }
    const requestBody = await readRequest(req, config.maxRequestBytes);
    const requestHash = digest(requestBody);
    const id = randomUUID();
    const target = `${config.url.replace(/\/$/, "")}/systemone`;
    const startedAt = new Date().toISOString();
    try {
        const response = await fetch(target, {
            method: "POST",
            headers: upstreamHeaders(config),
            body: requestBody,
            redirect: "error",
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        const responseBody = await boundedResponse(response);
        saveImmutable(join(folder, `${id}.json`), {
            requestBody,
            requestHash,
            responseBody,
            status: response.status,
            target,
            startedAt,
        });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(responseBody);
    } catch (error) {
        saveImmutable(join(folder, `${id}-failed.json`), {
            requestBody,
            requestHash,
            target,
            startedAt,
            status: "transport_failed",
        });
        throw new Error("decision backend exchange failed", { cause: error });
    }
}

export async function startRecorder(
    config: DecisionConfig,
    folder: string,
    deadline: number,
): Promise<{ url: string; close(): Promise<void> }> {
    loopbackUrl(config.url, config.allowRemote);
    privateDirectory(folder);
    const server = createServer((req, res) => {
        void forwardRequest(req, res, config, folder, deadline).catch(() => {
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end('{"error":"bounded decision exchange failed"}');
        });
    });
    server.requestTimeout = Math.max(1, deadline - Date.now());
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("recorder did not bind loopback");
    return {
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
