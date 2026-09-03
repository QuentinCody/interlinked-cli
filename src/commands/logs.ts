// ===========================================
// interlinked logs — View local activity log
// ===========================================
// Reads and displays local activity.jsonl with filtering and
// real-time tail support. Purely local — no server connection needed.

import {
	closeSync,
	existsSync,
	openSync,
	readSync,
	statSync,
	unwatchFile,
	watchFile,
} from "node:fs";
import { join } from "node:path";
import { formatActivitySummary, parseDuration } from "../lib/activity-utils.js";
import { getDataDir } from "../lib/config.js";
import { c, shortTimestamp } from "../lib/formatter.js";
import { isJsonObject } from "../lib/json-types.js";
import { readLocalActivity } from "../lib/local-activity.js";
import { getOutputMode, output, outputError, type OutputMode } from "../lib/output.js";

/** `watchFile` poll interval (ms) — how often to ask the OS whether the file changed. */
const WATCH_FILE_INTERVAL_MS = 500;
/** Backup poll interval (ms) for platforms where `watchFile` is unreliable. */
const LOG_TAIL_POLL_INTERVAL_MS = 1000;

interface LogsOptions {
	follow?: boolean;
	agent?: string;
	tool?: string;
	type?: string;
	since?: string;
	limit?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
	raw?: boolean;
}

interface LogEvent {
	ts: string;
	agent: string;
	type: string;
	tool?: string | null;
	summary?: string | null;
	session?: string | null;
	hook?: string | null;
	[key: string]: unknown;
}

/**
 * Parse one already-`JSON.parse`d activity.jsonl line into a `LogEvent`, or
 * null when it isn't an object or is missing one of the three required
 * fields (`ts`/`agent`/`type`). Every OTHER key is preserved verbatim via
 * the spread -- `formatEvent` reads `event.tokens` / `event.duration_ms`
 * through `LogEvent`'s own index signature, so a literal that only carried
 * the named fields would silently drop them from the live --follow render.
 */
function parseLogEvent(value: unknown): LogEvent | null {
	if (!isJsonObject(value)) return null;
	const { ts, agent, type, tool, summary, session, hook } = value;
	if (typeof ts !== "string" || typeof agent !== "string" || typeof type !== "string") {
		return null;
	}
	return {
		...value,
		ts,
		agent,
		type,
		tool: typeof tool === "string" || tool === null ? tool : null,
		summary: typeof summary === "string" || summary === null ? summary : null,
		session: typeof session === "string" || session === null ? session : null,
		hook: typeof hook === "string" || hook === null ? hook : null,
	};
}

function getActivityPath(cwd: string): string {
	return join(getDataDir(cwd), "activity.jsonl");
}

function matchesFilters(event: LogEvent, opts: LogsOptions): boolean {
	if (opts.agent && event.agent !== opts.agent) return false;
	if (opts.tool && event.tool !== opts.tool) return false;
	if (opts.type && event.type !== opts.type) return false;
	return true;
}

function formatEvent(event: LogEvent, raw: boolean): string {
	if (raw) return JSON.stringify(event);

	const ts = shortTimestamp(event.ts);
	const agent = c.cyan(event.agent || "?");
	const type = eventTypeColor(event.type);
	const tool = event.tool ? c.dim(event.tool) : "";

	const tokens = event.tokens as { input?: number; output?: number } | undefined;
	const summary = formatActivitySummary({
		agent_name: event.agent,
		event_type: event.type,
		tool_name: event.tool ?? null,
		tool_input_summary: event.summary ?? null,
		ts: event.ts,
		...(tokens !== undefined ? { tokens } : {}),
	});

	const dur = event.duration_ms ? c.dim(` ${event.duration_ms}ms`) : "";
	return `${ts} ${agent} ${type} ${tool ? `${tool} ` : ""}${summary}${dur}`;
}

function eventTypeColor(type: string): string {
	switch (type) {
		case "session_start":
			return c.green("START");
		case "session_end":
		case "agent_stop":
			return c.yellow("END");
		case "tool_use":
			return c.blue("TOOL");
		case "tool_use_start":
			return c.dim("TOOL>");
		case "tool_use_error":
			return c.red("ERROR");
		case "user_prompt":
			return c.green("PROMPT");
		case "subagent_start":
			return c.cyan("SUB>");
		case "subagent_stop":
			return c.cyan("SUB<");
		case "context_compact":
			return c.dim("COMPACT");
		case "task_completed":
			return c.green("TASK-DONE");
		case "teammate_idle":
			return c.dim("IDLE");
		case "notification":
			return c.dim("NOTIFY");
		case "permission_request":
			return c.yellow("PERM");
		default:
			return c.dim(type);
	}
}

async function tailFollow(activityPath: string, opts: LogsOptions): Promise<void> {
	let offset = 0;
	try {
		offset = statSync(activityPath).size;
	} catch (_) {
		/* intentional: activity log does not exist yet, start tail from offset 0 */
	}

	const raw = opts.raw || false;

	console.log(c.dim(`--- Following ${activityPath} (Ctrl+C to stop) ---`));

	const readNew = () => {
		try {
			if (!existsSync(activityPath)) return;
			const size = statSync(activityPath).size;
			if (size <= offset) return;

			const fd = openSync(activityPath, "r");
			const bytesToRead = size - offset;
			const buffer = Buffer.alloc(bytesToRead);
			readSync(fd, buffer, 0, bytesToRead, offset);
			closeSync(fd);
			offset = size;

			const lines = buffer.toString("utf-8").split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					const event = parseLogEvent(JSON.parse(line));
					if (event && matchesFilters(event, opts)) {
						console.log(formatEvent(event, raw));
					}
				} catch (_) {
					/* intentional: skip malformed JSONL line and keep reading */
				}
			}
		} catch (_) {
			/* intentional: best-effort tail, ignore read errors and keep watching */
		}
	};

	// Use watchFile for cross-platform compatibility
	watchFile(activityPath, { interval: WATCH_FILE_INTERVAL_MS }, readNew);

	// Also poll periodically for systems where watchFile is unreliable
	const pollInterval = setInterval(readNew, LOG_TAIL_POLL_INTERVAL_MS);

	// Keep running until interrupted
	await new Promise<void>((resolve) => {
		const cleanup = () => {
			unwatchFile(activityPath);
			clearInterval(pollInterval);
			console.log(c.dim("\n--- Stopped ---"));
			resolve();
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	});
}

/**
 * Resolves `--since` into a millisecond timestamp cutoff. Reports the error via
 * `outputError` and signals `error: true` on an invalid duration string.
 */
function resolveSinceTs(
	since: string | undefined,
	mode: OutputMode,
): { ts: number | undefined; error: boolean } {
	if (!since) return { ts: undefined, error: false };
	try {
		return { ts: Date.now() - parseDuration(since), error: false };
	} catch (e) {
		outputError(mode, e instanceof Error ? e.message : String(e));
		return { ts: undefined, error: true };
	}
}

export async function logsCommand(opts: LogsOptions): Promise<void> {
	const cwd = process.cwd();
	const mode = getOutputMode(opts);
	const activityPath = getActivityPath(cwd);

	// Follow mode
	if (opts.follow) {
		await tailFollow(activityPath, opts);
		return;
	}

	// Static mode — read recent events
	if (!existsSync(activityPath)) {
		outputError(mode, "No activity log found. Run `interlinked enable` to install hooks.");
		return;
	}

	const limit = Number.parseInt(opts.limit || "20", 10);
	if (!Number.isFinite(limit) || limit <= 0) {
		outputError(mode, `Invalid --limit: "${opts.limit}". Expected a positive integer.`);
		return;
	}

	const sinceResult = resolveSinceTs(opts.since, mode);
	if (sinceResult.error) return;
	const sinceTs = sinceResult.ts;

	// Read from local JSONL (already reads newest-first)
	let events = readLocalActivity({
		...(sinceTs !== undefined ? { since: sinceTs } : {}),
		...(opts.agent !== undefined ? { agent: opts.agent } : {}),
		...(opts.type !== undefined ? { type: opts.type } : {}),
		limit: opts.tool ? limit * 5 : limit, // Over-fetch if we need to filter by tool
		cwd,
	});

	// Apply tool filter (readLocalActivity doesn't support it)
	if (opts.tool) {
		events = events.filter((e) => e.tool === opts.tool);
	}

	events = events.slice(0, limit);

	// Reverse to show oldest first (chronological order)
	events.reverse();

	output(mode, events, {
		json: () => events,
		short: () => {
			if (events.length === 0) return "No activity.";
			return events.map((e) => `${e.ts} ${e.agent} ${e.type} ${e.tool || ""}`).join("\n");
		},
		normal: () => {
			if (events.length === 0) {
				return c.dim("No recent activity. Hooks may not be installed yet.");
			}

			const lines: string[] = [];
			const raw = opts.raw || false;

			for (const event of events) {
				lines.push(formatEvent(event as LogEvent, raw));
			}

			lines.push("");
			lines.push(
				c.dim(
					`${events.length} event${events.length !== 1 ? "s" : ""} shown. Use -f to follow in real-time.`,
				),
			);

			return lines.join("\n");
		},
	});
}
