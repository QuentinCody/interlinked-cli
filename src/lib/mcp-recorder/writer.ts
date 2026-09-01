// ===========================================
// MCP Recorder — local JSONL/blob writer
// ===========================================
// Best-effort local capture. This path must never break the mediated MCP
// transport, so write failures are swallowed after the proxy has computed
// the record.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../config.js";
import type { McpEventRecord, McpPayloadContentType, McpPayloadRef } from "./types.js";

export const DEFAULT_MCP_INLINE_LIMIT_BYTES = 256 * 1024;
const MCP_EVENTS_FILE = "mcp-events.jsonl";
const MCP_BLOB_PREVIEW_CHARS = 2048;

export interface CapturedMcpPayload {
    payload_bytes: number;
    payload_sha256: string;
    payload?: unknown;
    payload_ref?: McpPayloadRef;
    payload_preview?: string;
}

interface CaptureMcpPayloadOptions {
    cwd?: string;
    inlineLimitBytes?: number;
    contentType?: McpPayloadContentType;
}

export function getMcpEventsPath(cwd: string = process.cwd()): string {
    return join(getDataDir(cwd), MCP_EVENTS_FILE);
}

export function appendMcpEvent(record: McpEventRecord, cwd: string = process.cwd()): void {
    try {
        const filePath = getMcpEventsPath(cwd);
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    } catch {
        // MCP recording is best-effort and must not perturb the agent/client stream.
    }
}

export function captureMcpPayload(
    payload: unknown,
    opts: CaptureMcpPayloadOptions = {},
): CapturedMcpPayload {
    const contentType = opts.contentType ?? "application/json";
    const serialized = serializePayload(payload, contentType);
    const payloadBytes = Buffer.byteLength(serialized, "utf8");
    const payloadSha256 = sha256(serialized);
    const inlineLimitBytes = opts.inlineLimitBytes ?? DEFAULT_MCP_INLINE_LIMIT_BYTES;
    const captured: CapturedMcpPayload = {
        payload_bytes: payloadBytes,
        payload_sha256: payloadSha256,
    };

    if (payloadBytes <= inlineLimitBytes) {
        captured.payload = payload;
        return captured;
    }

    captured.payload_ref = writeMcpPayloadBlob({
        cwd: opts.cwd ?? process.cwd(),
        serialized,
        sha256Hex: payloadSha256,
        contentType,
    });
    captured.payload_preview = serialized.slice(0, MCP_BLOB_PREVIEW_CHARS);
    return captured;
}

function serializePayload(payload: unknown, contentType: McpPayloadContentType): string {
    if (contentType === "text/plain") {
        return String(payload);
    }
    // TS's own lib types declare `JSON.stringify`'s return as `string`, but it
    // genuinely returns `undefined` at runtime for `undefined`/a function/a
    // symbol (payload is `unknown` MCP call/response data, so any of those
    // are possible here). Erase to `unknown` and narrow for real so the
    // fallback below stays honest instead of being lint-dead.
    const stringified: unknown = JSON.stringify(payload);
    return typeof stringified === "string" ? stringified : "null";
}

function writeMcpPayloadBlob(args: {
    cwd: string;
    serialized: string;
    sha256Hex: string;
    contentType: McpPayloadContentType;
}): McpPayloadRef {
    const ext = args.contentType === "application/json" ? ".json" : ".txt";
    const relPath = join("blobs", "sha256", args.sha256Hex.slice(0, 2), `${args.sha256Hex}${ext}`);
    const absPath = join(getDataDir(args.cwd), relPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(absPath)) {
        writeFileSync(absPath, args.serialized);
    }
    return {
        kind: "sha256_blob",
        path: relPath,
        sha256: args.sha256Hex,
        bytes: Buffer.byteLength(args.serialized, "utf8"),
        content_type: args.contentType,
    };
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

