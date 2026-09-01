// ===========================================
// Agent-event context resolution — label + metrics for one spawned agent
// ===========================================
// Two gaps this closes, both measured against this repo's own logs on
// 2026-08-07:
//
//  1. LABEL. `SubagentStart` carries `agent_type` ("general-purpose",
//     "workflow-subagent", "fork", …); `SubagentStop` usually does NOT
//     (1439 of 1507 stop events had no label). The daemon sees both, so it
//     remembers the label from the start event and re-attaches it at stop.
//     `agent_type_source` records which one supplied it, so a remembered
//     label never masquerades as a delivered one.
//
//  2. METRICS. The stop payload carries no token usage (0 of 1507), while the
//     agent's own transcript carries per-turn `usage` for every round-trip —
//     tens of millions of cache-read tokens per agent in practice. Reading it
//     once at stop is the only chance to capture what a subagent cost.
//
// Both are best-effort: an unknown label or an unreadable transcript degrades
// to null, never to a throw.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { AgentTranscriptMetrics, AgentTypeSource } from "../../lib/collection/types.js";
import { summarizeAgentTranscript } from "../agent-metrics.js";
import type { HarnessEvent } from "../types.js";

/** Cap on the transcript read for metrics. Metrics are sums over the whole
 *  file, so unlike the final-message tail read this wants the WHOLE
 *  transcript; the cap only guards against a pathological one. */
const MAX_METRICS_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/** Bound on remembered labels so a long-lived daemon can't grow the map
 *  without limit. Insertion-ordered, so eviction drops the oldest agents —
 *  the ones whose stop event has almost certainly already fired. */
export const MAX_REMEMBERED_AGENT_TYPES = 5000;

const agentTypeById = new Map<string, string>();

/** Record the `agent_type` a SubagentStart delivered for this agent id. */
export function rememberAgentType(subagentId: string | null, agentType: string | null): void {
	if (!subagentId || !agentType) return;
	agentTypeById.delete(subagentId); // re-insert so the entry counts as newest
	agentTypeById.set(subagentId, agentType);
	if (agentTypeById.size <= MAX_REMEMBERED_AGENT_TYPES) return;
	for (const key of agentTypeById.keys()) {
		agentTypeById.delete(key);
		if (agentTypeById.size <= MAX_REMEMBERED_AGENT_TYPES) break;
	}
}

/** A resolved agent label plus its provenance. */
export interface ResolvedAgentType {
	type: string | null;
	source: AgentTypeSource | null;
}

/** Test seam — drop all remembered labels. */
export function resetRememberedAgentTypes(): void {
	agentTypeById.clear();
}

/** Non-empty string, or null. Claude Code delivers `agent_type: ""` on some
 *  paths, and `??` would keep the empty string as if it were a label. */
function nonEmpty(value: string | null | undefined): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The agent's type label and where it came from: the payload when it carries
 * one, otherwise the label remembered from this agent's SubagentStart.
 */
export function resolveAgentType(event: HarnessEvent): ResolvedAgentType {
	const fromPayload = nonEmpty(event.agent_type) ?? nonEmpty(event.tool_name);
	if (fromPayload) return { type: fromPayload, source: "payload" };
	const remembered = event.subagent_id ? agentTypeById.get(event.subagent_id) : undefined;
	if (remembered) return { type: remembered, source: "start_event" };
	return { type: null, source: null };
}

/**
 * Cost + activity metrics for one agent, read off its transcript. Null when
 * the path is missing/unreadable — the caller records null rather than a
 * zeroed record, so "not measured" stays distinguishable from "did nothing".
 */
export function readAgentMetrics(transcriptPath: string | undefined): AgentTranscriptMetrics | null {
	try {
		if (!transcriptPath || !existsSync(transcriptPath)) return null;
		if (statSync(transcriptPath).size > MAX_METRICS_TRANSCRIPT_BYTES) return null;
		return summarizeAgentTranscript(readFileSync(transcriptPath, "utf-8"));
	} catch (err) {
		void err; // unreadable transcript — metrics degrade to null
		return null;
	}
}
