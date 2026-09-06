// ===========================================
// MCP Recorder — JSON-RPC line recorder
// ===========================================
// Captures JSON-RPC messages observed by the MCP proxy. It records every
// parsed message, including server-initiated client feature calls such as
// sampling/createMessage, elicitation/create, and roots/list.

import { buildCollectionRecord } from "../collection/builder.js";
import type { CollectionRecord } from "../collection/types.js";
import { appendCollection } from "../collection/writer.js";
import { isJsonObject } from "../json-types.js";
import type { JsonObject } from "../json-types.js";
import type {
    JsonRpcId,
    McpDirection,
    McpEventRecord,
    McpMessageType,
    McpPayloadContentType,
    McpTransport,
} from "./types.js";
import { appendMcpEvent, captureMcpPayload, DEFAULT_MCP_INLINE_LIMIT_BYTES } from "./writer.js";

interface PendingRequest {
    startedAtMs: number;
    method: string;
    toolCall?: PendingMcpToolCall;
}

interface JsonRpcMessageInfo {
    messageType: McpMessageType;
    method: string | null;
    id: JsonRpcId | undefined;
}

interface McpProtocolRecorderOptions {
    cwd?: string;
    serverName: string;
    transport: McpTransport;
    sessionId?: string | undefined;
    inlineLimitBytes?: number | undefined;
    now?: (() => Date) | undefined;
    clockMs?: (() => number) | undefined;
    append?: ((record: McpEventRecord, cwd: string) => void) | undefined;
    appendCollectionRecord?: ((record: CollectionRecord, cwd: string) => void) | undefined;
}

interface RecordMessageOptions {
    batchIndex?: number | undefined;
    batchSize?: number | undefined;
}

interface PendingMcpToolCall {
    providerTool: string;
    toolUseId: string;
    toolInput: JsonObject;
}

export class McpProtocolRecorder {
    private readonly cwd: string;
    private readonly serverName: string;
    private readonly transport: McpTransport;
    private readonly sessionId: string | null;
    private readonly inlineLimitBytes: number;
    private readonly now: () => Date;
    private readonly clockMs: () => number;
    private readonly append: (record: McpEventRecord, cwd: string) => void;
    private readonly appendCollectionRecord: (record: CollectionRecord, cwd: string) => void;
    private readonly pending = new Map<string, PendingRequest>();

    constructor(opts: McpProtocolRecorderOptions) {
        this.cwd = opts.cwd ?? process.cwd();
        this.serverName = opts.serverName;
        this.transport = opts.transport;
        this.sessionId = opts.sessionId ?? null;
        this.inlineLimitBytes = opts.inlineLimitBytes ?? DEFAULT_MCP_INLINE_LIMIT_BYTES;
        this.now = opts.now ?? (() => new Date());
        this.clockMs = opts.clockMs ?? (() => Date.now());
        this.append = opts.append ?? appendMcpEvent;
        this.appendCollectionRecord = opts.appendCollectionRecord ?? appendCollection;
    }

    recordJsonLine(direction: McpDirection, line: string): void {
        const normalized = stripLineTerminator(line);
        if (normalized.trim() === "") {
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(normalized);
        } catch (err) {
            this.recordParseError(direction, normalized, err);
            return;
        }

        if (Array.isArray(parsed)) {
            this.recordBatch(direction, parsed);
            return;
        }

        this.recordMessage(direction, parsed);
    }

    recordStderrLine(line: string): void {
        const normalized = stripLineTerminator(line);
        if (normalized.length === 0) {
            return;
        }
        this.appendRecord({
            kind: "mcp_transport",
            direction: "server_to_client",
            stream: "stderr",
            messageType: "transport_stderr",
            payload: normalized,
            contentType: "text/plain",
        });
    }

    recordTransportError(message: string): void {
        this.appendRecord({
            kind: "mcp_transport",
            messageType: "transport_error",
            payload: { message },
            contentType: "application/json",
        });
    }

    recordTransportClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
        this.appendRecord({
            kind: "mcp_transport",
            messageType: "transport_close",
            payload: { exit_code: exitCode, signal },
            contentType: "application/json",
        });
    }

    private recordBatch(direction: McpDirection, messages: unknown[]): void {
        if (messages.length === 0) {
            this.recordMessage(direction, [], { batchIndex: 0, batchSize: 0 });
            return;
        }
        for (let index = 0; index < messages.length; index++) {
            this.recordMessage(direction, messages[index], {
                batchIndex: index,
                batchSize: messages.length,
            });
        }
    }

    private recordMessage(
        direction: McpDirection,
        message: unknown,
        opts: RecordMessageOptions = {},
    ): void {
        const info = inspectJsonRpcMessage(message);
        const toolCall = this.appendPreCollectionIfMcpToolCall(direction, info, message);
        const correlation = this.correlate(direction, info, toolCall);
        this.appendRecord({
            kind: "mcp_message",
            direction,
            stream: direction === "client_to_server" ? "stdin" : "stdout",
            messageType: info.messageType,
            method: info.method,
            requestMethod: correlation.requestMethod,
            id: info.id,
            batchIndex: opts.batchIndex,
            batchSize: opts.batchSize,
            latencyMs: correlation.latencyMs,
            payload: message,
            contentType: "application/json",
        });
        this.appendPostCollectionIfMcpToolCall(correlation.toolCall, info, message);
    }

    private recordParseError(direction: McpDirection, line: string, err: unknown): void {
        this.appendRecord({
            kind: "mcp_parse_error",
            direction,
            stream: direction === "client_to_server" ? "stdin" : "stdout",
            messageType: "parse_error",
            payload: {
                line,
                error: err instanceof Error ? err.message : String(err),
            },
            contentType: "application/json",
        });
    }

    private correlate(
        direction: McpDirection,
        info: JsonRpcMessageInfo,
        toolCall: PendingMcpToolCall | null,
    ): { latencyMs?: number; requestMethod?: string; toolCall?: PendingMcpToolCall } {
        if (info.messageType === "request" && info.id !== undefined) {
            this.pending.set(pendingKey(direction, info.id), {
                startedAtMs: this.clockMs(),
                method: info.method ?? "unknown",
                ...(toolCall ? { toolCall } : {}),
            });
            return {};
        }

        if (!isResponseLike(info.messageType) || info.id === undefined) {
            return {};
        }

        const key = pendingKey(oppositeDirection(direction), info.id);
        const pending = this.pending.get(key);
        if (!pending) {
            return {};
        }
        this.pending.delete(key);
        return {
            latencyMs: Math.max(0, this.clockMs() - pending.startedAtMs),
            requestMethod: pending.method,
            ...(pending.toolCall ? { toolCall: pending.toolCall } : {}),
        };
    }

    private appendPreCollectionIfMcpToolCall(
        direction: McpDirection,
        info: JsonRpcMessageInfo,
        message: unknown,
    ): PendingMcpToolCall | null {
        const toolCall = buildPendingMcpToolCall(this.serverName, direction, info, message);
        if (toolCall) {
            this.appendDerivedCollectionEvent("tool_use_start", toolCall);
        }
        return toolCall;
    }

    private appendPostCollectionIfMcpToolCall(
        toolCall: PendingMcpToolCall | undefined,
        info: JsonRpcMessageInfo,
        message: unknown,
    ): void {
        if (!toolCall) {
            return;
        }
        this.appendDerivedCollectionEvent(
            isToolErrorResponse(info, message) ? "tool_use_error" : "tool_use",
            toolCall,
            extractJsonRpcResponsePayload(message),
        );
    }

    private appendDerivedCollectionEvent(
        eventType: "tool_use_start" | "tool_use" | "tool_use_error",
        toolCall: PendingMcpToolCall,
        toolResponse?: unknown,
    ): void {
        const input: JsonObject = {
            event_type: eventType,
            type: eventType,
            ts: this.now().toISOString(),
            hook_event: eventType === "tool_use_start" ? "PreToolUse" : "PostToolUse",
            session: this.sessionId ?? undefined,
            tool_name: toolCall.providerTool,
            tool_input: toolCall.toolInput,
            tool_use_id: toolCall.toolUseId,
            cwd: this.cwd,
            client_runner: "mcp-proxy",
            ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
        };
        const record = buildCollectionRecord(input);
        if (record) {
            this.appendCollectionRecord(record, this.cwd);
        }
    }

    private appendRecord(args: {
        kind: McpEventRecord["kind"];
        messageType: McpMessageType;
        payload: unknown;
        contentType: McpPayloadContentType;
        direction?: McpDirection | undefined;
        stream?: McpEventRecord["stream"] | undefined;
        method?: string | null | undefined;
        requestMethod?: string | undefined;
        id?: JsonRpcId | undefined;
        batchIndex?: number | undefined;
        batchSize?: number | undefined;
        latencyMs?: number | undefined;
    }): void {
        const captured = captureMcpPayload(args.payload, {
            cwd: this.cwd,
            inlineLimitBytes: this.inlineLimitBytes,
            contentType: args.contentType,
        });
        const record: McpEventRecord = {
            schema: "mcp-events.v1",
            kind: args.kind,
            ts: this.now().toISOString(),
            server_name: this.serverName,
            transport: this.transport,
            session_id: this.sessionId,
            message_type: args.messageType,
            payload_bytes: captured.payload_bytes,
            payload_sha256: captured.payload_sha256,
            fidelity: {
                source: "mcp_proxy",
                completeness: "complete",
                inline: captured.payload !== undefined,
            },
            privacy: {
                redaction_status: "unscanned",
                sensitivity: "unknown",
                contains_sensitive: "unknown",
                allowed_for_training: false,
                allowed_for_cloud_upload: false,
            },
        };
        attachOptionalRecordFields(record, args, captured);
        this.append(record, this.cwd);
    }
}

function inspectJsonRpcMessage(message: unknown): JsonRpcMessageInfo {
    if (!isJsonObject(message)) {
        return { messageType: "unknown", method: null, id: undefined };
    }

    const method = typeof message.method === "string" ? message.method : null;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const id = hasId ? normalizeJsonRpcId(message.id) : undefined;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if (method && hasId) {
        return { messageType: "request", method, id };
    }
    if (method) {
        return { messageType: "notification", method, id: undefined };
    }
    if (hasError && hasId) {
        return { messageType: "error", method: null, id };
    }
    if (hasResult && hasId) {
        return { messageType: "response", method: null, id };
    }
    return { messageType: "unknown", method: null, id };
}

function buildPendingMcpToolCall(
    serverName: string,
    direction: McpDirection,
    info: JsonRpcMessageInfo,
    message: unknown,
): PendingMcpToolCall | null {
    if (direction !== "client_to_server" || info.messageType !== "request") {
        return null;
    }
    if (info.method !== "tools/call" || info.id === undefined) {
        return null;
    }
    if (!isJsonObject(message) || !isJsonObject(message.params)) {
        return null;
    }
    const tool = typeof message.params.name === "string" ? message.params.name : "unknown";
    return {
        providerTool: `mcp__${serverName}__${tool}`,
        toolUseId: `mcp:${serverName}:${typeof info.id}:${String(info.id)}`,
        toolInput: {
            server: serverName,
            tool,
            params: isJsonObject(message.params.arguments) ? message.params.arguments : message.params,
        },
    };
}

// Exported for tests: the two defensive branches below (a non-object message,
// and an object with neither "error" nor "result") are unreachable through
// the class's public `recordJsonLine` — the only call site only reaches here
// once `inspectJsonRpcMessage` has already classified `message` as
// "response" or "error", which by construction means it is a JSON object
// carrying exactly one of those two keys.
export function extractJsonRpcResponsePayload(message: unknown): unknown {
    if (!isJsonObject(message)) {
        return message;
    }
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
        return message.error;
    }
    if (Object.prototype.hasOwnProperty.call(message, "result")) {
        return message.result;
    }
    return message;
}

function isToolErrorResponse(info: JsonRpcMessageInfo, message: unknown): boolean {
    if (info.messageType === "error") {
        return true;
    }
    if (!isJsonObject(message) || !isJsonObject(message.result)) {
        return false;
    }
    return message.result.isError === true;
}

function attachOptionalRecordFields(
    record: McpEventRecord,
    args: {
        direction?: McpDirection | undefined;
        stream?: McpEventRecord["stream"] | undefined;
        method?: string | null | undefined;
        requestMethod?: string | undefined;
        id?: JsonRpcId | undefined;
        batchIndex?: number | undefined;
        batchSize?: number | undefined;
        latencyMs?: number | undefined;
    },
    captured: ReturnType<typeof captureMcpPayload>,
): void {
    if (args.direction !== undefined) record.direction = args.direction;
    if (args.stream !== undefined) record.stream = args.stream;
    if (args.method) record.method = args.method;
    if (args.requestMethod !== undefined) record.request_method = args.requestMethod;
    if (args.id !== undefined) record.jsonrpc_id = args.id;
    if (args.batchIndex !== undefined) record.batch_index = args.batchIndex;
    if (args.batchSize !== undefined) record.batch_size = args.batchSize;
    if (args.latencyMs !== undefined) record.latency_ms = args.latencyMs;
    if (captured.payload !== undefined) record.payload = captured.payload;
    if (captured.payload_ref !== undefined) record.payload_ref = captured.payload_ref;
    if (captured.payload_preview !== undefined) record.payload_preview = captured.payload_preview;
}


function normalizeJsonRpcId(value: unknown): JsonRpcId {
    if (typeof value === "string" || typeof value === "number" || value === null) {
        return value;
    }
    return null;
}

function isResponseLike(messageType: McpMessageType): boolean {
    return messageType === "response" || messageType === "error";
}

function oppositeDirection(direction: McpDirection): McpDirection {
    return direction === "client_to_server" ? "server_to_client" : "client_to_server";
}

function pendingKey(direction: McpDirection, id: JsonRpcId): string {
    return `${direction}:${typeof id}:${String(id)}`;
}

function stripLineTerminator(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
}
