// ===========================================
// interlinked explain — Reconstruct narrative timeline from activity
// ===========================================
// Merges local and server activity into a chronological narrative.
// Activity-only: messages and tasks are server-side concerns.

import { type ActivityEvent, formatActivitySummary, parseDuration } from "../lib/activity-utils.js";
import { getClient } from "../lib/api-client.js";
import { c, divider, header, indent, shortTimestamp } from "../lib/formatter.js";
import {
	type EventAttribution,
	mergeAndDedup,
	readLocalActivity,
} from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface ActivityFeedResponse {
	events?: ActivityEvent[];
	activity?: ActivityEvent[];
	activities?: ActivityEvent[];
}

interface TimelineEvent {
	timestamp: string;
	agent: string;
	type: "activity";
	summary: string;
	detail?: string | undefined;
	attribution?: EventAttribution | undefined;
}

export async function explainCommand(opts: {
	agent?: string;
	since?: string;
	full?: boolean;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);

	try {
		const durationMs = parseDuration(opts.since || "1h");
		const sinceLabel = opts.since || "1h";

		// Fetch data from local + server in parallel
		const [localResult, activityResult] = await Promise.allSettled([
			Promise.resolve(
				readLocalActivity({
					since: Date.now() - durationMs,
					limit: 200,
				}),
			),
			getClient().callTool<ActivityFeedResponse | undefined>("query_activity_feed", {
				limit: 100,
			}),
		]);

		const isServerDown = activityResult.status === "rejected";
		const mergedActivity = mergeLocalAndServerActivity(localResult, activityResult);
		const timeline = buildTimeline(mergedActivity, opts.full);
		const agentFiltered = filterAndSortTimeline(timeline, durationMs, opts.agent);

		const sourceLabel = isServerDown ? " (local only)" : "";

		output(mode, agentFiltered, {
			json: () => ({
				timeline: agentFiltered,
				since: sinceLabel,
				agent: opts.agent,
				source: isServerDown ? "local" : "merged",
			}),
			normal: () => renderNormalTimeline(agentFiltered, sinceLabel, sourceLabel, opts.agent),
			full: () => renderFullTimeline(agentFiltered, sinceLabel, sourceLabel, opts.agent),
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function mergeLocalAndServerActivity(
	localResult: PromiseSettledResult<ReturnType<typeof readLocalActivity>>,
	activityResult: PromiseSettledResult<ActivityFeedResponse | undefined>,
): ActivityEvent[] {
	const localEvents = localResult.status === "fulfilled" ? localResult.value : [];
	const serverActivityEvents =
		activityResult.status === "fulfilled"
			? activityResult.value?.events ||
				activityResult.value?.activities ||
				activityResult.value?.activity ||
				[]
			: [];

	// Normalize local events to ActivityEvent shape for merging
	const normalizedLocal: ActivityEvent[] = localEvents.map((e) => ({
		agent_name: e.agent,
		event_type: e.type,
		tool_name: e.tool ?? null,
		tool_input_summary: e.summary ?? null,
		occurred_at: e.ts,
	}));

	return mergeAndDedup(normalizedLocal, serverActivityEvents);
}

function buildTimeline(mergedActivity: ActivityEvent[], full: boolean | undefined): TimelineEvent[] {
	const timeline: TimelineEvent[] = [];
	for (const e of mergedActivity) {
		const ts = e.occurred_at || e.timestamp || e.created_at;
		if (!ts) continue;
		timeline.push({
			timestamp: ts,
			agent: resolveAgentName(e),
			type: "activity",
			summary: formatActivitySummary(e),
			detail: full
				? `${e.event_type || ""} | ${e.tool_name || ""} | ${e.tool_input_summary || ""}`
				: undefined,
			attribution: e.attribution,
		});
	}
	return timeline;
}

function filterAndSortTimeline(
	timeline: TimelineEvent[],
	durationMs: number,
	agent: string | undefined,
): TimelineEvent[] {
	// Filter by time window
	const cutoff = Date.now() - durationMs;
	const filtered = timeline.filter((e) => new Date(e.timestamp).getTime() >= cutoff);

	// Filter by agent if specified
	const agentFiltered = agent ? filtered.filter((e) => e.agent === agent) : filtered;

	// Sort by timestamp ascending (narrative order)
	agentFiltered.sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	return agentFiltered;
}

function renderAttributionSummary(agentFiltered: TimelineEvent[]): string[] {
	const lines: string[] = [];
	const eventsWithAttribution = agentFiltered.filter(
		(e) => e.attribution && (e.attribution.agent_lines || e.attribution.human_lines),
	);
	if (eventsWithAttribution.length > 0) {
		const totalAgent = eventsWithAttribution.reduce(
			(sum, e) => sum + (e.attribution?.agent_lines || 0),
			0,
		);
		const totalHuman = eventsWithAttribution.reduce(
			(sum, e) => sum + (e.attribution?.human_lines || 0),
			0,
		);
		const total = totalAgent + totalHuman;
		if (total > 0) {
			const pct = Math.round((totalAgent / total) * 100);
			lines.push("");
			lines.push(
				c.dim(`  Attribution: Agent wrote ${totalAgent}/${total} lines (${pct}%)`),
			);
		}
	}
	return lines;
}

function renderNormalTimeline(
	agentFiltered: TimelineEvent[],
	sinceLabel: string,
	sourceLabel: string,
	agent: string | undefined,
): string {
	const lines: string[] = [];
	const agentLabel = agent ? ` for ${agent}` : "";
	lines.push(header(`Timeline (last ${sinceLabel}${agentLabel})${sourceLabel}`));

	if (agentFiltered.length === 0) {
		lines.push(c.dim("  No events in this time window"));
		return lines.join("\n");
	}

	for (const event of agentFiltered) {
		const ts = shortTimestamp(event.timestamp);
		lines.push(`${c.dim(ts)}  ${c.bold(event.agent.padEnd(16))} ${c.dim(event.summary)}`);
		if (event.detail) {
			lines.push(indent(c.dim(event.detail), 24));
		}
	}

	lines.push(...renderAttributionSummary(agentFiltered));

	// Summary
	lines.push("");
	lines.push(divider());
	lines.push(c.dim(`  ${agentFiltered.length} activity events`));

	return lines.join("\n");
}

function renderFullTimeline(
	agentFiltered: TimelineEvent[],
	sinceLabel: string,
	sourceLabel: string,
	agent: string | undefined,
): string {
	const lines: string[] = [];
	const agentLabel = agent ? ` for ${agent}` : "";
	lines.push(header(`Timeline — Full Detail (last ${sinceLabel}${agentLabel})${sourceLabel}`));

	if (agentFiltered.length === 0) {
		lines.push(c.dim("  No events in this time window"));
		return lines.join("\n");
	}

	for (const event of agentFiltered) {
		const ts = shortTimestamp(event.timestamp);
		lines.push(
			`${c.dim(ts)}  ${c.bold(event.agent.padEnd(16))} ${c.dim("[activity]   ")} ${event.summary}`,
		);
		if (event.detail) {
			lines.push(indent(c.dim(event.detail), 6));
		}
	}

	return lines.join("\n");
}

function resolveAgentName(event: ActivityEvent): string {
	return event.agent_name || event.agent || "unknown";
}
