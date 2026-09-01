// ===========================================
// Per-edit coverage — runtime estimate + baseline + obligation ledger (I/O)
// ===========================================
// The small persistence surface for the per-edit coverage block
// (docs/design/per-edit-coverage-enforcement.md, component 2). Kept OUT of
// `evaluator/coverage-write-guard.ts` so the guard reads as pure decision logic
// and this file owns every `.interlinked/` read/write. Three concerns:
//
//   1. Rolling suite-runtime estimate (`coverage-runtime-estimate.json`) — the
//      budget-gate input. Updated from each measured `suiteMs` (EWMA so one slow
//      run doesn't latch the gate open forever). When the estimate >= budget the
//      guard defers instead of running the suite per-edit.
//   2. Per-file coverage baseline (`coverage-edit-baseline.json`) — the prior
//      allowed-state coverage fraction per repo-relative file. The drop check
//      compares the overlay's coverage against this; an allowed edit refreshes
//      it. A rolling baseline (vs a committed report) keeps the module
//      self-contained and is honest: it is the last state the gate let through.
//      NOT `coverage-baseline.json` — that path belongs to the verify-time
//      ratchet (coverage-ratchet.ts, `interlinked coverage --update-baseline`),
//      whose `{version, files}` schema this module's flat path→fraction map
//      silently clobbered when both shared one file (design doc
//      incremental-per-edit-coverage-crap-ratchet.md section 8.6). No migration
//      from the shared file: its ledger entries may already be ratchet-wiped,
//      and a missing baseline is benign (first-seen ⇒ no drop comparison until
//      the next allowed edit reseeds it).
//   3. Deferred obligation log (`coverage-obligations.jsonl`) — append-only.
//      When the budget is exceeded the guard records one row here (commit-time
//      enforcement consumes it in a later step) and allows.
//
// Every function is total / never throws: a missing or malformed file reads as
// "no data" and a failed write is swallowed (the guard fails open — coverage
// bookkeeping must never crash the harness).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { interlinkedPath } from "../lib/interlinked-path.js";
import { readJsonFile } from "../lib/json-file.js";
import { isJsonObject } from "../lib/json-types.js";
import { harnessNow } from "./replay/harness-clock.js";

const ESTIMATE_FILE = "coverage-runtime-estimate.json";
const BASELINE_FILE = "coverage-edit-baseline.json";
const OBLIGATIONS_FILE = "coverage-obligations.jsonl";

/**
 * EWMA weight for a freshly-measured `suiteMs` against the stored estimate.
 * 0.5 = equal weight; recent enough to track a suite that grows past the budget,
 * smooth enough that a single GC-stalled run doesn't flip the gate.
 */
const ESTIMATE_ALPHA = 0.5;

/** Persisted rolling-estimate shape. */
interface RuntimeEstimate {
	/** Exponentially-weighted moving average of measured suite durations (ms). */
	suite_ms: number;
	/** ISO timestamp of the last update — diagnostic only. */
	updated_at: string;
}

/** One recorded deferred-coverage obligation (append-only JSONL row). */
export interface CoverageObligation {
	kind: "coverage";
	/** Repo-relative POSIX path of the edited file the obligation covers. */
	file: string;
	/** Why the per-edit run was skipped (always budget today). */
	reason: "budget_exceeded";
	/** The rolling estimate (ms) that tripped the budget. */
	estimated_suite_ms: number;
	/** The configured budget (ms) the estimate exceeded. */
	budget_ms: number;
	session_id: string;
	timestamp: string;
}

function writeJsonFile(path: string, value: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	} catch {
		// intentional: a failed bookkeeping write must not crash the harness.
	}
}

// ===========================================
// Rolling suite-runtime estimate
// ===========================================

/**
 * The current rolling suite-runtime estimate in ms, or `null` when none has
 * been recorded yet. `null` means "run the suite to learn the cost" — a
 * never-measured suite is assumed to fit the budget for its first run.
 */
export function readRuntimeEstimateMs(projectRoot: string): number | null {
	const data = readJsonFile<RuntimeEstimate>(interlinkedPath(projectRoot, ESTIMATE_FILE));
	if (!data || typeof data.suite_ms !== "number" || !Number.isFinite(data.suite_ms)) {
		return null;
	}
	return data.suite_ms;
}

/**
 * Fold a freshly-measured `suiteMs` into the rolling estimate (EWMA) and
 * persist it. The first measurement seeds the estimate directly; later ones
 * blend with {@link ESTIMATE_ALPHA}. `clock` is injected so tests get a
 * deterministic `updated_at`.
 */
export function updateRuntimeEstimateMs(
	projectRoot: string,
	measuredMs: number,
	clock: () => number = harnessNow,
): void {
	if (!Number.isFinite(measuredMs) || measuredMs < 0) return;
	const prev = readRuntimeEstimateMs(projectRoot);
	const next =
		prev === null ? measuredMs : prev * (1 - ESTIMATE_ALPHA) + measuredMs * ESTIMATE_ALPHA;
	writeJsonFile(interlinkedPath(projectRoot, ESTIMATE_FILE), {
		suite_ms: Math.round(next),
		updated_at: new Date(clock()).toISOString(),
	} satisfies RuntimeEstimate);
}

// ===========================================
// Per-file coverage baseline
// ===========================================

/** One stored baseline value: a legacy bare fraction, or fraction + the
 *  test-scope id that measured it (see evaluator/coverage-scope.ts — a drop
 *  comparison across DIFFERENT scopes is meaningless and used to false-block). */
type StoredBaselineValue = number | { f: number; scope?: string };

/** Map of repo-relative POSIX path → stored baseline value at last allow. */
type CoverageBaseline = Record<string, StoredBaselineValue>;

/** A decoded baseline entry: the fraction plus the scope that earned it
 *  (`null` for legacy bare-number entries written before scopes existed). */
export interface CoverageBaselineEntry {
	fraction: number;
	scope: string | null;
}

// `value` is typed via `StoredBaselineValue`, but it is decoded from an
// on-disk JSON file read through `readJsonFile`'s cast-based (unvalidated)
// contract — a hand-edited or corrupted baseline can genuinely put a literal
// `null` where the type says "object", so this stays `| null` rather than
// trusting the declared shape.
function decodeBaselineValue(
	value: StoredBaselineValue | null | undefined,
): CoverageBaselineEntry | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { fraction: value, scope: null };
	}
	if (typeof value === "object" && value !== null) {
		const fraction = (value as { f?: unknown }).f;
		if (typeof fraction === "number" && Number.isFinite(fraction)) {
			const scope = (value as { scope?: unknown }).scope;
			return { fraction, scope: typeof scope === "string" ? scope : null };
		}
	}
	return null;
}

/**
 * The recorded baseline covered-fraction (0..1) for one file, or `null` when no
 * baseline exists for it. `null` means "first time we've seen this file" — the
 * drop check treats that as "no regression to compare against". Reads both the
 * legacy bare-number shape and the scoped object shape.
 */
export function readFileCoverageBaseline(projectRoot: string, relPath: string): number | null {
	return readFileCoverageBaselineEntry(projectRoot, relPath)?.fraction ?? null;
}

/** The full baseline entry (fraction + measuring scope) for one file, or null. */
export function readFileCoverageBaselineEntry(
	projectRoot: string,
	relPath: string,
): CoverageBaselineEntry | null {
	const data = readJsonFile<CoverageBaseline>(interlinkedPath(projectRoot, BASELINE_FILE));
	if (!data) return null;
	return decodeBaselineValue(data[relPath]);
}

/**
 * Persist `fraction` (0..1) as the new baseline covered-fraction for `relPath`,
 * merging into any existing baseline map. Called only after an edit is ALLOWED,
 * so the baseline always reflects the last state the gate let through. When
 * `scope` is given, the entry records which test scope measured the fraction —
 * the drop ratchet only compares within one scope and re-anchors across scopes.
 */
export function writeFileCoverageBaseline(
	projectRoot: string,
	relPath: string,
	fraction: number,
	scope?: string,
): void {
	if (!Number.isFinite(fraction)) return;
	const path = interlinkedPath(projectRoot, BASELINE_FILE);
	const data = readJsonFile<CoverageBaseline>(path) ?? {};
	data[relPath] = scope === undefined ? fraction : { f: fraction, scope };
	writeJsonFile(path, data);
}

// ===========================================
// Deferred-obligation log
// ===========================================

/**
 * Append one deferred-coverage obligation row to
 * `.interlinked/coverage-obligations.jsonl`. Total / swallows write errors —
 * the guard records-and-allows, so a failed append must not turn into a block
 * or a crash.
 */
export function recordCoverageObligation(
	projectRoot: string,
	obligation: CoverageObligation,
): void {
	const path = interlinkedPath(projectRoot, OBLIGATIONS_FILE);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(obligation)}\n`, "utf-8");
	} catch {
		// intentional: best-effort obligation log; never crash the harness.
	}
}

/** A DISCHARGE marker: a later run (the commit gate, or an explicit coverage run)
 *  measured the file's coverage and it PASSED, so its earlier obligation is no longer
 *  unmet. Appended to the SAME ledger; the reader nets obligations against discharges
 *  chronologically so a re-edit after a discharge re-opens the obligation (finding 12). */
export interface CoverageDischarge {
	kind: "coverage_discharge";
	file: string;
	session_id: string;
	timestamp: string;
}

/** Append a coverage-obligation discharge for `file` in `sessionId`. Best-effort. */
export function recordCoverageDischarge(
	projectRoot: string,
	file: string,
	sessionId: string,
	timestamp: string,
): void {
	const path = interlinkedPath(projectRoot, OBLIGATIONS_FILE);
	const record: CoverageDischarge = { kind: "coverage_discharge", file, session_id: sessionId, timestamp };
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
	} catch {
		// intentional: best-effort discharge log; never crash the harness.
	}
}

/** Narrow an unknown parsed JSONL row to a deferred CoverageObligation for one
 *  session. Obligations stay SESSION-scoped: "who deferred" is a per-session
 *  fact the Stop nudge reports per session. */
function parseCoverageObligationFor(value: unknown, sessionId: string): CoverageObligation | null {
	if (!isJsonObject(value)) return null;
	const { kind, file, reason, estimated_suite_ms, budget_ms, session_id, timestamp } = value;
	if (kind !== "coverage" || session_id !== sessionId) return null;
	if (typeof file !== "string") return null;
	if (reason !== "budget_exceeded") return null;
	if (typeof estimated_suite_ms !== "number" || typeof budget_ms !== "number") return null;
	if (typeof timestamp !== "string") return null;
	return {
		kind: "coverage",
		file,
		reason,
		estimated_suite_ms,
		budget_ms,
		session_id: sessionId,
		timestamp,
	};
}

/** Narrow a parsed row to a coverage DISCHARGE — deliberately NOT
 *  session-filtered: a discharge records that the FILE's coverage was measured
 *  clean, which is true regardless of which session/process (the commit gate,
 *  an observed coverage run, a different agent) did the measuring. Filtering by
 *  session kept the Stop warning alive after the promised relief actually
 *  happened (finding 2026-06). */
function parseCoverageDischarge(value: unknown): CoverageDischarge | null {
	if (!isJsonObject(value)) return null;
	const { kind, file, session_id, timestamp } = value;
	if (kind !== "coverage_discharge") return null;
	if (typeof file !== "string") return null;
	if (typeof session_id !== "string" || typeof timestamp !== "string") return null;
	return { kind: "coverage_discharge", file, session_id, timestamp };
}

/**
 * The OPEN deferred coverage obligations for `sessionId`: the chronological net
 * over the append-only ledger (oldest→newest) — an obligation OPENS its file, a
 * later discharge (from ANY session) CLOSES it, and a re-edit after a discharge
 * re-opens it. Deduped by file. Total / never throws: a missing or malformed
 * ledger (or a torn line from a mid-write crash) reads as "no obligations" —
 * the gate fails open.
 */
export function readOpenCoverageObligations(
	projectRoot: string,
	sessionId: string,
): CoverageObligation[] {
	const path = interlinkedPath(projectRoot, OBLIGATIONS_FILE);
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const byFile = new Map<string, CoverageObligation>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			const obligation = parseCoverageObligationFor(parsed, sessionId);
			if (obligation) {
				byFile.set(obligation.file, obligation);
				continue;
			}
			const discharge = parseCoverageDischarge(parsed);
			if (discharge) byFile.delete(discharge.file);
		} catch {
			// intentional: skip torn JSONL lines (a process died mid-write).
		}
	}
	return [...byFile.values()];
}
