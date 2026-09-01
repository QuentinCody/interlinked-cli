// ===========================================
// Terminal rendering for `interlinked query`
// ===========================================
// Row mode: one line per record — dim short timestamp, then the requested
// field values (dot paths; absent → "·"; control bytes flattened so log text
// can never corrupt the terminal). Aggregate mode: right-aligned count / sum
// columns. The footer always states how much of the log was scanned and how
// to widen a bounded scan — a bounded result must never silently pose as a
// complete one.

import { c, shortTimestamp } from "../../lib/formatter.js";
import type { AggregateRow } from "./aggregate.js";
import { getPath, stringifyValue } from "./filters.js";
import type { TailScanStats } from "./reverse-reader.js";

const CELL_MAX_CHARS = 120;
const CONTROL_MAX = 0x20;
const DELETE_CODEPOINT = 0x7f;

export function renderRows(
	records: Record<string, unknown>[],
	fields: string[],
	full: boolean,
): string[] {
	return records.map((record) => {
		const ts = typeof record.ts === "string" ? shortTimestamp(record.ts) : "--";
		const cells = fields.map((field) => renderCell(record, field, full));
		return `${c.dim(ts)}  ${cells.join("  ")}`;
	});
}

function renderCell(record: Record<string, unknown>, field: string, full: boolean): string {
	const values = getPath(record, field);
	if (values.length === 0) return c.dim("·");
	const joined = sanitizeCell(values.map(stringifyValue).join(","));
	if (!full && joined.length > CELL_MAX_CHARS) return `${joined.slice(0, CELL_MAX_CHARS - 1)}…`;
	return joined;
}

/** Flatten newlines/control bytes so multi-line log text stays one row. */
function sanitizeCell(value: string): string {
	let out = "";
	let lastWasSpace = false;
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		const isControl = code < CONTROL_MAX || code === DELETE_CODEPOINT;
		const next = isControl ? " " : ch;
		if (next === " " && lastWasSpace) continue;
		lastWasSpace = next === " ";
		out += next;
	}
	return out;
}

export function renderAggregate(rows: AggregateRow[]): string[] {
	const hasSum = rows.some((row) => row.sum !== undefined);
	return rows.map((row) => {
		const count = String(row.count).padStart(7);
		const sum = hasSum ? String(row.sum ?? 0).padStart(14) : "";
		return `${count}${sum}  ${row.key}`;
	});
}

interface FooterContext {
	sinceStopped?: boolean;
	limitStopped?: boolean;
}

export function renderFooter(stats: TailScanStats, label: string, context: FooterContext): string {
	const mb = (stats.bytesScanned / (1024 * 1024)).toFixed(1);
	const base = `${stats.recordsParsed} records (${mb} MB) of ${label}`;
	const malformed =
		stats.malformedLines > 0 ? ` · ${stats.malformedLines} malformed lines skipped` : "";
	if (context.sinceStopped) {
		return c.dim(`scanned back to the --since bound: ${base}${malformed}`);
	}
	if (context.limitStopped) {
		return c.dim(`scanned ${base} — more may match (raise --limit)${malformed}`);
	}
	if (stats.truncated) {
		return c.dim(`bounded scan: newest ${base} — widen with --last / --max-mb${malformed}`);
	}
	return c.dim(`scanned all ${base}${malformed}`);
}
