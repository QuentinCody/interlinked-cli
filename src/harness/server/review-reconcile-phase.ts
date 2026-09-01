// Review-finding reconciliation hooks (docs/design/spec-audit-runtime-checks.md
// §4 + §6.3): touch tracking at PostToolUse, and disputed-ground warnings
// when the session reads or builds on a file that still carries open review
// findings — the compounding threshold made visible. Evidence only; closure
// is always an edit or an explicit ack.

import { realpathSync, statSync } from "node:fs";
import { relative } from "node:path";
import { type Finding, findingsCorpusPath, loadFindings } from "../findings/corpus.js";
import {
	appendReconciliationTxn,
	loadReconciliation,
	reconciliationPath,
	reconciliationStateOf,
} from "../spec/reconciliation.js";
import type { HarnessEvent } from "../types.js";

/** Ingested-review rows are identified by their bug_class prefix. */
function isReviewFinding(f: Finding): boolean {
	return f.bug_class.startsWith("review_");
}

interface CorpusCache {
	cwd: string;
	/** Combined mtime signature of the corpus + reconciliation files. */
	sig: string;
	open: Finding[];
}

let cache: CorpusCache | null = null;

/** mtime signature of the two state files — 0 for a missing file. Invalidates
 *  the cache the instant an external CLI process ingests or acks a finding,
 *  so a warm daemon never serves a stale open-set (deep-round #13). */
function stateSignature(cwd: string): string {
	// mtime + size + inode (round-2 #35): mtime alone can be preserved by a
	// coarse-clock or timestamp-restoring write, but a real external ingest/ack
	// changes the file's size (append-only logs only grow) or inode (atomic
	// rewrite). Combining all three closes the stale-cache window.
	const sig = (p: string): string => {
		try {
			const s = statSync(p);
			return `${s.mtimeMs}/${s.size}/${s.ino}`;
		} catch {
			return "0";
		}
	};
	return `${sig(findingsCorpusPath(cwd))}:${sig(reconciliationPath(cwd))}`;
}

/** Open (neither touched nor acked) review findings, cached until either
 *  state file changes on disk. */
export function openReviewFindings(cwd: string): Finding[] {
	const sig = stateSignature(cwd);
	if (cache && cache.cwd === cwd && cache.sig === sig) return cache.open;
	let open: Finding[] = [];
	try {
		const recon = loadReconciliation(cwd);
		open = loadFindings(cwd)
			.filter(isReviewFinding)
			.filter((f) => reconciliationStateOf(recon, f.id) === "open");
	} catch {
		// Advisory surface: an unreadable corpus means nothing to report.
		open = [];
	}
	cache = { cwd, sig, open };
	return open;
}

/** Test seam. */
export function resetReviewReconcileCacheForTesting(): void {
	cache = null;
	touchRecorded.clear();
	warned.clear();
}

/** realpath a path, falling back to the input when it can't be resolved
 *  (not on disk yet). Canonicalizes in-root symlink aliases so edit paths and
 *  ingested finding paths compare equal (round-2 #12). */
function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** repo-relative posix path (empty when outside the repo). Both sides are
 *  realpath-canonicalized so an edit through `alias/plan.md` matches a finding
 *  stored as `docs/plan.md` when `alias -> docs`. */
function toRel(cwd: string, absPath: string): string {
	const rel = relative(canonical(cwd), canonical(absPath)).split("\\").join("/");
	return rel.startsWith("..") ? "" : rel;
}

/** Once-per-session guards (daemon-lifetime module state, complexity-pulse
 *  precedent). The warn key includes the MODE: read and write are separate
 *  anti-compounding channels, and an earlier read must not swallow the
 *  later, more consequential write warning (round-5 #5). */
const touchRecorded = new Set<string>();
const warned = new Set<string>();
/** Bound the guard sets so a long-running daemon can't grow them without
 *  limit (round-2 #36). At the cap, clear (coarse LRU); the worst case is one
 *  advisory warning re-firing after a reset — acceptable for a nudge. Exported
 *  with an injectable cap so the eviction path is unit-testable. */
export const GUARD_SET_CAP = 20_000;
export function boundedAdd(set: Set<string>, key: string, cap = GUARD_SET_CAP): void {
	if (set.size >= cap) set.clear();
	set.add(key);
}

/** An inclusive 1-based line range. */
export interface LineRange {
	start: number;
	end: number;
}

/** Slack around cited lines when matching ranges. */
const RANGE_SLACK = 3;

/** Whether a line-anchored finding overlaps any range (±slack). */
function overlapsRanges(line: number, ranges: LineRange[]): boolean {
	return ranges.some(
		(r) => line >= r.start - RANGE_SLACK && line <= r.end + RANGE_SLACK,
	);
}

/** Span contract (round-5 #1): with known edited ranges, a line-anchored
 *  finding is touched only when an edit overlapped its cited region;
 *  unanchored findings touch on any file edit; with no range data the
 *  file-level fallback stands. */
function touchApplies(
	f: Finding,
	rel: string,
	editedRanges: LineRange[] | undefined,
): boolean {
	if (f.file !== rel) return false;
	if (!editedRanges || editedRanges.length === 0) return true;
	if (f.line <= 0) return true;
	return overlapsRanges(f.line, editedRanges);
}

/**
 * PostToolUse (writes): an edit to a file with open review findings marks
 * them "touched" in the reconciliation sidecar — the deterministic layer
 * never claims "resolved", only that the cited region was visited.
 */
export function recordReviewFindingTouches(
	cwd: string,
	sessionId: string,
	editedFilePath: string,
	editedRanges?: LineRange[],
): void {
	const rel = toRel(cwd, editedFilePath);
	if (!rel) return;
	for (const f of openReviewFindings(cwd)) {
		if (!touchApplies(f, rel, editedRanges)) continue;
		const key = `${sessionId} ${f.id}`;
		if (touchRecorded.has(key)) continue;
		boundedAdd(touchRecorded, key);
		appendReconciliationTxn(cwd, {
			finding_id: f.id,
			action: "touched",
			by: sessionId,
			file: rel,
			ts: new Date().toISOString(),
		});
		cache = null; // the finding is no longer open
	}
}

/** Max findings quoted in a disputed-ground warning. */
const MAX_QUOTED = 2;

/**
 * Disputed-ground warning (§6.3 channels 1–2): the session is reading or
 * building on a file that still carries open review findings. Once per
 * (session, mode, file); a ranged read only disputes findings its range
 * overlaps (round-5 #6). Returns null when clean.
 */
export function disputedGroundWarning(
	cwd: string,
	sessionId: string,
	filePath: string,
	mode: "read" | "write",
	lineRange?: LineRange,
): string | null {
	const rel = toRel(cwd, filePath);
	if (!rel) return null;
	const open = openReviewFindings(cwd).filter(
		(f) =>
			f.file === rel &&
			(!lineRange || f.line <= 0 || overlapsRanges(f.line, [lineRange])),
	);
	if (open.length === 0) return null;
	const key = `${sessionId} ${mode} ${rel}`;
	if (warned.has(key)) return null;
	boundedAdd(warned, key);
	const quoted = open
		.slice(0, MAX_QUOTED)
		.map((f) => `${f.id.slice(0, 40)}… ${f.message.slice(0, 80)}`)
		.join("; ");
	const verb =
		mode === "read"
			? "reading from disputed ground — content you derive from it may inherit the defect"
			: "building on disputed ground — fixing it later also means fixing what you add now";
	return `[interlinked:disputed-ground] ${rel} carries ${open.length} open review finding(s): ${quoted}${open.length > MAX_QUOTED ? ` (+${open.length - MAX_QUOTED} more)` : ""}. You are ${verb}. Resolve the finding or ack it (\`interlinked findings ack <id> --reason\`) before continuing.`;
}

/** Write-side phase for runPerFileChecks: record touches for the edited
 *  file's open findings and surface the disputed-ground warning. Mutates
 *  decision.warnings in place (the phase-function contract). */
export function runReviewReconcilePhase(
	cwd: string,
	sessionId: string,
	editedFilePath: string,
	editedFileInRepo: boolean,
	decision: { warnings?: string[] | undefined },
	editedRanges?: LineRange[],
): void {
	if (!editedFilePath || !editedFileInRepo) return;
	const disputed = disputedGroundWarning(cwd, sessionId, editedFilePath, "write");
	recordReviewFindingTouches(cwd, sessionId, editedFilePath, editedRanges);
	if (disputed) {
		if (!decision.warnings) decision.warnings = [];
		decision.warnings.push(disputed);
	}
}

/** Read-event scanner for the PostToolUse evaluator (memo §6.3 channel 1:
 *  derivation travels read→write — the read is the earliest interception
 *  point). Lives here rather than post-tool.ts for the line-cap's sake and
 *  because all reconciliation state is module-local. */
export function scanDisputedGroundRead(event: HarnessEvent): string[] {
	if (event.tool_name !== "Read") return [];
	const filePath = event.tool_input?.file_path;
	if (typeof filePath !== "string" || filePath.length === 0) return [];
	// A ranged Read only disputes the range it saw (round-5 #6).
	const offset = event.tool_input?.offset;
	const limit = event.tool_input?.limit;
	const lineRange =
		typeof offset === "number" && typeof limit === "number"
			? { start: offset, end: offset + limit }
			: undefined;
	// Harness events carry their workspace root — use it, not the daemon's
	// process cwd, so findings resolve under the edited repo (round-2 #11).
	const cwd = typeof event.cwd === "string" && event.cwd ? event.cwd : process.cwd();
	// `HarnessEvent.session_id` is declared as a required `string`, but a
	// caller can hand this function an event object built from a partial /
	// untrusted payload (e.g. an external hook JSON that skipped the key
	// entirely) — the declared type is dishonest for that boundary, proven
	// by review-reconcile-phase.mutation-kill.test.ts's "missing session_id"
	// case. Read through a narrower, honest local type instead of trusting
	// `HarnessEvent` so a genuinely absent id still falls into the shared
	// "unknown" dedup channel rather than crashing or forking a bad key.
	const rawSessionId = (event as { session_id?: string }).session_id;
	const warning = disputedGroundWarning(
		cwd,
		rawSessionId ?? "unknown",
		filePath,
		"read",
		lineRange,
	);
	return warning ? [warning] : [];
}
