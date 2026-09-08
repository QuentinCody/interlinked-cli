// ===========================================
// Break-glass — intentional gate bypass with a paper trail
// ===========================================
// Per `docs/design/harness-break-glass-primitive.md` (Pattern 11): a commit
// message containing the literal token `break glass` bypasses blocking
// checks. Always logged, never silently disabled. Rate-monitored; if the
// rate crosses ~1% the gate is probably miscalibrated.
//
// Scope for this module: detection, append-only logging, and rate stats.
// The enforcement wiring (actually letting the commit through) lives where
// the check-policy is consulted; that layer calls `detectBreakGlass` on the
// commit message before blocking.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { harnessNow } from "./replay/harness-clock.js";

/** Case-insensitive match for the literal token `break glass`. Enforces a
 *  word boundary so false positives on things like `breakglass.com` don't
 *  silently authorize overrides. */
const BREAK_GLASS_PATTERN = /\bbreak\s+glass\b/i;

export interface BreakGlassSignal {
	triggered: boolean;
	/** Everything after `break glass` up to EOL, trimmed. Captures the
	 *  user's stated reason when they wrote something like
	 *  `break glass: CI is down, need to ship fix`. */
	reason: string | null;
}

export function detectBreakGlass(commitMessage: string): BreakGlassSignal {
	if (!BREAK_GLASS_PATTERN.test(commitMessage)) {
		return { triggered: false, reason: null };
	}
	const reason = extractReason(commitMessage);
	return { triggered: true, reason };
}

function extractReason(message: string): string | null {
	// Capture trailing text on the SAME LINE as the `break glass` token. We
	// deliberately exclude newlines from the separator class (so \s would be
	// wrong here — it matches \n) to prevent the regex from bleeding into
	// the next line and picking up unrelated content like Co-authored-by.
	const match = /\bbreak\s+glass\b[:, \t-]*([^\n]*)/i.exec(message);
	if (!match?.[1]) return null;
	const cleaned = match[1].trim();
	return cleaned.length > 0 ? cleaned : null;
}

// -----------------------------------------------------------------------------
// Append-only log
// -----------------------------------------------------------------------------

export interface BreakGlassEntry {
	ts: string;
	user: string;
	session_id: string;
	tool: string;
	reason: string | null;
	commit_sha: string | null;
}

export function logPath(cwd: string): string {
	return join(cwd, ".interlinked", "break-glass-log.jsonl");
}

/** Append one override entry to the JSONL log. Swallows fs errors — the
 *  commit should never fail because the log couldn't be written. */
export function logBreakGlass(cwd: string, entry: BreakGlassEntry): void {
	const path = logPath(cwd);
	ensureDir(dirname(path));
	try {
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch {
		// Intentional: logging is best-effort. A missing log file is not
		// a reason to block the commit.
	}
}

/** Read the log. Malformed lines are skipped. Returns an empty array if the
 *  file is absent. */
export function readBreakGlassLog(cwd: string): BreakGlassEntry[] {
	const path = logPath(cwd);
	if (!existsSync(path)) return [];
	let text = "";
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const out: BreakGlassEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		const entry = tryParseEntry(line);
		if (entry) out.push(entry);
	}
	return out;
}

function tryParseEntry(line: string): BreakGlassEntry | null {
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const obj = parsed;
	if (typeof obj.ts !== "string") return null;
	if (typeof obj.user !== "string") return null;
	if (typeof obj.session_id !== "string") return null;
	if (typeof obj.tool !== "string") return null;
	return {
		ts: obj.ts,
		user: obj.user,
		session_id: obj.session_id,
		tool: obj.tool,
		reason: typeof obj.reason === "string" ? obj.reason : null,
		commit_sha: typeof obj.commit_sha === "string" ? obj.commit_sha : null,
	};
}

// -----------------------------------------------------------------------------
// Rate stats
// -----------------------------------------------------------------------------

export interface BreakGlassStats {
	/** Number of break-glass entries in the last `windowMs`. */
	recent_count: number;
	/** The timestamp of the earliest entry counted. */
	since: string | null;
	/** Number of distinct days with at least one entry. */
	distinct_days: number;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Roll up recent break-glass usage. Caller supplies the window (default
 *  7 days). Rate interpretation is the caller's responsibility — we only
 *  hand back the raw count; division by total commits/events requires
 *  coordinating with the broader telemetry spool.
 *
 *  `clock` is injectable so tests can pin "now" without monkey-patching
 *  globals; production callers omit it and get `Date.now`. */
export function summarizeBreakGlass(
	cwd: string,
	windowMs: number = DEFAULT_WINDOW_MS,
	clock: () => number = harnessNow,
): BreakGlassStats {
	const entries = readBreakGlassLog(cwd);
	const cutoff = clock() - windowMs;
	const recent: BreakGlassEntry[] = [];
	const distinctDays = new Set<string>();
	for (const entry of entries) {
		const t = Date.parse(entry.ts);
		if (!Number.isFinite(t) || t < cutoff) continue;
		recent.push(entry);
		distinctDays.add(entry.ts.slice(0, 10));
	}
	return {
		recent_count: recent.length,
		since: recent.length > 0 ? nonNull(recent[0]).ts : null,
		distinct_days: distinctDays.size,
	};
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}
