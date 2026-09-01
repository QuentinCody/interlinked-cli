// ===========================================
// interlinked activity — Recent activity feed
// ===========================================
// Hybrid local+server reading: works offline from local JSONL,
// merges with server data when connected.

import { type ActivityEvent, parseDuration } from "../lib/activity-utils.js";
import { getClient } from "../lib/api-client.js";
import {
	c,
	estimateCost,
	formatTokens,
	header,
	shortTimestamp,
	table,
	truncate,
} from "../lib/formatter.js";
import { mergeAndDedup, readLocalActivity } from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface ResolveMergedContext {
	localEvents: ActivityEvent[];
	serverEvents: ActivityEvent[];
	isServerDown: boolean;
	isLocalEmpty: boolean;
}

// The server response body is untyped JSON — it may be null/undefined
// (empty body, non-object payload) even though callTool's generic promises
// the shape below, so this is nullable rather than a plain object type.
type ServerActivityFeedResult =
	| { events?: ActivityEvent[]; activity?: ActivityEvent[]; activities?: ActivityEvent[] }
	| null
	| undefined;

/** Pick which sources to merge based on availability (no server → local only, etc). */
function resolveMergedEvents(ctx: ResolveMergedContext): ActivityEvent[] {
	if (ctx.isServerDown && ctx.isLocalEmpty) return [];
	if (ctx.isServerDown) return ctx.localEvents;
	if (ctx.isLocalEmpty) return ctx.serverEvents;
	return mergeAndDedup(ctx.localEvents, ctx.serverEvents);
}

/** Normalize a local event to the common ActivityEvent shape. */
function localToActivity(e: {
	ts: string;
	agent: string;
	type: string;
	tool?: string | null;
	summary?: string | null;
	tokens?: { input?: number; output?: number; cache_read?: number; cache_creation?: number };
	duration_ms?: number;
	files_modified?: string[];
}): ActivityEvent {
	return {
		agent_name: e.agent,
		event_type: e.type,
		tool_name: e.tool ?? null,
		tool_input_summary: e.summary ?? null,
		occurred_at: e.ts,
		ts: e.ts,
		...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
		...(e.duration_ms !== undefined ? { duration_ms: e.duration_ms } : {}),
		...(e.files_modified !== undefined ? { files_modified: e.files_modified } : {}),
		_source: "local",
	};
}

export async function activityCommand(opts: {
	agent?: string;
	limit?: string;
	since?: string;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const parsedLimit = Number.parseInt(opts.limit || "30", 10);
	if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
		outputError(mode, `Invalid --limit value "${opts.limit}". Expected a positive integer.`);
		return;
	}
	const limit = parsedLimit;

	try {
		const durationMs = opts.since ? parseDuration(opts.since) : undefined;
		const sinceTs = durationMs ? Date.now() - durationMs : undefined;

		// Fetch local and server in parallel
		const [localResult, serverResult] = await Promise.allSettled([
			Promise.resolve(
				readLocalActivity({
					...(sinceTs !== undefined ? { since: sinceTs } : {}),
					...(opts.agent !== undefined ? { agent: opts.agent } : {}),
					limit: limit * 2, // Fetch extra for merge dedup
				}).map(localToActivity),
			),
			getClient().callTool<ServerActivityFeedResult>("query_activity_feed", {
				limit: limit * 2,
				...(opts.agent ? { agent_name: opts.agent } : {}),
			}),
		]);

		const localEvents = localResult.status === "fulfilled" ? localResult.value : [];
		let serverEvents: ActivityEvent[] = [];
		if (serverResult.status === "fulfilled") {
			const result = serverResult.value;
			serverEvents = (result?.events || result?.activities || result?.activity || []).map(
				(e) => ({
					...e,
					_source: "server",
				}),
			);
		}

		const isServerDown = serverResult.status === "rejected";
		const isLocalEmpty = localEvents.length === 0;

		// Merge and dedup — resolve which source(s) to use based on availability.
		let events = resolveMergedEvents({
			localEvents,
			serverEvents,
			isServerDown,
			isLocalEmpty,
		});

		// Apply --since filter to server events (local already filtered)
		if (sinceTs) {
			events = events.filter((e) => {
				const ts = e.occurred_at || e.ts || e.timestamp || e.created_at;
				if (!ts) return true;
				return new Date(ts).getTime() >= sinceTs;
			});
		}

		// Apply limit after merge
		events = events.slice(0, limit);

		const sourceLabel = isServerDown && !isLocalEmpty ? " (local)" : "";

		let eventSource: "local" | "server" | "merged";
		if (isServerDown) {
			eventSource = "local";
		} else if (isLocalEmpty) {
			eventSource = "server";
		} else {
			eventSource = "merged";
		}

		output(mode, events, {
			json: () => ({
				events,
				source: eventSource,
			}),
			normal: () => {
				const lines: string[] = [];
				lines.push(header(`Activity Feed${sourceLabel}`));

				if (events.length === 0) {
					lines.push(c.dim("  No recent activity"));
					return lines.join("\n");
				}

				const rows = events.map((e) => {
					const ts = shortTimestamp(e.occurred_at || e.ts || e.timestamp || e.created_at);
					const agent = e.agent_name || e.agent || c.dim("-");
					const eventType = e.event_type || e.type || c.dim("-");
					const tool = e.tool_name || e.tool || c.dim("-");
					const summary = truncate(e.tool_input_summary || e.summary || "", 50);
					const dur = e.duration_ms != null ? `${e.duration_ms}ms` : c.dim("-");
					const tok = e.tokens
						? c.dim(`${(e.tokens.input || 0) + (e.tokens.output || 0)} tok`)
						: c.dim("-");
					return [ts, agent, eventType, tool, summary, dur, tok];
				});

				lines.push(
					table(
						["Time", "Agent", "Event", "Tool", "Summary", "Duration", "Tokens"],
						rows,
					),
				);

				// Aggregate token summary
				const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
				let tokenEventCount = 0;
				for (const e of events) {
					if (e.tokens) {
						totals.input += e.tokens.input || 0;
						totals.output += e.tokens.output || 0;
						totals.cache_read += e.tokens.cache_read || 0;
						totals.cache_creation += e.tokens.cache_creation || 0;
						tokenEventCount++;
					}
				}
				if (tokenEventCount > 0) {
					lines.push(
						`\n  ${c.bold("Totals")}: ${formatTokens(totals)} (${estimateCost(totals)}) across ${tokenEventCount} events`,
					);
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
