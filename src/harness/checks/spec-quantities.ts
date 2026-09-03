// Spec quantity checks (docs/design/spec-audit-runtime-checks.md §7.1,
// spike 9): capacity arithmetic and table-sum recompute — the deterministic
// slice of the audit corpus's numeric findings. Markdown-only, evidence
// only.

import { isSpecEligibleFile, siteText } from "../spec/types.js";
import type { InlineMatch } from "./shared.js";

/** Max findings per file per check. */
const MAX_MATCHES = 10;

// "8-bit generation field" + reuse/wrap vocabulary on one line → the P0-5
// shape: a bounded field whose population/reuse story is unstated.
const BIT_FIELD_RE_G = /\b(\d{1,2})-bit\b/gi;
const REUSE_VOCAB_RE = /\b(?:reuse|reused|wrap|wraps|generation|monoton|counter|sequence|epoch|slot)/i;
const ADDRESSED_RE =
	/\bwraps? (?:at|after)\b|\bwiden\b|\bprohibit|\bnever reused\b|\bsaturat|\bexplicit(?:ly)? (?:bounded|capped)/i;

/**
 * One finding per bounded bit field named on a single reuse/counter line — ALL
 * of them, not just the first (round-2 #28): a line naming two bounded fields
 * must flag both.
 */
function bitFieldFindings(line: string, lineNumber: number): InlineMatch[] {
	const found: InlineMatch[] = [];
	for (const m of line.matchAll(BIT_FIELD_RE_G)) {
		const bits = Number(m[1]);
		if (!Number.isFinite(bits) || bits < 2 || bits > 64) continue;
		const capacity = bits >= 53 ? `2^${bits}` : `${2 ** bits}`;
		found.push({
			line: lineNumber,
			text: siteText(
				`${bits}-bit field with reuse/counter semantics wraps at ${capacity} — state where reuse is prohibited, the field is widened, or wraparound is handled`,
			),
		});
	}
	return found;
}

/**
 * Capacity-wrap obligation: an N-bit field discussed alongside reuse/counter
 * vocabulary, with no wrap/widen/prohibition statement on the same line.
 * Emits the wrap point (2^N) as a pointed question, never a verdict.
 */
export function checkSpecCapacityClaims(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const out: InlineMatch[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
		const line = lines[i] ?? "";
		if (!REUSE_VOCAB_RE.test(line) || ADDRESSED_RE.test(line)) continue;
		for (const finding of bitFieldFindings(line, i + 1)) {
			if (out.length >= MAX_MATCHES) break;
			out.push(finding);
		}
	}
	return out;
}

/** A markdown table row split into trimmed cells (empty edge cells dropped).
 *  Splits only on UNESCAPED pipes — a `\|` inside a cell is literal content,
 *  not a column boundary (round-2 #29). */
function tableCells(line: string): string[] | null {
	const t = line.trim();
	if (!t.startsWith("|") || !t.endsWith("|") || t.length < 3) return null;
	// Split on "|" not preceded by a backslash, then unescape.
	return t
		.slice(1, -1)
		.split(/(?<!\\)\|/)
		.map((c) => c.replace(/\\\|/g, "|").trim());
}

/** Parse a numeric cell: plain/comma-grouped number, else null. */
function numericCell(cell: string): number | null {
	const cleaned = cell.replace(/[,$%\s]/g, "");
	if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
	return Number(cleaned);
}

const TOTAL_LABEL_RE = /\b(?:total|sum)\b/i;
const SEPARATOR_ROW_RE = /^[\s|:-]+$/;
/** Float-tolerant equality for table sums. */
const SUM_EPSILON = 0.001;

interface TableBlock {
	startLine: number;
	rows: Array<{ line: number; cells: string[] }>;
}

/** Contiguous pipe-table blocks (separator rows excluded from data). */
function collectTables(lines: string[]): TableBlock[] {
	const tables: TableBlock[] = [];
	let current: TableBlock | null = null;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const cells = tableCells(raw);
		if (!cells) {
			current = null;
			continue;
		}
		if (SEPARATOR_ROW_RE.test(raw)) continue;
		if (!current) {
			current = { startLine: i + 1, rows: [] };
			tables.push(current);
		}
		current.rows.push({ line: i + 1, cells });
	}
	return tables;
}

/** Sum one column across data rows, plus how many of its cells were numeric. */
function columnSum(
	dataRows: TableBlock["rows"],
	col: number,
): { sum: number; numericCount: number } {
	let sum = 0;
	let numericCount = 0;
	for (const row of dataRows) {
		const v = numericCell(row.cells[col] ?? "");
		if (v === null) continue;
		numericCount++;
		sum += v;
	}
	return { sum, numericCount };
}

/** Check one table's Total/Sum rows against each numeric column. */
function checkTable(table: TableBlock, out: InlineMatch[]): void {
	const totalRow = table.rows.find((r) => TOTAL_LABEL_RE.test(r.cells[0] ?? ""));
	if (!totalRow || table.rows.length < 3) return;
	const dataRows = table.rows.filter((r) => r !== totalRow && r !== table.rows[0]);
	for (let col = 1; col < totalRow.cells.length; col++) {
		const stated = numericCell(totalRow.cells[col] ?? "");
		if (stated === null) continue;
		const { sum, numericCount } = columnSum(dataRows, col);
		if (numericCount < 2) continue;
		if (Math.abs(sum - stated) <= SUM_EPSILON) continue;
		out.push({
			line: totalRow.line,
			text: siteText(
				`table total in column ${col + 1} states ${stated} but the ${numericCount} rows above sum to ${sum} — recompute, or a row is missing/stale`,
			),
		});
		if (out.length >= MAX_MATCHES) return;
	}
}

/**
 * Table-sum recompute: a Total/Sum row whose numeric columns don't equal the
 * sum of the data rows — audit class A arithmetic, fully deterministic.
 */
export function checkSpecTableSums(content: string, filePath: string): InlineMatch[] {
	if (!isSpecEligibleFile(filePath)) return [];
	const out: InlineMatch[] = [];
	for (const table of collectTables(content.split("\n"))) {
		checkTable(table, out);
		if (out.length >= MAX_MATCHES) break;
	}
	return out;
}
