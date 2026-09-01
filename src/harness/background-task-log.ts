// ===========================================
// Background-task roster capture
// ===========================================
// Claude Code attaches a `background_tasks` array to Stop / SubagentStop
// payloads: the live roster of work running OUTSIDE the main agent loop, each
// entry carrying `{id, type, status, description, agent_type}`. Discovered by
// the payload-key census on 2026-08-08 — the conversion to the harness event
// copies a fixed key whitelist, so until now the roster was dropped whole.
//
// It matters because a background agent is the ONE spawn path with no
// per-agent hook of its own: its result is delivered to the parent over a
// queue notification, and (unlike a foreground subagent) nothing else in the
// pipeline reports that it exists, what type it is, or when it finished. The
// roster is the only evidence.
//
// Storage is a small append-only log — one row per OBSERVED STATE CHANGE, not
// one per event, so a long session with a stuck background task appends twice
// (start, finish) rather than thousands of times.

import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { JsonObject } from "../lib/json-types.js";
import type { HarnessEvent } from "./types.js";

/** One background task as the runner reports it. */
interface BackgroundTask {
	id: string;
	type: string | null;
	status: string | null;
	description: string | null;
	agent_type: string | null;
}

/** A persisted observation of one background task's state. */
export interface BackgroundTaskRecord extends BackgroundTask {
	schema: "background-task.v1";
	ts: string;
	session_id: string | null;
	hook_event: string;
}

/** Tail bytes scanned to recover each task's last recorded status. Rows are
 *  small and a session's roster is short, so this covers the whole session in
 *  practice while bounding the read on a long-lived log. */
const STATUS_TAIL_BYTES = 256 * 1024;

export function backgroundTaskLogPath(cwd: string): string {
	return join(cwd, ".interlinked", "background-tasks.jsonl");
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

/**
 * Parse a payload's `background_tasks` into typed rows. Entries without an id
 * are skipped — an unidentifiable task can't be state-tracked. Never throws.
 */
export function parseBackgroundTasks(value: unknown): BackgroundTask[] {
	if (!Array.isArray(value)) return [];
	const out: BackgroundTask[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		// SAFETY: untyped payload entry; every field read is guarded by readString.
		const entry = raw as JsonObject;
		const id = readString(entry.id);
		if (!id) continue;
		out.push({
			id,
			type: readString(entry.type),
			status: readString(entry.status),
			description: readString(entry.description),
			agent_type: readString(entry.agent_type),
		});
	}
	return out;
}

/** One log row's `id`/`status` pair, or null when the line is corrupt, isn't a
 *  JSON object, or its `id` isn't a string. A non-string `status` normalizes
 *  to null rather than leaking the wrong-typed value into the status map.
 *  Never throws. */
function parseStatusRow(line: string): { id: string; status: string | null } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const id = parsed.id;
	if (typeof id !== "string") return null;
	return { id, status: typeof parsed.status === "string" ? parsed.status : null };
}

/** Last recorded status per task id, read off the log's tail. */
export function lastStatuses(cwd: string): Map<string, string | null> {
	const seen = new Map<string, string | null>();
	try {
		const path = backgroundTaskLogPath(cwd);
		if (!existsSync(path)) return seen;
		const size = statSync(path).size;
		const offset = Math.max(0, size - STATUS_TAIL_BYTES);
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		closeSync(fd);
		let text = buf.toString("utf-8");
		if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const row = parseStatusRow(line);
			if (row) seen.set(row.id, row.status);
		}
	} catch (err) {
		void err; // unreadable log — treat every task as newly seen
	}
	return seen;
}

/** Inputs for one roster observation. */
interface RecordBackgroundTasksArgs {
	tasks: BackgroundTask[];
	sessionId: string | null;
	hookEvent: string;
	ts: string;
	cwd: string;
	/** `harness test` and other synthetic events must not mutate the log. */
	dryRun?: boolean;
}

/**
 * Append a row for every task whose status differs from its last recorded one
 * (including first sight). Returns the number of rows appended. Fail-open:
 * never throws, never affects the guard decision.
 */
export function recordBackgroundTasks(args: RecordBackgroundTasksArgs): number {
	try {
		if (args.dryRun || args.tasks.length === 0) return 0;
		const previous = lastStatuses(args.cwd);
		const rows: string[] = [];
		for (const task of args.tasks) {
			if (previous.has(task.id) && previous.get(task.id) === task.status) continue;
			const record: BackgroundTaskRecord = {
				schema: "background-task.v1",
				ts: args.ts,
				session_id: args.sessionId,
				hook_event: args.hookEvent,
				...task,
			};
			rows.push(JSON.stringify(record));
		}
		if (rows.length === 0) return 0;
		const path = backgroundTaskLogPath(args.cwd);
		mkdirSync(join(args.cwd, ".interlinked"), { recursive: true });
		appendFileSync(path, `${rows.join("\n")}\n`);
		return rows.length;
	} catch (err) {
		void err; // capture is best-effort — never break the pipeline
		return 0;
	}
}

/**
 * Daemon seam: record whatever roster this event carries. Honors `dry_run`,
 * so a synthetic `harness test` event probes without mutating the log.
 * Returns rows appended (0 when the event carries no roster).
 */
export function captureBackgroundTasks(
	event: HarnessEvent,
	fallbackCwd: string,
	log?: (msg: string) => void,
): number {
	const rows = recordBackgroundTasks({
		tasks: parseBackgroundTasks(event.background_tasks),
		sessionId: event.session_id ?? null,
		hookEvent: event.hook_event,
		ts: event.timestamp,
		cwd: event.cwd ?? fallbackCwd,
		dryRun: event.dry_run === true,
	});
	if (rows > 0) log?.(`Background-task roster: ${rows} state change(s) recorded`);
	return rows;
}
