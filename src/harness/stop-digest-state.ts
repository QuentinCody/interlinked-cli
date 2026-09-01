// ===========================================
// Stop-digest state + spool
// ===========================================
// Two pieces of durable state behind the Stop digest, kept in ONE module so
// the "what did the last Stop already say" question and the "where did the
// full detail go" question cannot drift apart:
//
//   1. `.interlinked/.stop-digest-state.json` — per-session fingerprints of
//      the findings reported at the PREVIOUS Stop this session. A Stop that
//      repeats the identical wall teaches the reader to skip it (the same
//      lesson `server/stop-nudge-throttle.ts` learned for nudges), so a
//      repeat Stop prints only what is NEW plus one line stating how many
//      rows resolved and how many are unchanged-and-suppressed.
//   2. `.interlinked/stop-digest.jsonl` — the spool. The digest is capped at
//      a handful of stderr lines; everything it trimmed is appended here so
//      nothing is lost, only relocated. Capped per session so a long session
//      cannot grow it without bound.
//
// Both writers honor `dryRun`. `interlinked harness test --write/--edit`
// sets `dry_run: true` on a synthetic event, and an evaluator that persists
// under a dry run turns a read-only probe into a state mutation (found the
// hard way 2026-08-04 — see CLAUDE.md "A dry run must not move the gate").
//
// Every write is best-effort: a read-only checkout or a full disk must never
// throw out of the Stop handler.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Basename of the per-session last-Stop snapshot. Dot-prefixed: it is daemon
 *  bookkeeping, not an artifact a human reads. */
export const STOP_DIGEST_STATE_FILE = ".stop-digest-state.json";

/** Basename of the full-detail spool the digest points at. */
export const STOP_DIGEST_SPOOL_FILE = "stop-digest.jsonl";

/** Sessions retained in the state file. Older entries are evicted oldest-first
 *  so a machine that runs hundreds of sessions keeps the file small. */
export const MAX_TRACKED_SESSIONS = 24;

/** Spool rows one session may append. Beyond this the digest still prints, but
 *  detail rows stop accumulating — a bounded file beats a complete one here. */
export const MAX_SPOOL_ROWS_PER_SESSION = 400;

/** One session's snapshot: when it was taken and which findings were open. */
interface StopDigestSessionSnapshot {
	/** ISO timestamp of the Stop that wrote this snapshot. */
	last_stop: string;
	/** Fingerprints of every finding reported open at that Stop. */
	open: string[];
	/** Spool rows written for this session so far (cap bookkeeping). */
	spooled: number;
	/** Warning tags already reported at a prior Stop this session — the
	 *  acknowledgment channel the mutation-kill-evidence nudge reads. */
	reported_tags?: string[];
}

interface StopDigestState {
	version: 1;
	sessions: Record<string, StopDigestSessionSnapshot>;
}

/** The minimum a finding must expose to be fingerprinted. Structurally
 *  satisfied by `PatternRescanFinding`; declared narrowly so this module never
 *  imports the rescan (which would make the dependency cycle-shaped). */
interface FingerprintableFinding {
	file: string;
	checkId: string;
	text: string;
}

/**
 * Line-number-free identity for a finding: same file, same check, same
 * normalized line text. Deliberately excludes the line number — the identical
 * philosophy as `pre-block-gate.ts::matchKey`. An unrelated edit that shifts a
 * flagged line must not make it read as newly-appeared at the next Stop.
 */
export function fingerprintFinding(f: FingerprintableFinding): string {
	return `${f.file} ${f.checkId} ${f.text.replace(/\s+/g, " ").trim()}`;
}

function emptyState(): StopDigestState {
	return { version: 1, sessions: {} };
}

/** Narrow an unknown value to a plain string-keyed record, or null. The one
 *  place this module converts `unknown` into something indexable — constructed,
 *  not cast, so a hand-edited state file can never smuggle a wrong shape past
 *  the type checker. */
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = v;
	return out;
}

/** Narrow an unknown parse result to a snapshot, or null. Constructed rather
 *  than cast — a hand-edited or truncated state file must degrade to "no prior
 *  Stop", never crash the Stop handler. */
function parseSnapshot(raw: unknown): StopDigestSessionSnapshot | null {
	const rec = asRecord(raw);
	if (rec === null) return null;
	const lastStop = typeof rec.last_stop === "string" ? rec.last_stop : null;
	if (lastStop === null) return null;
	const open = Array.isArray(rec.open)
		? rec.open.filter((v): v is string => typeof v === "string")
		: [];
	const spooled =
		typeof rec.spooled === "number" && Number.isFinite(rec.spooled) ? rec.spooled : 0;
	const tags = Array.isArray(rec.reported_tags)
		? rec.reported_tags.filter((v): v is string => typeof v === "string")
		: [];
	return { last_stop: lastStop, open, spooled, reported_tags: tags };
}

/** Read the state file. Any failure (absent, unreadable, malformed) yields an
 *  empty state: the digest then treats every finding as new, which is the
 *  loud-and-correct degrade. */
export function loadStopDigestState(interlinkedDir: string): StopDigestState {
	const path = join(interlinkedDir, STOP_DIGEST_STATE_FILE);
	let parsed: unknown;
	try {
		if (!existsSync(path)) return emptyState();
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		void err; // malformed / unreadable ⇒ behave as first Stop
		return emptyState();
	}
	const root = asRecord(parsed);
	const sessionsRaw = root === null ? null : asRecord(root.sessions);
	if (sessionsRaw === null) return emptyState();
	const sessions: Record<string, StopDigestSessionSnapshot> = {};
	for (const [id, value] of Object.entries(sessionsRaw)) {
		const snap = parseSnapshot(value);
		if (snap !== null) sessions[id] = snap;
	}
	return { version: 1, sessions };
}

/** Snapshot for one session, or null when this is its first Stop. */
export function priorSnapshot(
	state: StopDigestState,
	sessionId: string,
): StopDigestSessionSnapshot | null {
	return state.sessions[sessionId] ?? null;
}

interface StopDelta {
	/** Fingerprints open now that were not open at the previous Stop. */
	newIds: string[];
	/** Count open at the previous Stop and gone now. */
	resolved: number;
	/** Count open at both Stops — suppressed from the digest body. */
	unchanged: number;
	/** True when this session has no previous Stop, so nothing is suppressed. */
	firstStop: boolean;
}

/**
 * Compare the currently-open fingerprints against the previous Stop's. On the
 * first Stop of a session everything is new and nothing is suppressed.
 */
export function diffAgainstLastStop(
	prior: StopDigestSessionSnapshot | null,
	currentIds: readonly string[],
): StopDelta {
	if (prior === null) {
		return { newIds: [...currentIds], resolved: 0, unchanged: 0, firstStop: true };
	}
	const before = new Set(prior.open);
	const now = new Set(currentIds);
	const newIds = currentIds.filter((id) => !before.has(id));
	let unchanged = 0;
	let resolved = 0;
	for (const id of before) {
		if (now.has(id)) unchanged++;
		else resolved++;
	}
	return { newIds, resolved, unchanged, firstStop: false };
}

/** True when `tag` was already reported at a prior Stop of this session. The
 *  acknowledgment signal the mutation-kill-evidence nudge compresses on. */
export function wasTagReported(
	prior: StopDigestSessionSnapshot | null,
	tag: string,
): boolean {
	return prior?.reported_tags?.includes(tag) ?? false;
}

function ensureDir(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Evict oldest sessions past {@link MAX_TRACKED_SESSIONS}, by `last_stop`. */
function evictOldest(sessions: Record<string, StopDigestSessionSnapshot>): void {
	const ids = Object.keys(sessions);
	if (ids.length <= MAX_TRACKED_SESSIONS) return;
	const stamp = (id: string): number => Date.parse(sessions[id]?.last_stop ?? "") || 0;
	const ordered = ids.sort((a, b) => stamp(a) - stamp(b));
	for (const id of ordered.slice(0, ids.length - MAX_TRACKED_SESSIONS)) delete sessions[id];
}

interface RecordStopDigestStateArgs {
	interlinkedDir: string;
	sessionId: string;
	/** Fingerprints open at THIS Stop — the baseline the next Stop diffs on.
	 *  OMIT to leave the prior snapshot's list untouched: two writers run per
	 *  Stop (the rescan records fingerprints, the digest records tags), and a
	 *  tag-only write must not erase the fingerprints written moments earlier. */
	openIds?: readonly string[] | undefined;
	/** Warning tags emitted at this Stop, unioned with prior tags. */
	tags: readonly string[];
	/** Spool rows appended during this Stop, added to the running count. */
	spooledDelta?: number;
	dryRun?: boolean | undefined;
	now?: Date;
}

/** Persist this Stop's snapshot. No-op under `dryRun`. */
export function recordStopDigestState(args: RecordStopDigestStateArgs): void {
	if (args.dryRun === true) return;
	const path = join(args.interlinkedDir, STOP_DIGEST_STATE_FILE);
	try {
		const state = loadStopDigestState(args.interlinkedDir);
		const prior = priorSnapshot(state, args.sessionId);
		const tags = new Set([...(prior?.reported_tags ?? []), ...args.tags]);
		state.sessions[args.sessionId] = {
			last_stop: (args.now ?? new Date()).toISOString(),
			open: args.openIds === undefined ? (prior?.open ?? []) : [...args.openIds],
			spooled: (prior?.spooled ?? 0) + (args.spooledDelta ?? 0),
			reported_tags: [...tags],
		};
		evictOldest(state.sessions);
		ensureDir(path);
		writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
	} catch (err) {
		void err; // read-only tree / full disk — never throw out of Stop
	}
}

/** One spool row. Free-form payload so both the rescan detail and the digest
 *  overflow share a file without a discriminated schema per producer. */
export interface StopDigestSpoolRow {
	ts?: string;
	session?: string;
	kind: string;
	[extra: string]: unknown;
}

interface AppendStopDigestSpoolArgs {
	interlinkedDir: string;
	sessionId: string;
	rows: readonly StopDigestSpoolRow[];
	/** Rows already written this session (from the prior snapshot). */
	alreadySpooled?: number;
	dryRun?: boolean | undefined;
	now?: Date;
}

/**
 * Append detail rows to the spool, capped per session. Returns the number of
 * rows actually written (0 under `dryRun`, or when the cap is already spent),
 * which the caller feeds back into {@link recordStopDigestState}.
 */
export function appendStopDigestSpool(args: AppendStopDigestSpoolArgs): number {
	if (args.dryRun === true || args.rows.length === 0) return 0;
	const budget = MAX_SPOOL_ROWS_PER_SESSION - (args.alreadySpooled ?? 0);
	if (budget <= 0) return 0;
	const slice = args.rows.slice(0, budget);
	const ts = (args.now ?? new Date()).toISOString();
	const path = join(args.interlinkedDir, STOP_DIGEST_SPOOL_FILE);
	try {
		ensureDir(path);
		const body = slice
			.map((r) => JSON.stringify({ ts, session: args.sessionId, ...r }))
			.join("\n");
		appendFileSync(path, `${body}\n`);
		return slice.length;
	} catch (err) {
		void err; // best-effort: losing spool detail must not fail the Stop
		return 0;
	}
}
