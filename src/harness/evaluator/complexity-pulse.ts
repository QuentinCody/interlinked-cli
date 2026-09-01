// ===========================================
// Per-edit cyclomatic pulse — ambient PostToolUse complexity telemetry
// ===========================================
// Closes the "metrics are pull-only" gap: every per-tool-call surface (the
// strict cyclomatic gate, the coverage/CRAP gates) only speaks when a
// threshold is crossed, so the numbers otherwise exist solely behind
// `interlinked metrics`. This module pushes the cyclomatic profile of every
// edited code file back to the agent as ONE non-blocking PostToolUse context
// line — absolute values plus the edit's delta — making complexity ambient
// telemetry rather than pull-only.
//
// Cost model: the gate (complexity-write-guard.ts) ALREADY parses both the
// before- and after-content of every gated Write/Edit and discards the
// entries unless a function crossed the cap. PreToolUse stashes those
// already-paid parses via the gate's observer (keyed by session + absolute
// path, with the projected after-content's sha256); PostToolUse consumes the
// stash only when the on-disk bytes match that hash — a mismatch (user denied
// the call, a later gate blocked it, a racing writer won) discards the
// snapshot rather than reporting a state that never landed. On a stash miss
// for a governed code file it falls back to ONE on-disk parse and reports
// absolutes without the delta. Steady-state marginal cost per edit is a file
// read + hash; no extra AST parse.
//
// Population matches the gate exactly: cappable hand-written code files in a
// language with a cyclomatic analyzer (tests / generated / non-code skipped).
// Names are phrasing only, never decisions — anonymous "(callback)" entries
// contribute to ΣCC but are not name-matched across before/after.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type AstProfile, astProfile, structuralDelta } from "../checks/ast-delta.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { isCappableFile } from "../large-file-policy.js";
import { maxCyclomaticFor } from "../metric-caps.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { HarnessEvent } from "../types.js";
import { DEFAULT_MAX_CYCLOMATIC, selectAnalyzer } from "./complexity-write-guard.js";
import { isFileWrite } from "./tool-classifiers.js";

/** Stash capacity — bounds daemon memory; oldest-first eviction. */
export const MAX_STASH_ENTRIES = 256;
/** Most files profiled per event (an apply_patch can carry many sections). */
export const MAX_FILES_PER_EVENT = 4;
/** Most per-name deltas spelled out on one pulse line. */
const MAX_NAMED_DELTAS = 3;
/** Most over-cap functions listed on one pulse line. */
const MAX_OVER_CAP_LISTED = 3;
/** AST name for anonymous functions — not matchable across before/after
 *  (mirrors complexity-write-guard's ANON_FN). */
const ANON_FN = "(callback)";

/** One stashed pre-edit analysis, awaiting its PostToolUse. */
interface PulseSnapshot {
	beforeFns: FunctionComplexityEntry[];
	afterFns: FunctionComplexityEntry[];
	/** sha256 of the projected after-content — consumed only on an exact match. */
	afterHash: string;
	/** AST semantic profiles (7c); optional so older stash shapes stay valid.
	 *  null/undefined = non-JS/TS file or `typescript` unavailable. */
	beforeProfile?: AstProfile | null;
	afterProfile?: AstProfile | null;
}

const stash = new Map<string, PulseSnapshot>();

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function stashKey(sessionId: string, absPath: string): string {
	return `${sessionId}\u0000${absPath}`;
}

/**
 * PreToolUse side: capture the gate's already-computed before/after entries
 * for one analyzed file (wired as the gate's observer in pre-tool-phases.ts).
 * Re-recording a key refreshes it; the oldest snapshot is evicted past the cap.
 */
export function recordComplexityPulse(
	sessionId: string,
	absPath: string,
	beforeFns: FunctionComplexityEntry[],
	afterFns: FunctionComplexityEntry[],
	afterContent: string,
): void {
	const key = stashKey(sessionId, absPath);
	// 7c: at PreToolUse the on-disk bytes ARE the before-state, so both AST
	// profiles are computable here with zero caller changes. Cost: two extra
	// parses per edited code file (~ms each), accepted for zero blast radius
	// on the gate. A new file (nothing on disk) has no before profile.
	let beforeProfile: AstProfile | null = null;
	try {
		beforeProfile = astProfile(readFileSync(absPath, "utf-8"), absPath);
	} catch {
		beforeProfile = null;
	}
	const afterProfile = astProfile(afterContent, absPath);
	stash.delete(key); // re-insert at the tail so eviction stays oldest-first
	stash.set(key, {
		beforeFns,
		afterFns,
		afterHash: sha256(afterContent),
		beforeProfile,
		afterProfile,
	});
	if (stash.size > MAX_STASH_ENTRIES) {
		const oldest = stash.keys().next().value;
		if (oldest !== undefined) stash.delete(oldest);
	}
}

/**
 * PostToolUse side: consume (delete-on-read) the stashed snapshot, but only
 * when the on-disk content matches the projected after-content. A mismatch
 * means the write the snapshot describes never landed — the snapshot is
 * dropped, never reported.
 */
export function consumeComplexityPulse(
	sessionId: string,
	absPath: string,
	diskContent: string,
): PulseSnapshot | null {
	const key = stashKey(sessionId, absPath);
	const snap = stash.get(key);
	if (!snap) return null;
	stash.delete(key);
	return snap.afterHash === sha256(diskContent) ? snap : null;
}

/** Test-only: clear the stash so suites are order-independent. */
export function __resetComplexityPulseForTesting(): void {
	stash.clear();
}

function sumCC(fns: readonly FunctionComplexityEntry[]): number {
	let total = 0;
	for (const f of fns) total += f.cyclomatic;
	return total;
}

/** name → max cyclomatic among same-named functions (anonymous skipped). */
function nameMaxMap(fns: readonly FunctionComplexityEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const f of fns) {
		if (f.name === ANON_FN) continue;
		m.set(f.name, Math.max(m.get(f.name) ?? 0, f.cyclomatic));
	}
	return m;
}

function signed(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

interface NamedDelta {
	label: string;
	magnitude: number;
}

/** Best-effort per-name deltas (phrasing only): changed / new / removed, by
 *  max-CC per name, sorted by |Δ| descending. */
function namedDeltas(
	before: readonly FunctionComplexityEntry[],
	after: readonly FunctionComplexityEntry[],
): NamedDelta[] {
	const beforeMap = nameMaxMap(before);
	const afterMap = nameMaxMap(after);
	const out: NamedDelta[] = [];
	for (const [name, cc] of afterMap) {
		const prior = beforeMap.get(name);
		if (prior === undefined) out.push({ label: `${name} new=${cc}`, magnitude: cc });
		else if (prior !== cc)
			out.push({ label: `${name} ${prior}→${cc}`, magnitude: Math.abs(cc - prior) });
	}
	for (const [name, cc] of beforeMap) {
		if (!afterMap.has(name)) out.push({ label: `${name} removed (was ${cc})`, magnitude: cc });
	}
	out.sort((a, b) => b.magnitude - a.magnitude);
	return out;
}

/**
 * The one-line pulse, or null when there is nothing to say (no functions on
 * either side). `beforeFns === null` means no pre-edit snapshot was available
 * (stash miss) — absolutes only, no Δ.
 */
export function formatComplexityPulse(
	displayPath: string,
	beforeFns: readonly FunctionComplexityEntry[] | null,
	afterFns: readonly FunctionComplexityEntry[],
	cap: number = DEFAULT_MAX_CYCLOMATIC,
	profiles?: { before: AstProfile | null; after: AstProfile | null },
): string | null {
	if (afterFns.length === 0 && (beforeFns?.length ?? 0) === 0) return null;

	const total = sumCC(afterFns);
	let line = `[interlinked:cyclomatic] ${displayPath}: ${afterFns.length} fns, ΣCC ${total}`;
	if (beforeFns) line += ` (Δ${signed(total - sumCC(beforeFns))})`;

	if (afterFns.length > 0) {
		const max = afterFns.reduce((m, f) => (f.cyclomatic > m.cyclomatic ? f : m));
		line += `, max ${max.name}=${max.cyclomatic} (cap ${cap})`;
	}

	if (beforeFns) {
		const deltas = namedDeltas(beforeFns, afterFns);
		if (deltas.length > 0) {
			// fnΔ — how many distinct functions this ONE edit moved.
			//
			// Ambient measurement, not a gate (2026-07-28). Every per-edit ratchet
			// (cyclomatic slew +2/edit, coverage delta, mutation site count) is
			// calibrated on the resolution of a single edit; an edit that moves
			// eight functions at once is gated as one aggregate delta rather than
			// eight steps. Whether that actually correlates with worse outcomes is
			// unknown, so this counts it and says nothing — see
			// docs/design/per-edit-symbol-resolution.md for the question this is
			// collecting evidence for, and the query that answers it.
			//
			// UNDERCOUNTS on purpose: derived from the complexity deltas already
			// computed here, so it sees a function added, removed, or changed in
			// branch count — NOT one whose body changed without moving its
			// cyclomatic number (a renamed local, a different string). A cheap
			// lower bound beats a second AST walk on the hot path.
			line += `; fnΔ ${deltas.length}`;
			const shown = deltas
				.slice(0, MAX_NAMED_DELTAS)
				.map((d) => d.label)
				.join(", ");
			const more = deltas.length - MAX_NAMED_DELTAS;
			line += `; Δ fns: ${shown}${more > 0 ? `, +${more} more` : ""}`;
		}
	}

	// The repo's effective cap, not the hard-coded default (deep-round #11):
	// a repo configured for cap 10 must not report CC 20 as under cap.
	const overCap = afterFns
		.filter((f) => f.cyclomatic > cap)
		.sort((a, b) => b.cyclomatic - a.cyclomatic);
	if (overCap.length > 0) {
		const shown = overCap
			.slice(0, MAX_OVER_CAP_LISTED)
			.map((f) => `${f.name}=${f.cyclomatic}`)
			.join(", ");
		const more = overCap.length - MAX_OVER_CAP_LISTED;
		line += `; over cap: ${shown}${more > 0 ? `, +${more} more` : ""}`;
	}

	// 7c segment: cognitive total (+Δ when a before profile exists) and the
	// structural size of the edit — a rename reads as astΔ 0 while a rewritten
	// conditional reads nonzero, which textual line counts cannot distinguish.
	const after = profiles?.after;
	if (after) {
		line += `; cogΣ ${after.cogTotal}`;
		const before = profiles.before;
		if (before) {
			line += ` (Δ${signed(after.cogTotal - before.cogTotal)}); astΔ ${structuralDelta(before, after)}`;
		}
	}
	return line;
}

/** The pulse line for one on-disk file, or null (unreadable, not a governed
 *  code file, analyzer unavailable, or nothing to say). */
function pulseForFile(sessionId: string, cwd: string, absPath: string): string | null {
	let disk: string;
	try {
		disk = readFileSync(absPath, "utf-8");
	} catch {
		return null; // deleted / unreadable — nothing to profile
	}

	const snap = consumeComplexityPulse(sessionId, absPath, disk);
	let beforeFns: readonly FunctionComplexityEntry[] | null;
	let afterFns: FunctionComplexityEntry[] | null;
	let profiles: { before: AstProfile | null; after: AstProfile | null } | undefined;
	if (snap) {
		({ beforeFns, afterFns } = snap);
		profiles = { before: snap.beforeProfile ?? null, after: snap.afterProfile ?? null };
	} else {
		// Stash miss (daemon restarted, runner without a PreToolUse, projected
		// content never landed): one on-disk parse, absolutes only. Same
		// population filter as the gate.
		if (!isCappableFile({ filePath: absPath, content: disk, root: cwd })) return null;
		const analyzer = selectAnalyzer(absPath);
		if (!analyzer) return null;
		beforeFns = null;
		afterFns = analyzer.compute(disk, absPath);
		// 7c on a miss: absolutes only, same as the CC columns.
		profiles = { before: null, after: astProfile(disk, absPath) };
	}
	if (!afterFns) return null;

	const rel = relative(cwd, absPath);
	const display = rel === "" || rel.startsWith("..") ? absPath : rel;
	// Production path must use the repo's effective cap, not the default
	// (round-2 #38 — round-1 fixed the formatter but not this caller).
	return formatComplexityPulse(display, beforeFns, afterFns, maxCyclomaticFor(cwd), profiles);
}

/**
 * PostToolUse entry — one pulse line per edited code file, bounded per event.
 * Never blocks; returns [] for non-write tools and ungoverned files.
 */
export function collectComplexityPulseWarnings(event: HarnessEvent): string[] {
	if (!isFileWrite(event.tool_name || "")) return [];
	const cwd = event.cwd || process.cwd();
	const warnings: string[] = [];
	for (const path of extractAllEditedFilePaths(event).slice(0, MAX_FILES_PER_EVENT)) {
		const abs = isAbsolute(path) ? path : resolve(cwd, path);
		const line = pulseForFile(event.session_id, cwd, abs);
		if (line) warnings.push(line);
	}
	return warnings;
}
