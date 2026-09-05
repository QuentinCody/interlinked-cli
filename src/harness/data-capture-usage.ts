import { appendCapturedData } from "../lib/data/capture.js";
import { dataRecordHash } from "../lib/data/normalize.js";
import type { TimelineRecord } from "./transcript-record.js";

function measuredToken(value: number | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Timeline usage is attached once per provider message and is a delta. */
export function usageRecord(record: TimelineRecord): object | null {
    if (!record.usage) return null;
    const provider = record.provider ?? "claude-code";
    const id = dataRecordHash(JSON.stringify([provider, record.session, record.agent_id, record.uuid]));
    return { schema: "usage-delta.v1", ts: record.ts, usage_id: id, tool_use_id: id,
        session_id: record.session, provider, model: record.model ?? null,
        agent_id: record.agent_id ?? null, parent_agent: record.parent_agent ?? null,
        input_tokens: measuredToken(record.usage.input), output_tokens: measuredToken(record.usage.output),
        cache_read_input_tokens: measuredToken(record.usage.cache_read),
        cache_creation_input_tokens: measuredToken(record.usage.cache_creation),
        usage_semantics: "provider-message-delta", monetary_cost: null, price_status: "not-priced",
        provenance: { source: "timeline", uuid: record.uuid, seq: record.seq } };
}

export function captureTimelineUsage(cwd: string, records: readonly TimelineRecord[]): void {
    const usage = records.map(usageRecord).filter((record): record is object => record !== null);
    appendCapturedData({ cwd, producer: "harness/data-capture-usage" }, "costs", usage);
}
