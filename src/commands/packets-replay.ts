// ===========================================
// `interlinked packets replay | replay-windows` — fill the ledgers from history
// ===========================================
// `replay` turns the collection log's pre rows into synthetic PostToolUse events
// for the per-call evaluator (rows `source: replay`; a call is complete only when
// a model judgment or a settlement exists under the packet's CURRENT hash, so a
// recompiled packet is judged again and a failed call is retried; an event no
// pending packet matches is neither sent nor counted). `replay-windows` builds
// TURN windows per session from the two logs and runs the trajectory layer
// (docs/design/instruction-jev-evaluator.md §7). Split from packets.ts for the
// line cap; packets.ts re-exports both commands.

import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JevFetch } from "../harness/jev/client.js";
import { type PacketJudgmentRow, runPacketEvaluation } from "../harness/packets/evaluator.js";
import { readCollectionRows, type ReplayRow, rowToViews } from "../harness/packets/replay.js";
import type { PacketFile } from "../harness/packets/types.js";
import { runWindowEvaluation } from "../harness/packets/trajectory-ledger.js";
import type { TrajectoryDeps } from "../harness/packets/trajectory.js";
import { matchesTrigger } from "../harness/packets/trigger.js";
import { readWindowSources, turnWindows } from "../harness/packets/window-source.js";
import { loadRules } from "../harness/rules-loader.js";
import type { GuardRulesConfig, HarnessEvent } from "../harness/types.js";
import { DEFAULT_TAIL_MB, loadPacketFileOrNull, readLedger } from "./packets.js";

export interface PacketsReplayOpts {
	/** Newest N sessions of the collection log to replay. */
	sessions: number;
	/** Upper bound on events sent through the evaluator (default 2000). */
	maxEvents?: number;
	tailMb?: number;
	json?: boolean;
	cwd?: string;
	/** Test seams. */
	fetchImpl?: JevFetch;
	resolveKey?: () => string | undefined;
}

const DEFAULT_MAX_EVENTS = 2_000;

/** The tool_input a collection view stands for; null for a shape the evaluator cannot rebuild (apply_patch). */
export function toolInputOf(row: ReplayRow): { tool: string; input: Record<string, unknown> } | null {
	const v = row.view;
	if (v.command !== null) return { tool: v.tool, input: { command: v.command } };
	if (v.path === null || v.tool === "apply_patch") return null;
	if (v.hunks.length === 1 && v.hunks[0]?.old === "") return { tool: "Write", input: { file_path: v.path, content: v.hunks[0].new } };
	if (v.hunks.length === 1) return { tool: "Edit", input: { file_path: v.path, old_string: v.hunks[0]?.old, new_string: v.hunks[0]?.new } };
	return { tool: "MultiEdit", input: { file_path: v.path, edits: v.hunks.map((h) => ({ old_string: h.old, new_string: h.new })) } };
}

/** Newest `n` sessions by first appearance in the (append-ordered) log. */
export function newestSessions(rows: readonly ReplayRow[], n: number): Set<string> {
	const order: string[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		if (seen.has(r.session_id)) continue;
		seen.add(r.session_id);
		order.push(r.session_id);
	}
	return new Set(order.slice(-n));
}

interface ReplayCounts {
	sessions: number;
	events: number;
	already_judged: number;
	unrebuildable: number;
	rows: number;
	judged: number;
	settled: number;
	gated: number;
}

type ReplayDeps = { fetchImpl?: JevFetch; resolveKey?: () => string | undefined; source: "replay"; onlyPackets?: ReadonlySet<string> };

/** One collection row → one synthetic PostToolUse event through the shadow evaluator; counts updated in place. */
async function replayOne(row: ReplayRow, rules: GuardRulesConfig, cwd: string, deps: ReplayDeps, counts: ReplayCounts): Promise<void> {
	const rebuilt = toolInputOf(row);
	if (!rebuilt) return; // boundedWork already left it out and counted it
	counts.events++;
	const event: HarnessEvent = {
		hook_event: "PostToolUse",
		session_id: row.session_id,
		agent_source: row.provider ?? "unknown",
		tool_name: rebuilt.tool,
		tool_input: rebuilt.input as HarnessEvent["tool_input"],
		tool_use_id: row.tool_use_id ?? undefined,
		seq: row.seq,
		timestamp: new Date().toISOString(),
		cwd,
	};
	const out = await runPacketEvaluation(event, rules, deps);
	counts.rows += out.length;
	counts.judged += out.filter((r) => r.p !== null).length;
	counts.settled += out.filter((r) => r.settled !== null).length;
	counts.gated += out.filter((r) => r.gate !== null).length;
}

/** Exit codes: 0 replayed, 1 packet file or log unusable, 2 packets or jev disabled. */
export async function packetsReplayCommand(opts: PacketsReplayOpts): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const rules = loadRules(cwd);
	if (rules.packets?.enabled !== true || rules.jev?.enabled !== true) {
		console.error("packets replay: needs packets.enabled and jev.enabled in guard-rules.local.json (shadow only; nothing is shown)");
		return 2;
	}
	const file = loadPacketFileOrNull(cwd);
	if (!file) {
		console.error("packets replay: no valid packet file; run `interlinked packets compile` first");
		return 1;
	}
	const all = await readCallRows(join(cwd, ".interlinked", "collection.jsonl"), (opts.tailMb ?? DEFAULT_TAIL_MB) * 1024 * 1024);
	const rows = all.filter((r) => r.view.phase === "pre" && !isEmptyView(r.view));
	const sessions = newestSessions(rows, opts.sessions);
	const plan = replayPlanner(file, readLedger(cwd) ?? [], pairPostToPre(all));
	const counts: ReplayCounts = { sessions: sessions.size, events: 0, already_judged: 0, unrebuildable: 0, rows: 0, judged: 0, settled: 0, gated: 0 };
	const base: ReplayDeps = { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.resolveKey ? { resolveKey: opts.resolveKey } : {}), source: "replay" };
	const work = rows.filter((row) => sessions.has(row.session_id)).map((row) => ({ row, only: plan.pending(row) }));
	counts.already_judged = work.filter((w) => w.only.size === 0 && plan.judged(w.row)).length;
	const { fresh, unrebuildable } = boundedWork(work, plan, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
	counts.unrebuildable = unrebuildable;
	for (const w of fresh) await replayOne(w.row, rules, cwd, { ...base, onlyPackets: w.only }, counts);
	if (opts.json) console.log(JSON.stringify(counts, null, 2));
	else console.log(`packets replay: ${counts.sessions} sessions, ${counts.events} events sent, ${counts.already_judged} already judged, ${counts.unrebuildable} unrebuildable; rows ${counts.rows}: ${counts.judged} judged by the model, ${counts.settled} settled by regex, ${counts.gated} gated`);
	return 0;
}

/** The calls this bounded run sends: those still owing a judgment, never-attempted calls before calls a gate
 *  refused earlier (privacy, consent, outage), so a bounded run always makes progress instead of re-spending its
 *  budget on the same gated rows (audit C3, stall; R19). A call that cannot be rebuilt (apply_patch, no path) is
 *  only counted: it never gets a ledger row, so in the list it would sort first as never attempted and take the
 *  budget of every run (review-100 n11). */
export function boundedWork<W extends { row: ReplayRow; only: Set<string> }>(work: readonly W[], plan: { lastAttempt: (row: ReplayRow, only: ReadonlySet<string>) => string | null }, max: number): { fresh: W[]; unrebuildable: number } {
	const owing = work.filter((w) => w.only.size > 0);
	const sendable = owing.filter((w) => toolInputOf(w.row) !== null);
	const pending = sendable.map((w, i) => ({ w, i, last: plan.lastAttempt(w.row, w.only) }));
	// Never attempted (for one of the packets it owes) first, then the OLDEST attempt first: repeated bounded runs
	// rotate through the gated calls instead of re-sending the same first ones (break R5 #6). Ties keep log order.
	pending.sort((a, b) => (a.last === b.last ? a.i - b.i : a.last === null ? -1 : b.last === null ? 1 : a.last < b.last ? -1 : 1));
	return { fresh: pending.slice(0, max).map((x) => x.w), unrebuildable: owing.length - sendable.length };
}

/** Which packets a replayed call still owes a judgment. Already judged = the ledger holds a COMPLETED row (a
 *  model judgment or a settlement; a gate row is retried) for this call under the packet's CURRENT hash — a
 *  recompiled packet is judged again, an unchanged one is never re-spent. Pending = packets whose trigger
 *  matches the call and that are not already judged; a call no pending packet matches is neither sent nor
 *  counted, so a bounded run always makes progress. */
type CallKeyed = { tool_use_id: string | null; session_id: string; seq: number | null };

/** A call is keyed by its tool_use_id, or by session + seq when the runner sent none (audit C3, re-spend). A live
 *  row of such a call carries its POST event's seq; `postToPre` maps it to the pre row replay sees (break R5 #7).
 *  A call with neither has no key and is never "done" (break R5 #12: every such call shared one key). */
function callKeyer(postToPre: ReadonlyMap<string, string>): (r: CallKeyed) => string | null {
	return (r) => {
		if (r.tool_use_id) return r.tool_use_id;
		if (r.seq === null || r.seq < 0) return null; // the collection reader stores a missing seq as -1
		const key = `${r.session_id}#${r.seq}`;
		return postToPre.get(key) ?? key;
	};
}

/** Per `call|packet|hash`: whether a COMPLETED row exists, and the newest attempt of any kind. */
function indexLedger(ledger: readonly PacketJudgmentRow[], callKey: (r: CallKeyed) => string | null): { judged: Set<string>; attempts: Map<string, string> } {
	const judged = new Set<string>();
	const attempts = new Map<string, string>();
	for (const r of ledger) {
		const call = callKey(r);
		if (call === null || r.packet_hash === null) continue;
		const key = `${call}|${r.packet}|${r.packet_hash}`;
		if (r.gate === null && (r.p !== null || r.settled !== null)) judged.add(key);
		if ((attempts.get(key) ?? "") < r.ts) attempts.set(key, r.ts);
	}
	return { judged, attempts };
}

/** The oldest attempt over the packets a call owes, or null when one of them was never attempted on it under its
 *  current hash (break R5 #6: keyed by the call alone, a recompiled or new packet saw every call as attempted). */
function oldestAttempt(keys: readonly (string | null)[], attempts: ReadonlyMap<string, string>): string | null {
	let oldest: string | null = null;
	for (const key of keys) {
		const ts = key === null ? undefined : attempts.get(key);
		if (ts === undefined) return null;
		if (oldest === null || ts < oldest) oldest = ts;
	}
	return oldest;
}

function replayPlanner(
	file: PacketFile,
	ledger: readonly PacketJudgmentRow[],
	postToPre: ReadonlyMap<string, string> = new Map(),
): { pending: (row: ReplayRow) => Set<string>; judged: (row: ReplayRow) => boolean; lastAttempt: (row: ReplayRow, only: ReadonlySet<string>) => string | null } {
	const currentHash = new Map(file.packets.map((p) => [p.id, p.packet_hash]));
	const packetsById = new Map(file.packets.map((p) => [p.id, p]));
	const callKey = callKeyer(postToPre);
	const index = indexLedger(ledger, callKey);
	const keyOf = (row: ReplayRow, id: string) => {
		const call = callKey(row);
		return call === null ? null : `${call}|${id}|${currentHash.get(id)}`;
	};
	const done = (row: ReplayRow, id: string) => index.judged.has(keyOf(row, id) ?? "");
	const matches = (row: ReplayRow, id: string) => {
		const packet = packetsById.get(id);
		return packet !== undefined && matchesTrigger({ ...packet.applies, phase: row.view.phase }, row.view);
	};
	return {
		lastAttempt: (row, only) => oldestAttempt([...only].map((id) => keyOf(row, id)), index.attempts),
		pending: (row) => new Set([...currentHash.keys()].filter((id) => matches(row, id) && !done(row, id))),
		judged: (row) => [...currentHash.keys()].some((id) => done(row, id)),
	};
}

/** session#postSeq → session#preSeq for calls with no tool_use_id: each post row pairs with the newest unpaired pre
 *  row of the same session and tool before it (break R5 #7). A post row whose action cannot be rebuilt
 *  (`toolInputOf` null: no command, no path or hunks, apply_patch) pairs only when exactly ONE such pre row is open;
 *  with several it pairs with none and leaves them open, so no call is marked judged on a guess (R6 F2). */
export function pairPostToPre(rows: readonly ReplayRow[]): Map<string, string> {
	const out = new Map<string, string>();
	const open = new Map<string, ReplayRow[]>(); // session|tool → unpaired pre rows, in order
	for (const r of [...rows].filter((x) => x.tool_use_id === null && x.seq >= 0).sort((a, b) => a.seq - b.seq)) {
		const slot = `${r.session_id}|${r.view.tool}`;
		const pending = open.get(slot) ?? [];
		if (r.view.phase === "pre") open.set(slot, [...pending, r]);
		else if (toolInputOf(r) !== null || pending.length === 1) {
			const pre = pending.pop();
			if (pre) out.set(`${r.session_id}#${r.seq}`, `${pre.session_id}#${pre.seq}`);
		}
	}
	return out;
}

/** A view the collection reader drops (no command, no path, no hunks): such a row is a call the log saw but
 *  cannot show. It joins pairing only; it is never replayed. */
function isEmptyView(v: ReplayRow["view"]): boolean {
	return v.command === null && v.path === null && v.hunks.length === 0;
}

/** Every tool-event row of the collection tail: the views `rowToViews` presents, plus an empty-view row for a
 *  pre/post tool event it drops, so a post row with an empty action can still pair with its pre row (R6 F2). */
export async function readCallRows(file: string, tailBytes: number): Promise<ReplayRow[]> {
	const out: ReplayRow[] = [];
	if (!existsSync(file)) return out;
	const start = Math.max(0, statSync(file).size - tailBytes);
	const rl = createInterface({ input: createReadStream(file, { start, encoding: "utf8" }), crlfDelay: Infinity });
	let dropFirst = start > 0;
	for await (const line of rl) {
		if (dropFirst || !line) {
			dropFirst = false;
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const views = rowToViews(parsed);
		out.push(...(views.length > 0 ? views : emptyViewRow(parsed)));
	}
	return out;
}

/** The empty-view row for a pre/post tool event `rowToViews` dropped; none for any other row. */
function emptyViewRow(raw: unknown): ReplayRow[] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const r = raw as Record<string, unknown>;
	if (r.kind !== "tool_event" || (r.phase !== "pre" && r.phase !== "post")) return [];
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	const view: ReplayRow["view"] = { tool: str(r.provider_tool) ?? "", phase: r.phase, path: null, command: null, hunks: [] };
	return [{ session_id: str(r.session_id) ?? "", seq: typeof r.seq === "number" ? r.seq : -1, tool_use_id: str(r.tool_use_id), provider: str(r.provider), view }];
}

export interface PacketsReplayWindowsOpts {
	/** Newest N sessions of the logs to replay as turn windows. */
	sessions: number;
	tailMb?: number;
	json?: boolean;
	cwd?: string;
	/** Test seams. */
	fetchImpl?: JevFetch;
	resolveKey?: () => string | undefined;
	sample?: () => number;
}

/** Session ids in order of first appearance in the collection tail (append order). */
async function newestSessionIds(cwd: string, tailMb: number, n: number): Promise<string[]> {
	const seen: string[] = [];
	for await (const r of readCollectionRows(join(cwd, ".interlinked", "collection.jsonl"), tailMb * 1024 * 1024)) {
		if (!seen.includes(r.session_id)) seen.push(r.session_id);
	}
	return seen.slice(-n);
}

/** Exit codes: 0 replayed, 1 packet file unusable, 2 packets or jev disabled. */
export async function packetsReplayWindowsCommand(opts: PacketsReplayWindowsOpts): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const rules = loadRules(cwd);
	if (rules.packets?.enabled !== true || rules.jev?.enabled !== true) {
		console.error("packets replay-windows: needs packets.enabled and jev.enabled in guard-rules.local.json");
		return 2;
	}
	if (!loadPacketFileOrNull(cwd)) {
		console.error("packets replay-windows: no valid packet file; run `interlinked packets compile` first");
		return 1;
	}
	const tailMb = opts.tailMb ?? DEFAULT_TAIL_MB;
	const bytes = tailMb * 1024 * 1024;
	const deps: TrajectoryDeps = { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.resolveKey ? { resolveKey: opts.resolveKey } : {}), ...(opts.sample ? { sample: opts.sample } : {}), source: "replay" };
	const counts = { sessions: 0, windows: 0, rows: 0, judged: 0, settled: 0, gated: 0 };
	const ids = await newestSessionIds(cwd, tailMb, opts.sessions);
	const sources = await readWindowSources(join(cwd, ".interlinked", "collection.jsonl"), join(cwd, ".interlinked", "timeline.jsonl"), bytes, new Set(ids));
	for (const sessionId of ids) {
		counts.sessions++;
		const { calls, timeline, provider } = sources.get(sessionId) ?? { calls: [], timeline: [], provider: null };
		for (const window of turnWindows(sessionId, calls, timeline)) {
			counts.windows++;
			const rows = await runWindowEvaluation({ cwd, sessionId, kind: "turn", runnerSource: provider ?? "unknown", rules, deps, window });
			counts.rows += rows.length;
			counts.judged += rows.filter((r) => r.p !== null).length;
			counts.settled += rows.filter((r) => r.settled !== null).length;
			counts.gated += rows.filter((r) => r.gate !== null).length;
		}
	}
	if (opts.json) console.log(JSON.stringify(counts, null, 2));
	else console.log(`packets replay-windows: ${counts.sessions} sessions, ${counts.windows} windows; rows ${counts.rows}: ${counts.judged} judged by the model, ${counts.settled} settled by regex, ${counts.gated} gated`);
	return 0;
}
