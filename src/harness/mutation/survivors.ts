// ===========================================
// Per-edit mutation — survivor work-list aggregation
// ===========================================
// The manifest is the only record of which mutants a repo's tests fail to kill,
// and until this module there was no way to read it: the per-edit gate reports
// the survivors of ONE edit, `mutation measure` re-runs ONE file against the
// runner (seconds to minutes), and every survivor already measured and recorded
// was addressable only by a hand-written JSON script.
//
// Pure folds over an already-loaded `MutationManifest` — no fs, no runner, no
// clock. That is what makes it portable: any repo with a manifest gets the same
// work-list, and the CLI, the daemon, and a future cloud fan-out planner all
// read the SAME ranking rather than each inventing one.

import { dispositionOf, type SurvivorDispositionKind } from "./disposition.js";
import type {
	SurvivorFileRow,
	SurvivorFilter,
	SurvivorMutantRow,
	SurvivorMutatorRow,
	SurvivorRemedy,
	SurvivorSummary,
	SurvivorSymbolRow,
	SurvivorTotals,
} from "./survivors-types.js";
export type {
	SurvivorFileRow,
	SurvivorFilter,
	SurvivorMutantRow,
	SurvivorMutatorRow,
	SurvivorRemedy,
	SurvivorSummary,
	SurvivorSymbolRow,
} from "./survivors-types.js";
import type { MeasurementProvenance, MutantRecord, MutationManifest, StableId, SymbolRecord } from "./types.js";

/**
 * Which job this file needs.
 *
 * A file with no test in scope cannot have its assertions strengthened; there
 * are none. A file whose tests run and still let mutants live has the opposite
 * problem. Measured here: one file kept all 64 survivors under a scope of a
 * single test, while two others fell from 186 to 18 and from 106 to 0 once a
 * wider scope ran. The same raw count meant two different jobs.
 */
export function remedyFor(provenance: MeasurementProvenance | null): SurvivorRemedy {
	if (provenance === null) return "unknown";
	return provenance.testCount === 0 ? "write_test" : "strengthen_tests";
}

function emptyRemedyCounts(): Record<SurvivorRemedy, number> {
	return { write_test: 0, strengthen_tests: 0, unknown: 0 };
}

interface Counts {
	open: number;
	dispositioned: number;
	uncovered: number;
	timeout: number;
	killed: number;
	total: number;
}

function emptyCounts(): Counts {
	return { open: 0, dispositioned: 0, uncovered: 0, timeout: 0, killed: 0, total: 0 };
}

/**
 * Detected fraction. `killed` and `timeout` are detections; everything else —
 * survived, uncovered, indeterminate — is not. Uncovered sits in the
 * denominator on purpose: a mutant no test reaches is undetected, and dropping
 * it would let a repo raise its score by deleting test coverage.
 */
function scoreOf(counts: Counts): number {
	if (counts.total === 0) return 1;
	return (counts.killed + counts.timeout) / counts.total;
}

/** Has anyone judged this survivor? Typed disposition or legacy prose both count. */
function dispositionKindOf(record: MutantRecord): SurvivorDispositionKind | null {
	const view = dispositionOf(record);
	if (view.source === "none") return null;
	return view.disposition.kind;
}

function matches(haystack: string, needle: string | undefined): boolean {
	if (needle === undefined || needle === "") return true;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Is this an OPEN survivor — surviving AND unjudged? */
function isOpenSurvivor(record: MutantRecord): boolean {
	return record.status === "survived" && dispositionKindOf(record) === null;
}

/** Fold one mutant into a counter bucket. */
function tally(counts: Counts, record: MutantRecord): void {
	counts.total += 1;
	if (record.status === "killed") counts.killed += 1;
	else if (record.status === "timeout") counts.timeout += 1;
	else if (record.status === "uncovered") counts.uncovered += 1;
	else if (record.status === "survived") {
		if (dispositionKindOf(record) === null) counts.open += 1;
		else counts.dispositioned += 1;
	}
}

function addCounts(into: Counts, from: Counts): void {
	into.open += from.open;
	into.dispositioned += from.dispositioned;
	into.uncovered += from.uncovered;
	into.timeout += from.timeout;
	into.killed += from.killed;
	into.total += from.total;
}

function mutantRow(file: string, symbol: SymbolRecord, record: MutantRecord): SurvivorMutantRow {
	return {
		file,
		symbolId: symbol.symbolId,
		qualifiedName: symbol.qualifiedName,
		mutantId: record.mutantId,
		mutator: record.mutator,
		originalLexeme: record.originalLexeme,
		replacement: record.replacement,
		firstSeen: record.firstSeen,
		disposition: dispositionKindOf(record),
	};
}

interface SymbolScan {
	counts: Counts;
	rows: SurvivorMutantRow[];
}

/** Fold one symbol's mutants, collecting the survivor rows the filter admits. */
function scanSymbol(file: string, symbol: SymbolRecord, filter: SurvivorFilter): SymbolScan {
	const counts = emptyCounts();
	const rows: SurvivorMutantRow[] = [];
	for (const record of Object.values(symbol.mutants)) {
		if (!matches(record.mutator, filter.mutator)) continue;
		tally(counts, record);
		if (record.status !== "survived") continue;
		if (!isOpenSurvivor(record) && filter.includeDispositioned !== true) continue;
		rows.push(mutantRow(file, symbol, record));
	}
	return { counts, rows };
}

function symbolRow(file: string, symbol: SymbolRecord, counts: Counts): SurvivorSymbolRow {
	return {
		file,
		symbolId: symbol.symbolId,
		qualifiedName: symbol.qualifiedName,
		open: counts.open,
		dispositioned: counts.dispositioned,
		uncovered: counts.uncovered,
		total: counts.total,
		// `instability` is declared non-optional on `SymbolRecord`, but a
		// manifest loaded from disk (fs boundary — see manifest.ts's JSON
		// reader) can genuinely predate the field (added after symbols were
		// first recorded). The declared type lies about that boundary; widen
		// locally so the `?.` reflects the true on-disk shape instead of
		// reading as an impossible branch. Load-bearing, not redundant — see
		// survivors.mutation-kill-w27.test.ts's "quarantined flag survives a
		// missing instability record".
		quarantined:
			(symbol as { instability?: SymbolRecord["instability"] }).instability?.quarantined ===
			true,
	};
}

/** Rank: most open survivors first, then worst score, then path — a total order,
 *  so two runs over the same manifest always produce the same work-list. */
function byWorkThenScore(a: SurvivorFileRow, b: SurvivorFileRow): number {
	if (b.open !== a.open) return b.open - a.open;
	if (a.score !== b.score) return a.score - b.score;
	return a.file.localeCompare(b.file);
}

function rankSymbols(rows: SurvivorSymbolRow[]): SurvivorSymbolRow[] {
	return rows.sort((a, b) => {
		if (b.open !== a.open) return b.open - a.open;
		if (b.uncovered !== a.uncovered) return b.uncovered - a.uncovered;
		return `${a.file}:${a.qualifiedName}`.localeCompare(`${b.file}:${b.qualifiedName}`);
	});
}

function bumpMutator(byMutator: Map<string, Counts>, record: MutantRecord): void {
	const bucket = byMutator.get(record.mutator) ?? emptyCounts();
	bucket.total += 1;
	if (isOpenSurvivor(record)) bucket.open += 1;
	byMutator.set(record.mutator, bucket);
}

function mutatorRows(byMutator: Map<string, Counts>): SurvivorMutatorRow[] {
	const rows: SurvivorMutatorRow[] = [];
	for (const [mutator, counts] of byMutator) {
		rows.push({
			mutator,
			open: counts.open,
			total: counts.total,
			escapeRate: counts.total === 0 ? 0 : counts.open / counts.total,
		});
	}
	return rows.sort((a, b) => b.open - a.open || a.mutator.localeCompare(b.mutator));
}

interface FileScan {
	counts: Counts;
	symbols: SurvivorSymbolRow[];
	mutants: SurvivorMutantRow[];
	symbolCount: number;
}

/** Fold every symbol of one file. */
function scanFile(file: string, symbolMap: Record<StableId, SymbolRecord>, filter: SurvivorFilter): FileScan {
	const counts = emptyCounts();
	const symbols: SurvivorSymbolRow[] = [];
	const mutants: SurvivorMutantRow[] = [];
	let symbolCount = 0;
	for (const symbol of Object.values(symbolMap)) {
		symbolCount += 1;
		const scan = scanSymbol(file, symbol, filter);
		addCounts(counts, scan.counts);
		mutants.push(...scan.rows);
		const undetected = scan.counts.open + scan.counts.dispositioned + scan.counts.uncovered;
		if (undetected > 0) symbols.push(symbolRow(file, symbol, scan.counts));
	}
	return { counts, symbols, mutants, symbolCount };
}

function fileRow(
	file: string,
	counts: Counts,
	stale: boolean,
	symbols: number,
	provenance: MeasurementProvenance | null,
): SurvivorFileRow {
	return {
		file,
		symbols,
		remedy: remedyFor(provenance),
		provenance,
		open: counts.open,
		dispositioned: counts.dispositioned,
		uncovered: counts.uncovered,
		timeout: counts.timeout,
		killed: counts.killed,
		total: counts.total,
		score: scoreOf(counts),
		stale,
	};
}

/** The shape of the walk itself — how many files and symbols the filter
 *  admitted, and how many of those files no longer exist. Grouped rather than
 *  passed as three bare numbers, whose order no call site can get right by
 *  reading the types. */
interface ScanShape {
	fileCount: number;
	symbolCount: number;
	staleFiles: number;
	unqualifiedFiles: number;
	openByRemedy: Record<SurvivorRemedy, number>;
}

function totalsOf(counts: Counts, shape: ScanShape): SurvivorTotals {
	return {
		files: shape.fileCount,
		symbols: shape.symbolCount,
		mutants: counts.total,
		killed: counts.killed,
		survived: counts.open + counts.dispositioned,
		open: counts.open,
		dispositioned: counts.dispositioned,
		uncovered: counts.uncovered,
		timeout: counts.timeout,
		staleFiles: shape.staleFiles,
		unqualifiedFiles: shape.unqualifiedFiles,
		openByRemedy: shape.openByRemedy,
		score: scoreOf(counts),
	};
}

/**
 * The whole work-list, ranked, from an already-loaded manifest.
 *
 * Every returned array is fully ranked and unbounded — truncation is the
 * caller's decision, because a human reading a terminal wants 20 rows while a
 * fan-out planner sharding work across machines wants all of them.
 */
export function summarizeSurvivors(manifest: MutationManifest, filter: SurvivorFilter = {}): SurvivorSummary {
	const totals = emptyCounts();
	const files: SurvivorFileRow[] = [];
	const symbols: SurvivorSymbolRow[] = [];
	const mutants: SurvivorMutantRow[] = [];
	const byMutator = new Map<string, Counts>();
	let symbolCount = 0;
	let staleFiles = 0;
	let unqualifiedFiles = 0;
	const openByRemedy = emptyRemedyCounts();

	for (const [file, symbolMap] of Object.entries(manifest.files)) {
		if (!matches(file, filter.file)) continue;
		const scan = scanFile(file, symbolMap, filter);
		collectMutators(byMutator, symbolMap, filter);
		symbolCount += scan.symbolCount;
		symbols.push(...scan.symbols);
		mutants.push(...scan.mutants);
		addCounts(totals, scan.counts);
		const stale = filter.exists ? !filter.exists(file) : false;
		if (stale) staleFiles += 1;
		const provenance = manifest.fileProvenance?.[file] ?? null;
		if (provenance === null) unqualifiedFiles += 1;
		openByRemedy[remedyFor(provenance)] += scan.counts.open;
		files.push(fileRow(file, scan.counts, stale, scan.symbolCount, provenance));
	}

	return {
		generation: manifest.generation,
		authoritativeAt: manifest.authoritativeAt,
		totals: totalsOf(totals, { fileCount: files.length, symbolCount, staleFiles, unqualifiedFiles, openByRemedy }),
		files: files.sort(byWorkThenScore),
		symbols: rankSymbols(symbols),
		mutators: mutatorRows(byMutator),
		mutants: mutants.sort(
			(a, b) => a.file.localeCompare(b.file) || a.qualifiedName.localeCompare(b.qualifiedName),
		),
	};
}

/**
 * Narrow a summary to a subset of its files, RECOMPUTING the totals.
 *
 * The totals are the part a reader trusts and the part a naive filter gets
 * wrong: dropping rows while leaving `totals.open` at its repo-wide value makes
 * a shard report the whole repo's debt as its own. Every caller that hides
 * files — a stale-file filter, a `--shard` slice — must come through here.
 */
export function restrictToFiles(summary: SurvivorSummary, keep: ReadonlySet<string>): SurvivorSummary {
	const files = summary.files.filter((f) => keep.has(f.file));
	const counts = emptyCounts();
	let symbolCount = 0;
	let staleFiles = 0;
	let unqualifiedFiles = 0;
	const openByRemedy = emptyRemedyCounts();
	for (const f of files) {
		counts.open += f.open;
		counts.dispositioned += f.dispositioned;
		counts.uncovered += f.uncovered;
		counts.timeout += f.timeout;
		counts.killed += f.killed;
		counts.total += f.total;
		symbolCount += f.symbols;
		if (f.stale) staleFiles += 1;
		if (f.provenance === null) unqualifiedFiles += 1;
		openByRemedy[f.remedy] += f.open;
	}
	return {
		...summary,
		totals: totalsOf(counts, { fileCount: files.length, symbolCount, staleFiles, unqualifiedFiles, openByRemedy }),
		files,
		symbols: summary.symbols.filter((r) => keep.has(r.file)),
		mutants: summary.mutants.filter((m) => keep.has(m.file)),
	};
}

/** Per-mutator counts, folded alongside the per-file scan (which collapses
 *  mutators away) so the manifest is still walked exactly once. */
function collectMutators(
	byMutator: Map<string, Counts>,
	symbolMap: Record<StableId, SymbolRecord>,
	filter: SurvivorFilter,
): void {
	for (const symbol of Object.values(symbolMap)) {
		for (const record of Object.values(symbol.mutants)) {
			if (!matches(record.mutator, filter.mutator)) continue;
			bumpMutator(byMutator, record);
		}
	}
}
