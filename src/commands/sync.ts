// ===========================================
// interlinked sync — Push unsynced local events to the server
// ===========================================

import { c, header, kvLine } from "../lib/formatter.js";
import {
	assertActivitySyncCursor,
	captureActivitySyncBasis,
	getLocalStats,
	readSyncState,
} from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import {
	fmtTime,
	formatUpToDate,
	renderCountSection,
	renderTopToolsSection,
} from "./sync-format.js";
import {
	SYNC_SUMMARY_RETAINED_KEY_LIMIT,
	type SummaryOmissions,
	readSyncPreview,
	runBoundedSync,
	summaryIsComplete,
	topTools,
} from "./sync-bounded.js";
import { resolveSyncContext, sendOneBatch } from "./sync-transport.js";
const BATCH_SIZE = 100;

function summaryTruncation(omissions: SummaryOmissions): Record<string, unknown> | null {
	if (summaryIsComplete(omissions)) return null;
	return {
		exact: false,
		retained_key_limit: SYNC_SUMMARY_RETAINED_KEY_LIMIT,
		omitted_occurrences: {
			by_type: omissions.byTypeOccurrences,
			by_agent: omissions.byAgentOccurrences,
			by_tool: omissions.byToolOccurrences,
			sessions: omissions.sessionOccurrences,
		},
	};
}

function renderSummaryTruncation(omissions: SummaryOmissions): string[] {
	if (summaryIsComplete(omissions)) return [];
	return [
		"",
		kvLine("Summary", c.yellow("partial (bounded memory)")),
		c.dim(
			`  Omitted occurrences — event types: ${omissions.byTypeOccurrences}, agents: ${omissions.byAgentOccurrences}, tools: ${omissions.byToolOccurrences}, sessions: ${omissions.sessionOccurrences}. Retained counts above are incomplete.`,
		),
	];
}

export async function syncCommand(opts: {
	json?: boolean;
	dryRun?: boolean;
	limit?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const maxEvents = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;

	try {
		const stats = getLocalStats();
		const initialState = readSyncState();
		assertActivitySyncCursor(initialState.synced_through_bytes, stats.file_size_bytes);
		if (stats.pending_sync === 0) {
			output(
				mode,
				{},
				{
					json: () => ({ synced: 0, pending: 0, message: "Already up to date" }),
					normal: () => formatUpToDate(),
				},
			);
			return;
		}
		const basis = captureActivitySyncBasis(initialState.synced_through_bytes);

		if (opts.dryRun) {
			const preview = readSyncPreview({
				limit: maxEvents,
				start: initialState.synced_through_bytes,
				basis,
			});
			if (preview.events === 0) {
				output(
					mode,
					{},
					{
						json: () => ({ synced: 0, pending: 0, message: "Already up to date" }),
						normal: () => formatUpToDate(),
					},
				);
				return;
			}
			output(mode, preview, {
				json: () => ({
					dry_run: true,
					pending_events: preview.events,
					batches: Math.ceil(preview.events / BATCH_SIZE),
					sync_state: initialState,
				}),
				normal: () => {
					const lines: string[] = [];
					lines.push(header("Sync (dry-run)"));
					lines.push(kvLine("Pending events", String(preview.events)));
					lines.push(
						kvLine("Batches needed", String(Math.ceil(preview.events / BATCH_SIZE))),
					);
					lines.push(kvLine("New offset", `${preview.newOffset} bytes`));
					lines.push("");
					lines.push(c.dim("  Run 'interlinked sync' (without --dry-run) to push."));
					return lines.join("\n");
				},
			});
			return;
		}

		// Resolve server URL + auth + workspace targeting (dev-guard inside).
		const ctx = resolveSyncContext(mode);
		if (!ctx) return;
		const run = await runBoundedSync({
			ctx,
			mode,
			limit: maxEvents,
			start: initialState.synced_through_bytes,
			basis,
			previousSummary: initialState.last_summary,
			sendBatch: sendOneBatch,
		});
		if (run.kind === "auth_failed") {
			outputError(mode, "Authentication failed. Run 'interlinked login' to re-authenticate.");
			return;
		}
		const { progress } = run;
		if (progress.eventsTotal === 0 && progress.errors === 0) {
			output(
				mode,
				{},
				{
					json: () => ({ synced: 0, pending: 0, message: "Already up to date" }),
					normal: () => formatUpToDate(),
				},
			);
			return;
		}
		const { serverUrl, workspaceId } = ctx;
		const { byType, byAgent, byTool, sessions, earliest, latest } = progress.summary;
		const summaryComplete = summaryIsComplete(progress.summaryOmissions);
		const renderedTopTools = topTools(progress.summary);

		output(
			mode,
			{},
			{
				json: () => ({
					server_url: serverUrl,
					workspace_id: workspaceId || null,
					accepted: progress.accepted,
					skipped: progress.skipped,
					errors: progress.errors,
					scrubbed: progress.scrubbed,
					batches_sent: progress.batchesSent,
					retries: progress.retriesUsed,
					new_offset: progress.cursor,
					breakdown: {
						by_type: byType,
						by_agent: byAgent,
						top_tools: renderedTopTools,
						sessions: sessions.size,
					},
					breakdown_complete: summaryComplete,
					summary_truncated: summaryTruncation(progress.summaryOmissions),
					time_range: { earliest, latest },
				}),
				normal: () => {
					const lines: string[] = [];
					lines.push(header("Sync Complete"));
					lines.push(kvLine("Server", c.cyan(serverUrl)));
					if (workspaceId) {
						lines.push(kvLine("Workspace", c.cyan(workspaceId)));
					}
					lines.push(
						kvLine(
							"Events",
							`${progress.eventsTotal} total (${c.green(String(progress.accepted))} new, ${progress.skipped} dedup)`,
						),
					);
					if (progress.scrubbed > 0) {
						lines.push(
							kvLine(
								"Scrubbed",
								c.yellow(`${progress.scrubbed} events had secrets redacted`),
							),
						);
					}
					if (progress.errors > 0) {
						lines.push(kvLine("Errors", c.red(String(progress.errors))));
					}
					lines.push(kvLine("Batches", String(progress.batchesSent)));
					if (progress.retriesUsed > 0) {
						lines.push(kvLine("Retries", String(progress.retriesUsed)));
					}

					// Time range
					lines.push(...renderTimeRangeLines(earliest, latest));

					// Event type breakdown
					const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
					lines.push(
						...renderCountSection("Event Types", typeEntries, (t) => t.replace(/_/g, " ")),
					);

					// Agent breakdown
					const agentEntries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
					lines.push(...renderCountSection("Agents", agentEntries));

					// Top tools
					lines.push(...renderTopToolsSection(renderedTopTools, byTool));

					// Sessions
					lines.push(...renderSessionsLines(sessions.size, progress.summaryOmissions));
					lines.push(...renderSummaryTruncation(progress.summaryOmissions));

					lines.push(...renderErrorsFooterLines(progress.errors));
					return lines.join("\n");
				},
			},
		);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function renderTimeRangeLines(earliest: string | undefined, latest: string | undefined): string[] {
	if (!earliest || !latest) return [];
	return [
		"",
		c.bold("  Time Range"),
		`    ${c.dim(fmtTime(earliest))} → ${c.dim(fmtTime(latest))}`,
	];
}

function renderSessionsLines(
	sessionCount: number,
	summaryOmissions: SummaryOmissions,
): string[] {
	if (sessionCount === 0) return [];
	const label =
		summaryOmissions.sessionOccurrences > 0 ? "Sessions (retained)" : "Sessions";
	return ["", kvLine(label, String(sessionCount))];
}

function renderErrorsFooterLines(errors: number): string[] {
	if (errors === 0) return [];
	return ["", c.yellow("  Failed batch remains pending. Re-run to retry.")];
}
