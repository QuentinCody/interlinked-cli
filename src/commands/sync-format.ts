// interlinked-tdd: exempt
// ===========================================
// interlinked sync — run summary + human-readable formatters (extracted leaf cluster)
// ===========================================

import { c } from "../lib/formatter.js";
import { readSyncState } from "../lib/local-activity.js";

/** Aggregated breakdown of the events synced in one run. */
export interface BatchSummary {
	byType: Record<string, number>;
	byAgent: Record<string, number>;
	byTool: Record<string, number>;
	topTools: [string, number][];
	sessions: Set<string>;
	earliest: string;
	latest: string;
}

/**
 * Render one labeled count section ("Event Types", "Agents", ...) as a block of
 * output lines, or [] when there are no entries. `formatKey` lets callers
 * humanize the key (e.g. underscores → spaces for event types).
 */
export function renderCountSection(
	title: string,
	entries: [string, number][],
	formatKey: (key: string) => string = (key) => key,
): string[] {
	if (entries.length === 0) return [];
	const lines: string[] = ["", c.bold(`  ${title}`)];
	for (const [key, count] of entries) {
		lines.push(`    ${c.cyan(String(count).padStart(4))}  ${formatKey(key)}`);
	}
	return lines;
}

/** Render the Top Tools section plus the "... +N more" overflow footer. */
export function renderTopToolsSection(
	topTools: [string, number][],
	byTool: Record<string, number>,
): string[] {
	const lines = renderCountSection("Top Tools", topTools);
	if (lines.length === 0) return lines;
	const otherToolCount = Object.keys(byTool).length - topTools.length;
	if (otherToolCount > 0) {
		lines.push(c.dim(`    ... +${otherToolCount} more`));
	}
	return lines;
}

export function fmtTime(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

export function formatUpToDate(): string {
	const state = readSyncState();
	const lines: string[] = [];
	lines.push(`${c.green("Already up to date.")} No unsynced events.`);

	if (state.last_summary && state.last_sync_at) {
		const s = state.last_summary;
		lines.push("");
		lines.push(c.dim(`  Last sync: ${fmtTime(state.last_sync_at)}`));
		lines.push(c.dim(`  Server:    ${s.server_url}`));
		if (s.workspace_id) {
			lines.push(c.dim(`  Workspace: ${s.workspace_id}`));
		}
		lines.push(
			c.dim(
				`  ${s.events_total} events (${s.accepted} new, ${s.skipped} dedup) across ${s.sessions} session${s.sessions !== 1 ? "s" : ""}`,
			),
		);

		if (s.time_range.earliest && s.time_range.latest) {
			lines.push(
				c.dim(
					`  Covering: ${fmtTime(s.time_range.earliest)} → ${fmtTime(s.time_range.latest)}`,
				),
			);
		}

		const agentNames = Object.keys(s.by_agent);
		if (agentNames.length > 0) {
			lines.push(c.dim(`  Agents: ${agentNames.join(", ")}`));
		}

		const typeEntries = Object.entries(s.by_type)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4);
		if (typeEntries.length > 0) {
			const typeSummary = typeEntries
				.map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`)
				.join(", ");
			lines.push(c.dim(`  Events: ${typeSummary}`));
		}
	}

	return lines.join("\n");
}
