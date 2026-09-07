import { isJsonObject, type JsonObject } from "../json-types.js";

/** Preserve raw transcript bytes; only the native transcript search projection is enriched. */
export function nativeTranscriptFields(raw: JsonObject): JsonObject {
    const message = isJsonObject(raw.message) ? raw.message : {};
    return { ...raw, provider: "claude", model: message.model ?? raw.model ?? null,
        agent_id: raw.agentId ?? null, tool_use_id: raw.tool_use_id ?? raw.uuid ?? null };
}
