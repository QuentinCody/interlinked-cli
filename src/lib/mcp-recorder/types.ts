// ===========================================
// MCP Recorder — protocol event schema
// ===========================================
// Local-only JSONL records for MCP traffic mediated by Interlinked CLI.

export type McpTransport = "stdio" | "streamable_http";
export type McpDirection = "client_to_server" | "server_to_client";
type McpStream = "stdin" | "stdout" | "stderr";
export type JsonRpcId = string | number | null;

type McpEventKind =
    | "mcp_message"
    | "mcp_parse_error"
    | "mcp_transport";

export type McpMessageType =
    | "request"
    | "notification"
    | "response"
    | "error"
    | "unknown"
    | "parse_error"
    | "transport_stderr"
    | "transport_error"
    | "transport_close";

export type McpPayloadContentType = "application/json" | "text/plain";

export interface McpPayloadRef {
    kind: "sha256_blob";
    path: string;
    sha256: string;
    bytes: number;
    content_type: McpPayloadContentType;
}

interface McpFidelityBlock {
    source: "mcp_proxy";
    completeness: "complete";
    inline: boolean;
}

interface McpPrivacyBlock {
    redaction_status: "unscanned";
    sensitivity: "unknown";
    contains_sensitive: "unknown";
    allowed_for_training: false;
    allowed_for_cloud_upload: false;
}

export interface McpEventRecord {
    schema: "mcp-events.v1";
    kind: McpEventKind;
    ts: string;
    server_name: string;
    transport: McpTransport;
    session_id: string | null;
    direction?: McpDirection;
    stream?: McpStream;
    message_type: McpMessageType;
    method?: string;
    request_method?: string;
    jsonrpc_id?: JsonRpcId;
    batch_index?: number;
    batch_size?: number;
    latency_ms?: number;
    payload_bytes: number;
    payload_sha256: string;
    payload?: unknown;
    payload_ref?: McpPayloadRef;
    payload_preview?: string;
    fidelity: McpFidelityBlock;
    privacy: McpPrivacyBlock;
}

