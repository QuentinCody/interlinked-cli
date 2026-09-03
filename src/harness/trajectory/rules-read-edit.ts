// ===========================================
// Deterministic Trajectory-Analysis Engine — Family 9: Read/Edit Balance
// ===========================================
//
// "Acting on unseen content" signals — the trajectory encoding of this repo's
// measured best-model profile (orient before editing; prefer surgical edits).
// Every rule is a pure `(state, event) => Verdict | null` over the folded
// read/edit-balance substrate (`fileReadSteps` / `readCount` / `searchCount`,
// state.ts) plus the bounded `recentEvents` window. Per the catalog these are
// NUDGE / SILENT_METRIC, never block — a blind edit is a discipline signal,
// not deterministic harm.
//
// Read-set matching is deliberately LOOSE (exact key, path-suffix, or basename
// via `lastReadStep`): pseudo-reads recorded from bash commands may be
// relative while edits are absolute, and a loose match only ever SUPPRESSES a
// rule — over-matching is FP-safe by construction.
//
// Catalog rules skipped here (see the dedupe map in index.ts): the ones the
// older ACTIVE sequence-checks system or the churn family already covers, and
// the ones needing line-range read windows / search-result sets the shadow
// normalizer does not forward.

import { isSourceCodeFile } from "./helpers.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

function nudge(ruleId: string, severity: Verdict["severity"], reason: string): Verdict {
	return { ruleId, action: "nudge", severity, reason };
}
function metric(ruleId: string, reason: string): Verdict {
	return { ruleId, action: "silent_metric", severity: "low", reason };
}

/** Last path segment (pure string math — no node:path). */
function baseName(p: string): string {
	const segs = p.split("/");
	return segs[segs.length - 1] ?? p;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** A PostToolUse surgical edit (Edit/MultiEdit with an old_string — the tools
 *  that can only target an EXISTING file; Write may create one). */
function isPostSurgicalEdit(event: ToolEvent): boolean {
	return (
		event.hook === "PostToolUse" &&
		(event.tool === "Edit" || event.tool === "MultiEdit") &&
		!!event.input.file_path &&
		!!event.input.old_string
	);
}

/**
 * The step of the most recent read (Read tool or bash pseudo-read) that
 * plausibly covered `file`, or null. Matches the exact key, a recorded
 * relative path that suffixes `file`, or a bare-basename token.
 */
function lastReadStep(state: TrajectoryState, file: string): number | null {
	const exact = state.fileReadSteps.get(file);
	if (exact !== undefined) return exact;
	const base = baseName(file);
	let best: number | null = null;
	for (const [k, step] of state.fileReadSteps) {
		const hit = file.endsWith(`/${k}`) || k === base || k.endsWith(`/${base}`);
		if (hit && (best === null || step > best)) best = step;
	}
	return best;
}

/** True once the session has oriented at all: any Read, search, or pseudo-read. */
function sessionHasOriented(state: TrajectoryState): boolean {
	return state.readCount > 0 || state.searchCount > 0 || state.fileReadSteps.size > 0;
}

/** Total edit records across every file (early exit above `limit`). */
function editRecordsExceed(state: TrajectoryState, limit: number): boolean {
	let total = 0;
	for (const log of state.fileEditLog.values()) {
		total += log.length;
		if (total > limit) return true;
	}
	return false;
}

// ============================================================
// reb_blind_edit_unread_file (N/M)
// ============================================================
// A surgical Edit to an existing source file the session never read, grepped,
// or previously edited. FP guards (per catalog): a bash pseudo-read naming the
// path counts as a read; a SINGLE-LINE old_string is suppressed (grep output
// alone locates a one-liner, so it is not "unseen").
export const rebBlindEditUnreadFile: TrajectoryRule = (state, event) => {
	if (!isPostSurgicalEdit(event)) return null;
	const file = event.input.file_path ?? "";
	const oldStr = event.input.old_string ?? "";
	if (!isSourceCodeFile(file)) return null;
	if (!oldStr.includes("\n")) return null; // targeted one-line replacement
	if (lastReadStep(state, file) !== null) return null;
	// This edit is already folded, so >1 record means a PRIOR same-file edit.
	if ((state.fileEditLog.get(file)?.length ?? 0) > 1) return null;
	return nudge(
		"reb_blind_edit_unread_file",
		"medium",
		`Multi-line edit to ${baseName(file)}, which this session never read or grepped. ` +
			"Editing unseen content risks clobbering context the file's surroundings depend on — " +
			"read the region first.",
	);
};

// ============================================================
// reb_cold_start_first_edit_zero_reads (N/L)
// ============================================================
// The session's very FIRST edit is a surgical edit to an existing file while
// the session has done zero reads and zero searches — editing before any
// orientation at all. One-shot (only the first edit can fire).
export const rebColdStartFirstEditZeroReads: TrajectoryRule = (state, event) => {
	if (!isPostSurgicalEdit(event)) return null;
	if (sessionHasOriented(state)) return null;
	if (editRecordsExceed(state, 1)) return null; // not the first edit
	// Catalog FP-guard ("suppress compaction/continuation marker + verbatim user
	// patch") — the common post-compaction/resume case where the agent applies a
	// fully-specified patch cold. Lifecycle markers (SessionStart/PreCompact) are
	// filtered before the shadow engine (server/trajectory-shadow.ts), so the
	// computable proxy is the verbatim/targeted-patch SHAPE: a single-line
	// old_string is a locatable, fully-specified replacement — the same "not
	// unseen" carve-out reb_blind_edit_unread_file applies, and the "change fully
	// specified upfront" exception this rule's own message already names. A
	// multi-line first edit (a substantial unseen region) still fires.
	if (!(event.input.old_string ?? "").includes("\n")) return null;
	return nudge(
		"reb_cold_start_first_edit_zero_reads",
		"low",
		"First edit of the session with zero reads and zero searches beforehand — editing an " +
			"existing file cold. Orient first (read the file or search for its usages) unless the " +
			"change was fully specified upfront.",
	);
};

// ============================================================
// reb_read_recency_decay_edit (M — silent_metric)
// ============================================================
// An edit to a file whose last read is stale: >40 steps ago AND >70% of the
// recent window is unrelated to the file (neither its path nor its basename
// appears). Both conditions per the catalog — staleness alone is normal when
// the intervening work stayed on-topic. Never-read files are the blind-edit
// rule's territory, not decay.
const RECENCY_GAP_STEPS = 40;
const UNRELATED_FRACTION = 0.7;

/** Fraction of window events (excluding `event`) unrelated to `file`. */
function unrelatedFraction(state: TrajectoryState, event: ToolEvent, file: string): number {
	const base = baseName(file);
	let total = 0;
	let unrelated = 0;
	for (const e of state.recentEvents) {
		if (e === event) continue;
		total += 1;
		const related = e.input.file_path === file || (e.input.command ?? "").includes(base);
		if (!related) unrelated += 1;
	}
	return total === 0 ? 0 : unrelated / total;
}

export const rebReadRecencyDecayEdit: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || !EDIT_TOOLS.has(event.tool)) return null;
	const file = event.input.file_path;
	if (!file || !isSourceCodeFile(file)) return null;
	const last = lastReadStep(state, file);
	if (last === null) return null;
	const gap = state.stepCount - last;
	if (gap <= RECENCY_GAP_STEPS) return null;
	if (unrelatedFraction(state, event, file) <= UNRELATED_FRACTION) return null;
	return metric(
		"reb_read_recency_decay_edit",
		`Editing ${baseName(file)} ${gap} steps after it was last read, with the intervening ` +
			"work almost entirely elsewhere — the mental model of this file may be stale.",
	);
};

// ============================================================
// reb_read_storm_no_edit (M — silent_metric)
// ============================================================
// A run of ≥10 distinct file Reads with no edit — possibly lost, possibly a
// legitimate survey (hence metric-only, per the catalog's FP note). Fires
// exactly once per run, at the 10th distinct file.
const READ_STORM_DISTINCT = 10;

/** Parent directory of a path (pure string math; "" when it has no separator). */
function dirOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(0, idx) : "";
}

/**
 * The largest number of `files` sharing a single parent directory. The shadow
 * engine has no import graph, so directory co-location is the closest computable
 * proxy for the catalog's "dependency density" condition: a run dominated by one
 * module directory is a focused, likely-related survey (HIGH density), whereas a
 * run with no dominant directory is the scattered, low-density "lost" shape.
 */
function maxSameDirCount(files: Iterable<string>): number {
	const byDir = new Map<string, number>();
	let max = 0;
	for (const f of files) {
		const dir = dirOf(f);
		const n = (byDir.get(dir) ?? 0) + 1;
		byDir.set(dir, n);
		if (n > max) max = n;
	}
	return max;
}

/** How one scanned event affects the read-storm run: `continue` past it,
 *  `break` the run (an edit occurred), `stop` the whole rule (a re-read of
 *  the crossing file), or carry the newly-seen distinct file path to add. */
type ReadStormStep = "continue" | "break" | "stop" | { readonly add: string };

function classifyReadStormEvent(e: ToolEvent | undefined, event: ToolEvent, file: string): ReadStormStep {
	if (!e || e.hook !== "PostToolUse") return "continue";
	if (EDIT_TOOLS.has(e.tool)) return "break"; // an edit ends the run
	if (e.tool !== "Read" || !e.input.file_path) return "continue";
	// A prior in-run read of the same file means this is a re-read, not a
	// new distinct file — never the crossing event.
	if (e !== event && e.input.file_path === file) return "stop";
	return { add: e.input.file_path };
}

export const rebReadStormNoEdit: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || event.tool !== "Read") return null;
	const file = event.input.file_path;
	if (!file) return null;
	const distinct = new Set<string>();
	const ev = state.recentEvents;
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		const step = classifyReadStormEvent(e, event, file);
		if (step === "continue") continue;
		if (step === "break") break;
		if (step === "stop") return null;
		distinct.add(step.add);
	}
	if (distinct.size !== READ_STORM_DISTINCT) return null;
	// Catalog FP-guard: fire only on a LOW-dependency-density run (unrelated
	// reads) — a coherent module survey is a legitimate, deliberate exploration.
	// Proxy (no import graph in the shadow engine): suppress when a strict
	// majority of the distinct reads share one directory (a dominant module ⇒
	// the reads are related). Only a directory-dispersed run survives.
	if (maxSameDirCount(distinct) * 2 > distinct.size) return null;
	return metric(
		"reb_read_storm_no_edit",
		`${READ_STORM_DISTINCT} distinct files read in a row with no edit. A long survey can be ` +
			"deliberate — but if the goal was a change, it may be time to converge on one.",
	);
};

// ============================================================
// reb_import_added_without_reading_module (M — silent_metric)
// ============================================================
// An edit ADDS a relative import of a local module the session never read,
// pseudo-read, or wrote. Package imports are exempt (registry deps, not local
// orientation); modules this session CREATED count as known (the standard
// "land the exporter first, then the importers" flow never fires).
const IMPORT_SPEC_RE = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)['"](\.\.?\/[^'"\n]+)['"]/g;
const JS_TS_FILE_RE = /\.[cm]?[jt]sx?$/;
const MODULE_EXT_RE = /\.(?:[cm]?[jt]sx?|json)$/;

/** Relative import specifiers appearing in `text`. */
function relativeImportSpecs(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(IMPORT_SPEC_RE)) {
		if (m[1]) out.add(m[1]);
	}
	return out;
}

/** Pure ../-aware join of `rel` onto `dir`, extension stripped. */
function resolveRelative(dir: string, rel: string): string {
	const parts = dir.split("/").filter((s) => s.length > 0 && s !== ".");
	for (const seg of rel.replace(MODULE_EXT_RE, "").split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return (dir.startsWith("/") ? "/" : "") + parts.join("/");
}

/** True when a read/edited path plausibly IS `resolved` (extension-insensitive,
 *  suffix-tolerant both ways for relative pseudo-read keys, index-file aware). */
function moduleKnown(state: TrajectoryState, resolved: string): boolean {
	const keys = [...state.fileReadSteps.keys(), ...state.fileEditLog.keys()];
	for (const k of keys) {
		const kn = k.replace(MODULE_EXT_RE, "");
		if (
			kn === resolved ||
			kn === `${resolved}/index` ||
			resolved.endsWith(`/${kn}`) ||
			kn.endsWith(`/${resolved}`)
		) {
			return true;
		}
	}
	return false;
}

export const rebImportAddedWithoutReadingModule: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || !EDIT_TOOLS.has(event.tool)) return null;
	const file = event.input.file_path;
	if (!file || !JS_TS_FILE_RE.test(file)) return null;
	const added = event.input.new_string ?? event.input.content ?? "";
	if (!added) return null;
	const before = relativeImportSpecs(event.input.old_string ?? "");
	const dir = file.split("/").slice(0, -1).join("/");
	const unknown: string[] = [];
	for (const spec of relativeImportSpecs(added)) {
		if (before.has(spec)) continue; // pre-existing import, merely touched
		if (!moduleKnown(state, resolveRelative(dir, spec))) unknown.push(spec);
	}
	if (unknown.length === 0) return null;
	return metric(
		"reb_import_added_without_reading_module",
		`Imported ${unknown.slice(0, 3).join(", ")} without ever reading or writing the module — ` +
			"the imported surface (names, signatures) is assumed, not seen. A typecheck will confirm " +
			"resolution, but not intent.",
	);
};

/** All Family-9 read/edit-balance rules. */
export const READ_EDIT_RULES: ReadonlyArray<TrajectoryRule> = [
	rebBlindEditUnreadFile,
	rebColdStartFirstEditZeroReads,
	rebReadRecencyDecayEdit,
	rebReadStormNoEdit,
	rebImportAddedWithoutReadingModule,
];
