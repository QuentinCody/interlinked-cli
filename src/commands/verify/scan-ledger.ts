// ===========================================
// Scan ledger — what verify did not read, and what it could not finish
// ===========================================
// One ledger per verify run. It records three facts that a run must state instead of hiding:
//   set_aside     files that source roles classify as generated / vendor / asset; content checks never read them.
//   not_measured  (check, file) pairs that went over the per-pair budget, or whose file went over the per-file budget.
//   partial       the run stopped early (whole-command soft deadline) and printed what it had.

// Type aliases, not interfaces: these rows are written straight into the JSON report (`JsonObject`).
export type SetAsideRow = { file: string; role: string; evidence_kind: string; evidence_detail: string; bytes: number | null };
export type NotMeasuredRow = { check: string; file: string; reason: string; elapsed_ms: number };
export type PartialRun = { reason: string; phase: string; elapsed_ms: number };

/** One finding from a check that runs outside the per-file battery (registry sweep, project sweep). */
export type SweepRow = { check: string; file: string; line: number; message: string };

export interface ScanLedger {
	/** Findings of checks that the per-file battery does not run, keyed `<family>:<id>` (`inline:swift_empty_catch`). */
	sweep: Map<string, SweepRow[]>;
	setAside: SetAsideRow[];
	notMeasured: NotMeasuredRow[];
	fileElapsed: Map<string, number>;
	measuredFiles: number;
	partial: PartialRun | null;
}

export const DEFAULT_PAIR_BUDGET_MS = 15_000;
export const DEFAULT_FILE_BUDGET_MS = 60_000;
const SET_ASIDE_LISTED_CAP = 200;
const NOT_MEASURED_ROWS_CAP = 500;

export function createScanLedger(): ScanLedger {
	return { sweep: new Map(), setAside: [], notMeasured: [], fileElapsed: new Map(), measuredFiles: 0, partial: null };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Longest time one check may spend on one file before the pair is recorded as not measured. */
export function pairBudgetMs(env: Record<string, string | undefined> = process.env): number {
	return positiveInteger(env.INTERLINKED_VERIFY_PAIR_BUDGET_MS, DEFAULT_PAIR_BUDGET_MS);
}

/** Longest total time the per-file battery may spend on one file before its remaining checks are recorded as not measured. */
export function fileBudgetMs(env: Record<string, string | undefined> = process.env): number {
	return positiveInteger(env.INTERLINKED_VERIFY_FILE_BUDGET_MS, DEFAULT_FILE_BUDGET_MS);
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

export function summarizeSetAside(rows: readonly SetAsideRow[], cap: number = SET_ASIDE_LISTED_CAP) {
	const by_role: Record<string, number> = {};
	const by_evidence: Record<string, number> = {};
	for (const entry of rows) {
		bump(by_role, entry.role);
		bump(by_evidence, entry.evidence_kind);
	}
	const listed = [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.file.localeCompare(b.file)).slice(0, cap);
	return { files: rows.length, by_role, by_evidence, listed, omitted: rows.length - listed.length };
}

export function summarizeNotMeasured(rows: readonly NotMeasuredRow[], cap: number = NOT_MEASURED_ROWS_CAP) {
	const by_check: Record<string, number> = {};
	for (const entry of rows) bump(by_check, entry.check);
	const kept = [...rows].sort((a, b) => b.elapsed_ms - a.elapsed_ms || a.check.localeCompare(b.check) || a.file.localeCompare(b.file)).slice(0, cap);
	return { pairs: rows.length, by_check, rows: kept, omitted: rows.length - kept.length };
}
