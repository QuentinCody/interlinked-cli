// Semantic graph — human-readable output. Pure string builders; no color, no
// I/O. Every metric cell is `count/of (pct%)` so a number never travels
// without its denominator; a zero denominator is `—`, never `0%` or `NaN`.

import type { Edge, TypeMetrics } from "./types.js";

const EMPTY_CELL = "—";
const COLUMN_GAP = "  ";
const METRIC_COLUMNS = ["orphans", "mismatches", "hidden_coupling", "churn"] as const;

export function formatCell(cell: { count: number; of: number }): string {
	if (cell.of === 0) return EMPTY_CELL;
	const pct = Math.round((cell.count / cell.of) * 100);
	return `${cell.count}/${cell.of} (${pct}%)`;
}

function padRow(cells: string[], widths: number[]): string {
	return cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(COLUMN_GAP).trimEnd();
}

/** One header line plus one row per type; columns padded to align. */
export function formatMetricsTable(metrics: TypeMetrics[]): string {
	const header = ["type", ...METRIC_COLUMNS];
	const rows = metrics.map((row) => [row.type, ...METRIC_COLUMNS.map((column) => formatCell(row[column]))]);
	const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)));
	return [padRow(header, widths), ...rows.map((row) => padRow(row, widths))].join("\n");
}

/** `type  p  state  source → target`, at most `limit` lines in the given order. */
export function formatEdgeLines(edges: Edge[], limit: number): string[] {
	return edges
		.slice(0, Math.max(0, limit))
		.map((edge) => `${edge.type}${COLUMN_GAP}${edge.p.toFixed(2)}${COLUMN_GAP}${edge.state}${COLUMN_GAP}${edge.source} → ${edge.target ?? "none"}`);
}
