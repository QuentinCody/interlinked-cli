// ===========================================
// interlinked query — bounded queries over the .interlinked JSONL logs
// ===========================================
// The read verb for the append-only local logs: named sources (blocks /
// checks / recurrences / costs / events / thinking / …) resolve to a log file
// plus an identity filter, --where ANDs user clauses on top, --by/--sum
// aggregate, and every scan is bounded (newest-N records / max-MB tail) so
// the 400 MB logs stay safe to query interactively. Deterministic filtering
// and counting only — no LLM. Complements `interlinked logs` (curated recent
// activity) and `interlinked search` (trigram CODE search); the recipes at
// .interlinked/INDEX.md are the spec this command productizes. Run with no
// arguments for the source catalog.

import { existsSync } from "node:fs";
import { c } from "../lib/formatter.js";
import { getOutputMode, type OutputMode, output, outputError } from "../lib/output.js";
import {
	type AggregateRow,
	createAggregateState,
	finalizeAggregate,
	foldRecord,
} from "./query/aggregate.js";
import {
	matchesAll,
	parseWhereClause,
	recordTimestampMs,
	resolveTimeBound,
	type WhereClause,
} from "./query/filters.js";
import { renderAggregate, renderFooter, renderRows } from "./query/render.js";
import {
	scanJsonlTail,
	type TailScanBudget,
	type TailScanStats,
} from "./query/reverse-reader.js";
import { QUERY_SOURCES, type ResolvedTarget, resolveTarget } from "./query/sources.js";

const DEFAULT_LIMIT = 20;
const DEFAULT_LAST_RECORDS = 20_000;
const DEFAULT_MAX_MB = 64;
const BYTES_PER_MB = 1024 * 1024;
const MAX_INFERRED_FIELDS = 4;
const INFERRED_FIELD_SKIP = new Set(["ts", "timestamp", "schema", "schema_version", "uuid", "seq"]);

export interface QueryCommandOptions {
	where?: string[];
	fields?: string;
	by?: string;
	sum?: string;
	since?: string;
	limit?: string;
	last?: string;
	maxMb?: string;
	file?: string;
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

export interface QueryParams {
	clauses: WhereClause[];
	budget: TailScanBudget;
	limit: number;
	sinceMs?: number;
	by?: string;
	sum?: string;
}

export interface QueryRunResult {
	rows: Record<string, unknown>[];
	aggregate?: AggregateRow[];
	stats: TailScanStats;
	sinceStopped: boolean;
	limitStopped: boolean;
}

/** Scan one log within budget, filtering and (optionally) aggregating. */
export function runQuery(file: string, params: QueryParams): QueryRunResult {
	const aggState = params.by === undefined ? undefined : createAggregateState();
	const byPath = params.by ?? "";
	const rows: Record<string, unknown>[] = [];
	// Boxed in an object so TS's control-flow narrowing doesn't collapse this
	// to a literal `false` at the read below — the scan callback mutates it
	// synchronously, but TS can't see across the `scanJsonlTail` call boundary.
	const scanState = { sinceStopped: false };
	const stats = scanJsonlTail(file, params.budget, (record) => {
		if (params.sinceMs !== undefined) {
			const tsMs = recordTimestampMs(record);
			if (tsMs !== undefined && tsMs < params.sinceMs) {
				scanState.sinceStopped = true;
				return false;
			}
		}
		if (!matchesAll(record, params.clauses)) return true;
		if (aggState !== undefined) {
			foldRecord(aggState, record, byPath, params.sum);
			return true;
		}
		rows.push(record);
		return rows.length < params.limit;
	});
	rows.reverse();
	const sinceStopped = scanState.sinceStopped;
	const limitStopped = aggState === undefined && !sinceStopped && stats.stopReason === "caller";
	return {
		rows,
		...(aggState !== undefined ? { aggregate: finalizeAggregate(aggState, params.limit) } : {}),
		stats,
		sinceStopped,
		limitStopped,
	};
}

function parsePositiveNumber(raw: string | undefined, fallback: number, flag: string): number {
	if (raw === undefined) return fallback;
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`Invalid ${flag}: "${raw}" — expected a positive number`);
	}
	return n;
}

function buildParams(resolved: ResolvedTarget, opts: QueryCommandOptions): QueryParams {
	if (opts.sum !== undefined && opts.by === undefined) {
		throw new Error("--sum requires --by (the sum is grouped by the --by key)");
	}
	const clauses = [...(resolved.source?.where ?? []), ...(opts.where ?? [])].map(parseWhereClause);
	const limit = Math.floor(parsePositiveNumber(opts.limit, DEFAULT_LIMIT, "--limit"));
	const last = Math.floor(parsePositiveNumber(opts.last, DEFAULT_LAST_RECORDS, "--last"));
	const maxMb = parsePositiveNumber(opts.maxMb, DEFAULT_MAX_MB, "--max-mb");
	return {
		clauses,
		budget: { maxRecords: last, maxBytes: Math.round(maxMb * BYTES_PER_MB) },
		limit,
		...(opts.since !== undefined ? { sinceMs: resolveTimeBound(opts.since) } : {}),
		...(opts.by !== undefined ? { by: opts.by } : {}),
		...(opts.sum !== undefined ? { sum: opts.sum } : {}),
	};
}

function resolveFields(
	opts: QueryCommandOptions,
	resolved: ResolvedTarget,
	rows: Record<string, unknown>[],
): string[] {
	if (opts.fields !== undefined) {
		return opts.fields
			.split(",")
			.map((field) => field.trim())
			.filter((field) => field.length > 0);
	}
	if (resolved.source !== undefined) return resolved.source.fields;
	const first = rows[0];
	if (first === undefined) return [];
	return Object.keys(first)
		.filter((key) => !INFERRED_FIELD_SKIP.has(key))
		.slice(0, MAX_INFERRED_FIELDS);
}

function renderCatalog(): string {
	const nameWidth = Math.max(...QUERY_SOURCES.map((s) => s.name.length));
	const fileWidth = Math.max(...QUERY_SOURCES.map((s) => s.file.length));
	const lines = [
		c.bold("interlinked query <source> [--where k=v] [--by path [--sum path]] [--since 7d]"),
		"",
	];
	for (const source of QUERY_SOURCES) {
		lines.push(
			`  ${source.name.padEnd(nameWidth)}  ${c.dim(source.file.padEnd(fileWidth))}  ${source.hint}`,
		);
	}
	lines.push(
		"",
		c.bold("Examples:"),
		"  interlinked query blocks --limit 10",
		"  interlinked query checks --by checks.id --since 7d",
		"  interlinked query costs --by session_id --sum output_tokens",
		"  interlinked query recurrences --by check_id --last 50000",
		"  interlinked query .interlinked/tests.jsonl --where kind=vitest",
		"",
		c.dim(
			"Scans are bounded (default: newest 20k records / 64 MB tail); the footer always says how much was scanned.",
		),
	);
	return lines.join("\n");
}

interface QueryView {
	resolved: ResolvedTarget;
	params: QueryParams;
	result: QueryRunResult;
	opts: QueryCommandOptions;
}

function emitResult(mode: OutputMode, view: QueryView): void {
	const { resolved, params, result, opts } = view;
	const jsonPayload = () => ({
		source: resolved.label,
		file: resolved.file,
		stats: {
			...result.stats,
			since_stopped: result.sinceStopped,
			limit_stopped: result.limitStopped,
		},
		...(result.aggregate !== undefined
			? {
					by: params.by,
					...(params.sum !== undefined ? { sum: params.sum } : {}),
					aggregate: result.aggregate,
				}
			: { rows: result.rows }),
	});
	const footer = () =>
		renderFooter(result.stats, resolved.label, {
			sinceStopped: result.sinceStopped,
			limitStopped: result.limitStopped,
		});
	const renderBody = (full: boolean): string => {
		const lines =
			result.aggregate !== undefined
				? renderAggregate(result.aggregate)
				: renderRows(result.rows, resolveFields(opts, resolved, result.rows), full);
		return lines.length > 0 ? lines.join("\n") : c.dim("no matching records");
	};
	output(mode, jsonPayload(), {
		json: jsonPayload,
		short: () => renderBody(false),
		normal: () => `${renderBody(false)}\n\n${footer()}`,
		full: () => `${renderBody(true)}\n\n${footer()}`,
	});
}

export async function queryCommand(
	target: string | undefined,
	opts: QueryCommandOptions,
): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = opts.cwd ?? process.cwd();

	let resolved: ResolvedTarget | undefined;
	let params: QueryParams | undefined;
	try {
		resolved = resolveTarget(target, opts.file, cwd);
		if (resolved !== undefined) params = buildParams(resolved, opts);
	} catch (error) {
		outputError(mode, error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	if (resolved === undefined || params === undefined) {
		const catalog = { sources: QUERY_SOURCES };
		output(mode, catalog, {
			json: () => catalog,
			short: renderCatalog,
			normal: renderCatalog,
		});
		return;
	}

	if (!existsSync(resolved.file)) {
		outputError(
			mode,
			`No ${resolved.label} log at ${resolved.file} — is the harness enabled in this repo?`,
		);
		process.exitCode = 1;
		return;
	}

	emitResult(mode, { resolved, params, result: runQuery(resolved.file, params), opts });
}
