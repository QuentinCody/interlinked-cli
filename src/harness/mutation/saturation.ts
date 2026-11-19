// ===========================================
// Saturation status per file
// ===========================================
// "Saturation testing": every expression is covered, and every mutant of it is
// killed, so ANY change to the file fails some test. That is what gives a
// change elsewhere its "semantic stability". This module reads the mutation
// manifest and says, per source file, whether the record shows that state for
// the CURRENT bytes:
//
//   saturated  — at least one mutant; every one killed, timed out (the suite
//                noticed) or proved equivalent; every current symbol measured
//                with an unchanged hash.
//   open       — a survived or uncovered mutant on a current symbol. An
//                accepted disposition (dead code, accepted risk, …) is counted
//                as `accepted` but stays open: a change there fails no test.
//   unknown    — no open mutant, but the record cannot vouch for the bytes: a
//                stale symbol hash, a symbol with no measured mutant, or an
//                indeterminate run.
//   unmeasured — the manifest holds no mutant for the file.
//   gone       — the file is not on disk.
//
// The baseline `.interlinked/saturation-baseline.json` lists files once seen
// saturated. `interlinked mutation saturation --ratchet` only ADDS to it, and
// the baseline-integrity gate refuses an edit that removes a file. A listed
// file that is no longer saturated is a regression. Facts and scores only: no
// model, and nothing here blocks an edit.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSymbolHashes } from "./identity.js";
import type { MutantRecord, MutationManifest, SymbolRecord } from "./types.js";

export type SaturationStatus = "saturated" | "open" | "unknown" | "unmeasured" | "gone";

export interface SaturationCounts {
	killed: number;
	equivalent: number;
	survived: number;
	uncovered: number;
	/** Survived or uncovered mutants that carry a disposition: counted, never closed. */
	accepted: number;
	indeterminate: number;
}

export interface FileSaturation {
	file: string;
	status: SaturationStatus;
	counts: SaturationCounts;
	/** Manifest symbols whose hash no longer matches the current source (or that are gone from it). */
	staleSymbols: number;
	/** Current symbols the manifest holds no mutant for. */
	unmeasuredSymbols: number;
}

export interface SaturationCensus {
	rows: FileSaturation[];
	totals: Record<SaturationStatus, number> & { files: number };
}

export interface SaturationBaseline {
	version: 1;
	saturated: string[];
}

const SATURATION_BASELINE_BASENAME = "saturation-baseline.json";

function emptyCounts(): SaturationCounts {
	return { killed: 0, equivalent: 0, survived: 0, uncovered: 0, accepted: 0, indeterminate: 0 };
}

function hasDisposition(record: MutantRecord): boolean {
	return record.disposition !== undefined || record.accepted_reason !== undefined;
}

function tally(counts: SaturationCounts, record: MutantRecord): void {
	switch (record.status) {
		case "killed":
		case "timeout":
			counts.killed++;
			return;
		case "equivalent":
			counts.equivalent++;
			return;
		case "indeterminate":
			counts.indeterminate++;
			return;
		case "survived":
		case "uncovered":
			// A proved equivalence (the ledger's only level-2 kind) closes the mutant like `equivalent`.
			if ((record.disposition as { kind?: unknown } | undefined)?.kind === "proved_equivalent") {
				counts.equivalent++;
				return;
			}
			counts[record.status]++;
			if (hasDisposition(record)) counts.accepted++;
	}
}

/** Manifest symbols whose recorded hash matches the current source, plus the stale and unmeasured counts. */
function symbolDrift(file: string, symbols: Record<string, SymbolRecord>, content: string): { fresh: Set<string>; stale: number; unmeasured: number } {
	const current = computeSymbolHashes(file, content);
	// No typescript: the record cannot be compared with the bytes, so every symbol is unvouched.
	if (current === null) return { fresh: new Set(), stale: Object.keys(symbols).length, unmeasured: 0 };
	const fresh = new Set<string>();
	let stale = 0, unmeasured = 0;
	for (const [id, symbol] of Object.entries(symbols)) {
		if (current.get(id)?.symbolHash === symbol.symbolHash) fresh.add(id);
		else stale++;
	}
	for (const id of current.keys()) {
		const known = symbols[id];
		if (known === undefined || Object.keys(known.mutants).length === 0) unmeasured++;
	}
	return { fresh, stale, unmeasured };
}

function countMutants(symbols: Record<string, SymbolRecord>, include: (id: string) => boolean): { counts: SaturationCounts; mutants: number } {
	const counts = emptyCounts();
	let mutants = 0;
	for (const [id, symbol] of Object.entries(symbols)) {
		if (!include(id)) continue;
		for (const record of Object.values(symbol.mutants)) {
			mutants++;
			tally(counts, record);
		}
	}
	return { counts, mutants };
}

/** One file's status. `content` is the current source, or null when the file is not on disk.
 *  Counts cover only symbols whose hash still matches: a stale symbol's record says nothing about today's bytes. */
export function fileSaturation(file: string, symbols: Record<string, SymbolRecord>, content: string | null): FileSaturation {
	if (content === null) return { file, status: "gone", counts: countMutants(symbols, () => true).counts, staleSymbols: 0, unmeasuredSymbols: 0 };
	if (countMutants(symbols, () => true).mutants === 0) return { file, status: "unmeasured", counts: emptyCounts(), staleSymbols: 0, unmeasuredSymbols: 0 };
	const drift = symbolDrift(file, symbols, content);
	const { counts } = countMutants(symbols, id => drift.fresh.has(id));
	const row = { file, counts, staleSymbols: drift.stale, unmeasuredSymbols: drift.unmeasured };
	if (counts.survived + counts.uncovered > 0) return { ...row, status: "open" };
	if (drift.stale + drift.unmeasured + counts.indeterminate > 0) return { ...row, status: "unknown" };
	return { ...row, status: "saturated" };
}

function readOrNull(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Every manifest file, read from `root`, sorted by path. */
export function saturationCensus(root: string, manifest: MutationManifest, only?: ReadonlySet<string>): SaturationCensus {
	const rows = Object.keys(manifest.files)
		.filter(file => only === undefined || only.has(file))
		.sort()
		.map(file => fileSaturation(file, manifest.files[file] ?? {}, readOrNull(join(root, file))));
	const totals = { saturated: 0, open: 0, unknown: 0, unmeasured: 0, gone: 0, files: rows.length };
	for (const row of rows) totals[row.status]++;
	return { rows, totals };
}

export function loadSaturationBaseline(configDir: string): SaturationBaseline {
	const text = readOrNull(join(configDir, SATURATION_BASELINE_BASENAME));
	if (text === null) return { version: 1, saturated: [] };
	try {
		const parsed: unknown = JSON.parse(text);
		const list = (parsed as { saturated?: unknown } | null)?.saturated;
		return { version: 1, saturated: Array.isArray(list) ? list.filter((f): f is string => typeof f === "string").sort() : [] };
	} catch {
		return { version: 1, saturated: [] };
	}
}

export function saveSaturationBaseline(configDir: string, baseline: SaturationBaseline): void {
	const body = { version: 1, note: "Files once seen saturated (interlinked mutation saturation --ratchet). Only grows; the baseline-integrity gate refuses a removal.", saturated: [...new Set(baseline.saturated)].sort() };
	writeFileSync(join(configDir, SATURATION_BASELINE_BASENAME), `${JSON.stringify(body, null, "\t")}\n`);
}

/** The union of the old list and every currently saturated file. Never removes a file. */
export function ratchetSaturationBaseline(previous: SaturationBaseline, rows: readonly FileSaturation[]): SaturationBaseline {
	const saturated = new Set(previous.saturated);
	for (const row of rows) if (row.status === "saturated") saturated.add(row.file);
	return { version: 1, saturated: [...saturated].sort() };
}

/** Listed files whose current status is not saturated. A gone file cannot regress. */
export function saturationRegressions(baseline: SaturationBaseline, rows: readonly FileSaturation[]): FileSaturation[] {
	const listed = new Set(baseline.saturated);
	return rows.filter(row => listed.has(row.file) && row.status !== "saturated" && row.status !== "gone");
}

/** Baseline-integrity detector: a file removed from the `saturated` list loosens the water-line. */
export function detectSaturationBaselineLoosening(file: string, before: unknown, after: unknown): Array<{ file: string; rule: string; before: unknown; after: unknown; message: string }> {
	const list = (value: unknown): string[] => {
		const raw = (value as { saturated?: unknown } | null)?.saturated;
		return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
	};
	const kept = new Set(list(after));
	return list(before)
		.filter(path => !kept.has(path))
		.map(path => ({ file, rule: `saturated:${path}`, before: true, after: false, message: `saturation baseline drops ${path}. A file once saturated stays listed; restore its kills instead (interlinked mutation saturation).` }));
}
