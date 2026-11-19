import type { HistoryKind, HistoryVerdict } from "../lib/metrics/history-noise.js";

/** Old-side changed lines of a set of files, and how many of them were rework. */
export interface LineCount { rework: number; total: number; }
export interface SetAsideRow extends LineCount { file: string; reason: string; }
export interface SetAsideReason extends LineCount { reason: string; files: number; }
export interface ReworkLedgerSummary {
	/** Code and data files together: everything that was not set aside. */
	kept: LineCount;
	byKind: Record<HistoryKind, LineCount>;
	setAside: LineCount & { files: number; byReason: SetAsideReason[]; top: SetAsideRow[] };
	/** The numbers as they were before set-aside: kept plus set-aside. */
	withSetAside: LineCount;
}

const SET_ASIDE_TOP = 5;
const empty = (): LineCount => ({ rework: 0, total: 0 });
function fold(into: LineCount, count: LineCount): void { into.rework += count.rework; into.total += count.total; }

/** Accumulates rework counts by file class so that the report can state what it set aside and how many lines that was. */
export function createReworkLedger() {
	const kept = empty(), byKind: Record<HistoryKind, LineCount> = { code: empty(), data: empty() };
	const aside = new Map<string, SetAsideRow>();
	return {
		add(file: string, verdict: HistoryVerdict, count: LineCount): void {
			if (verdict.kind === "set-aside") {
				const row = aside.get(file) ?? { file, reason: verdict.reason, ...empty() };
				fold(row, count);
				aside.set(file, row);
				return;
			}
			fold(kept, count);
			fold(byKind[verdict.kind], count);
		},
		summary(): ReworkLedgerSummary {
			const rows = [...aside.values()], total = empty(), reasons = new Map<string, SetAsideReason>();
			for (const row of rows) {
				fold(total, row);
				const reason = reasons.get(row.reason) ?? { reason: row.reason, files: 0, ...empty() };
				reason.files++;
				fold(reason, row);
				reasons.set(row.reason, reason);
			}
			const top = rows.sort((a, b) => b.rework - a.rework || b.total - a.total || a.file.localeCompare(b.file)).slice(0, SET_ASIDE_TOP);
			const withSetAside = { rework: kept.rework + total.rework, total: kept.total + total.total };
			return { kept: { ...kept }, byKind: { code: { ...byKind.code }, data: { ...byKind.data } },
				setAside: { files: rows.length, ...total, byReason: [...reasons.values()].sort((a, b) => a.reason.localeCompare(b.reason)), top }, withSetAside };
		},
	};
}
