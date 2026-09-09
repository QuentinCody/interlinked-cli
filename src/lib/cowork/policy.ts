import { isJsonObject } from "../json-types.js";
import { posix } from "node:path";

export interface CoworkBridgeConfig {
    url: string;
    tokenEnv: string;
    workspace: string;
    timeoutMs: number;
}
export interface CoworkPolicy {
    schema: 1;
    mode: "guard" | "probe";
    deniedTools: string[];
    deniedPaths: string[];
    bridge?: CoworkBridgeConfig;
}
export const DEFAULT_COWORK_POLICY: CoworkPolicy = { schema: 1, mode: "guard", deniedTools: [], deniedPaths: [] };

function strings(value: unknown): string[] {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string" && item.length > 0)) throw new Error("Expected nonempty string entries");
    return value;
}

function deniedPaths(value: unknown): string[] {
    return strings(value).map(path => {
        if (!posix.isAbsolute(path) || path.includes("\0")) throw new Error("Denied paths must be absolute native paths");
        return posix.normalize(path);
    });
}

function bridgeUrl(value: string): string {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure = url.protocol === "https:" || (local && url.protocol === "http:");
    if (url.username || url.password || url.search || url.hash || !secure) throw new Error("Bridge requires HTTPS (HTTP permitted only on loopback), without embedded credentials");
    return url.href;
}

function bridge(value: unknown): CoworkBridgeConfig {
    if (!isJsonObject(value) || typeof value.url !== "string" || typeof value.tokenEnv !== "string" || typeof value.workspace !== "string") throw new Error("Invalid Cowork bridge configuration");
    if (!/^[A-Z_][A-Z0-9_]*$/.test(value.tokenEnv) || !value.workspace.trim()) throw new Error("Bridge requires a token environment variable and workspace id");
    const timeoutMs = value.timeoutMs ?? 5000;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error("Bridge timeout must be 100–10000 ms");
    return { url: bridgeUrl(value.url), tokenEnv: value.tokenEnv, workspace: value.workspace, timeoutMs };
}

/** Malformed policy never falls back to a permissive default. */
export function parseCoworkPolicy(value: unknown): CoworkPolicy {
    if (!isJsonObject(value) || value.schema !== 1 || !["guard", "probe"].includes(String(value.mode))) throw new Error("Invalid Cowork policy schema/mode");
    const known = new Set(["schema", "mode", "deniedTools", "deniedPaths", "bridge"]);
    if (Object.keys(value).some(key => !known.has(key))) throw new Error("Unknown Cowork policy field");
    return { schema: 1, mode: value.mode === "probe" ? "probe" : "guard", deniedTools: strings(value.deniedTools), deniedPaths: deniedPaths(value.deniedPaths),
        ...(value.bridge === undefined ? {} : { bridge: bridge(value.bridge) }) };
}
