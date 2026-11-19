// Instruction packets — window SOURCE: the two local logs → ordered windows (design §7).
//
// `collection.jsonl` holds one pre row (command / path / hunks) and one post row
// (`outcome`) per tool call, keyed by tool_use_id; `timeline.jsonl` holds the
// transcript-derived `user_prompt` and `agent_message` rows. A TURN runs from
// one prompt to the next; calls fall into turns by timestamp. The same reader
// serves replay and the daemon's Stop/SessionEnd path, so a live window and a
// replayed window are the same bytes. Both logs are read as bounded tails.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { buildDigest, type CallOutcome, classifyCall, verifierScope, type WindowCall, type WindowDigest } from "./window.js";

export interface TimelineRow {
	ts: string;
	session: string;
	category: string;
	text: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The exit code, when the runner recorded one, outranks the completion flag: a test command that
 *  completed with exit code 1 FAILED, and "the tool ran" is not evidence that the tests passed. */
function outcomeOf(raw: unknown, observation: unknown): CallOutcome {
	const exit = asRecord(observation)?.exit_code;
	if (typeof exit === "number") return exit === 0 ? "pass" : "fail";
	if (raw === "ok" || raw === "pass" || raw === "success") return "pass";
	if (raw === "fail" || raw === "error" || raw === "failed") return "fail";
	if (raw === "interrupted") return "interrupted";
	return "unknown";
}

interface PreInfo {
	seq: number;
	ts: string;
	tool: string;
	command: string | null;
	files: string[];
}

function preInfoOf(r: Record<string, unknown>): PreInfo {
	const action = asRecord(r.action) ?? {};
	const path = typeof action.path === "string" ? action.path : null;
	return {
		seq: typeof r.seq === "number" ? r.seq : -1,
		ts: typeof r.ts === "string" ? r.ts : "",
		tool: typeof r.provider_tool === "string" ? r.provider_tool : "",
		command: typeof action.command === "string" ? action.command : null,
		files: path ? [path] : [],
	};
}

function keyOf(r: Record<string, unknown>): string {
	return typeof r.tool_use_id === "string" ? r.tool_use_id : `${r.session_id}:${r.seq}`;
}

/** Join pre and post rows of one session by tool_use_id into ordered calls; a missing post row is `unknown`. */
export function callsFromCollectionRows(rows: readonly unknown[], sessionId: string): WindowCall[] {
	const pre = new Map<string, PreInfo>();
	const outcome = new Map<string, CallOutcome>();
	for (const raw of rows) {
		const r = asRecord(raw);
		if (!r || r.kind !== "tool_event" || r.session_id !== sessionId) continue;
		if (r.phase === "pre") pre.set(keyOf(r), preInfoOf(r));
		else if (r.phase === "post") outcome.set(keyOf(r), outcomeOf(r.outcome, r.observation));
	}
	const calls: WindowCall[] = [];
	for (const [key, p] of pre) {
		calls.push({ seq: p.seq, ts: p.ts, tool: p.tool, class: classifyCall(p.tool, p.command, p.files), files: p.files, command: p.command, outcome: outcome.get(key) ?? "unknown", scope: verifierScope(p.command) });
	}
	return calls.sort((a, b) => a.seq - b.seq);
}

async function* tailLines(file: string, tailBytes: number): AsyncGenerator<unknown> {
	if (!existsSync(file)) return;
	const size = statSync(file).size;
	const start = Math.max(0, size - tailBytes);
	const rl = createInterface({ input: createReadStream(file, { start, encoding: "utf8" }), crlfDelay: Infinity });
	let dropFirst = start > 0;
	for await (const line of rl) {
		if (dropFirst) {
			dropFirst = false;
			continue;
		}
		if (!line) continue;
		try {
			yield JSON.parse(line);
		} catch {
			continue; // a torn line is skipped
		}
	}
}

/** The session's calls from the newest `tailBytes` of a collection log. */
export async function readCollectionCalls(file: string, tailBytes: number, sessionId: string): Promise<WindowCall[]> {
	const rows: unknown[] = [];
	for await (const row of tailLines(file, tailBytes)) {
		const r = asRecord(row);
		if (r && r.session_id === sessionId) rows.push(r);
	}
	return callsFromCollectionRows(rows, sessionId);
}

/** The session's prompt and message rows from the newest `tailBytes` of a timeline log, in file order. */
export async function readTimelineRows(file: string, tailBytes: number, sessionId: string): Promise<TimelineRow[]> {
	const out: TimelineRow[] = [];
	for await (const row of tailLines(file, tailBytes)) {
		const r = asRecord(row);
		if (!r || r.session !== sessionId) continue;
		if (r.category !== "user_prompt" && r.category !== "agent_message") continue;
		if (typeof r.ts !== "string" || typeof r.text !== "string") continue;
		out.push({ ts: r.ts, session: sessionId, category: r.category, text: r.text });
	}
	return out;
}

/** One window per prompt (plus a prompt-less leading window when calls precede the first prompt). */
export function turnWindows(sessionId: string, calls: readonly WindowCall[], timeline: readonly TimelineRow[]): WindowDigest[] {
	const prompts = timeline.filter((r) => r.category === "user_prompt").sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	const messages = timeline.filter((r) => r.category === "agent_message");
	const bounds: { from: string; to: string | null; prompt: string | null }[] = [];
	const leading = calls.filter((c) => prompts.length === 0 || c.ts < (prompts[0]?.ts ?? ""));
	if (leading.length > 0 && prompts.length > 0) bounds.push({ from: "", to: prompts[0]?.ts ?? null, prompt: null });
	for (let i = 0; i < prompts.length; i++) bounds.push({ from: prompts[i]?.ts ?? "", to: prompts[i + 1]?.ts ?? null, prompt: prompts[i]?.text ?? null });
	if (prompts.length === 0) bounds.push({ from: "", to: null, prompt: null });
	return bounds.map((b) => {
		const inWindow = (ts: string) => ts >= b.from && (b.to === null || ts < b.to);
		const last = messages.filter((m) => inWindow(m.ts)).sort((x, y) => (x.ts < y.ts ? -1 : 1)).pop();
		return buildDigest({ kind: "turn", session_id: sessionId, calls: calls.filter((c) => inWindow(c.ts)), prompts: b.prompt === null ? [] : [b.prompt], final_message: last?.text ?? null, fired_packets: [] });
	});
}

/** The whole session as one window. */
export function sessionWindow(sessionId: string, calls: readonly WindowCall[], timeline: readonly TimelineRow[]): WindowDigest {
	const prompts = timeline.filter((r) => r.category === "user_prompt").map((r) => r.text);
	const last = [...timeline].filter((r) => r.category === "agent_message").pop();
	return buildDigest({ kind: "session", session_id: sessionId, calls, prompts, final_message: last?.text ?? null, fired_packets: [] });
}

/** One tail read of each log for MANY sessions: calls and timeline rows grouped by session id. */
export interface WindowSource {
	calls: WindowCall[];
	timeline: TimelineRow[];
	/** The session's runner (collection `provider`, an adapter id), or null when no row carried one. */
	provider: string | null;
}

export async function readWindowSources(collectionFile: string, timelineFile: string, tailBytes: number, sessions: ReadonlySet<string>): Promise<Map<string, WindowSource>> {
	const rowsBySession = new Map<string, unknown[]>();
	const providerBySession = new Map<string, string>();
	for await (const row of tailLines(collectionFile, tailBytes)) {
		const r = asRecord(row);
		if (!r || typeof r.session_id !== "string" || !sessions.has(r.session_id)) continue;
		rowsBySession.set(r.session_id, [...(rowsBySession.get(r.session_id) ?? []), r]);
		if (typeof r.provider === "string" && !providerBySession.has(r.session_id)) providerBySession.set(r.session_id, r.provider);
	}
	const timelineBySession = new Map<string, TimelineRow[]>();
	for await (const row of tailLines(timelineFile, tailBytes)) {
		const r = asRecord(row);
		if (!r || typeof r.session !== "string" || !sessions.has(r.session)) continue;
		if ((r.category !== "user_prompt" && r.category !== "agent_message") || typeof r.ts !== "string" || typeof r.text !== "string") continue;
		timelineBySession.set(r.session, [...(timelineBySession.get(r.session) ?? []), { ts: r.ts, session: r.session, category: r.category, text: r.text }]);
	}
	const out = new Map<string, WindowSource>();
	for (const id of sessions) out.set(id, { calls: callsFromCollectionRows(rowsBySession.get(id) ?? [], id), timeline: timelineBySession.get(id) ?? [], provider: providerBySession.get(id) ?? null });
	return out;
}
