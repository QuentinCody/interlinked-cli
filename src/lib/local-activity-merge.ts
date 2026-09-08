// interlinked-tdd: exempt
// ===========================================
// Local Activity — merge & dedup of local + server event streams
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Pure functions over JsonObject — no I/O, no back-import.

import type { JsonObject } from "./json-types.js";
/**
 * Merge local and server events, deduplicating within a 2-second bucket.
 * Server events are authoritative (kept over local on collision).
 * Accepts any object with optional timestamp/agent/type/tool fields.
 */
export function mergeAndDedup<T extends JsonObject>(local: T[], server: T[]): T[] {
	// Build dedup keys for server events (authoritative)
	const serverKeys = new Set<string>();
	for (const e of server) {
		serverKeys.add(dedupKey(e));
	}

	// Filter local events that don't collide with server
	const uniqueLocal = local.filter((e) => !serverKeys.has(dedupKey(e)));

	// Combine and sort by timestamp (newest first)
	const merged = [...server, ...uniqueLocal];
	merged.sort((a, b) => {
		const tsA = getTimestamp(a);
		const tsB = getTimestamp(b);
		return new Date(tsB).getTime() - new Date(tsA).getTime();
	});

	return merged;
}

function dedupKey(e: JsonObject): string {
	const ts = getTimestamp(e);
	const agent = firstString(e.agent, e.agent_name);
	const type = firstString(e.type, e.event_type);
	const tool = firstString(e.tool, e.tool_name);
	// Bucket to 2-second window
	const bucket = ts ? Math.floor(new Date(ts).getTime() / 2000) : 0;
	return `${agent}|${type}|${tool}|${bucket}`;
}

function getTimestamp(e: JsonObject): string {
	return firstString(e.ts, e.occurred_at, e.timestamp, e.created_at);
}

function firstString(...values: unknown[]): string {
	return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? "";
}
