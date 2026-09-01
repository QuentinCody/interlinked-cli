// ===========================================
// LCOV → Canonical Coverage
// ===========================================
// Parses the LCOV `lcov.info` interchange format — the cross-language de-facto
// standard. istanbul (lcov reporter), coverage.py (`coverage lcov`),
// cargo-llvm-cov (`--lcov`), gcov/lcov, and gocover→lcov all emit it, so one
// parser here replaces N bespoke per-engine readers. Pure + dependency-free;
// LCOV is a simple line-oriented record format.
//
// Record grammar (one source file per `end_of_record`):
//   TN:<test name>
//   SF:<source file path>
//   FN:<line>,<function name>
//   FNDA:<hits>,<function name>
//   FNF:<found>   FNH:<hit>
//   BRDA:<line>,<block>,<branch>,<taken|->
//   BRF:<found>   BRH:<hit>
//   DA:<line>,<hits>[,<checksum>]
//   LF:<found>    LH:<hit>
//   end_of_record
//
// We derive every metric from the detailed records (DA / BRDA / FN+FNDA) rather
// than trusting the summary lines (LF/LH/BRF/BRH/FNF/FNH), so a malformed or
// inconsistent summary line can't skew the result. Duplicate file records
// (merged reports) accumulate — line/branch hit counts sum — matching LCOV
// merge semantics.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
	type CanonicalCoverage,
	type CanonicalFileCoverage,
	type CanonicalFunction,
	metric,
} from "./coverage-canonical.js";
import type { FunctionCoverage, PerFileCoverage } from "./coverage-final-reader.js";
import type { CoverageSummary } from "./coverage-ratchet.js";

interface ParseLcovOptions {
	/** Absolute repo root; absolute `SF` paths are normalized relative to it. */
	cwd?: string;
}

/** Per-file accumulator — merged across duplicate `SF` records before finalizing. */
interface FileAcc {
	/** 1-based line → summed hit count. */
	lineHits: Map<number, number>;
	/**
	 * function name → ORDERED start lines (from `FN`). A list, not a single line,
	 * because LCOV legitimately repeats a name within one file (constructors,
	 * same-named methods, overloads); keying by name alone collapsed them and
	 * corrupted coverage/CRAP/ratchet (finding 2026-06).
	 */
	fnStartLines: Map<string, number[]>;
	/**
	 * function name → ORDERED entry hits (from `FNDA`). FNDA carries no line, so it
	 * is paired POSITIONALLY with `fnStartLines` (the k-th FN:name ↔ the k-th
	 * FNDA:name), then merged by (name, line) at finalize so repeated names stay
	 * distinct while merged reports still sum.
	 */
	fnEntryHits: Map<string, number[]>;
	/** branch key `line:block:branch` → summed taken count (`-` ⇒ 0). */
	branchTaken: Map<string, number>;
}

function emptyAcc(): FileAcc {
	return {
		lineHits: new Map(),
		fnStartLines: new Map(),
		fnEntryHits: new Map(),
		branchTaken: new Map(),
	};
}

/** Append `value` to the per-name ordered list in `map`. */
function pushNamed(map: Map<string, number[]>, name: string, value: number): void {
	const list = map.get(name);
	if (list) list.push(value);
	else map.set(name, [value]);
}

/** Normalize an `SF` path to a repo-relative, POSIX-separated string. */
function normalizeSourcePath(sf: string, cwd: string | undefined): string {
	const posix = sf.trim().replace(/\\/g, "/");
	if (cwd && isAbsolute(posix)) {
		return relative(cwd, posix).replace(/\\/g, "/");
	}
	return posix;
}

/** Split on the FIRST comma only — function names may contain commas. */
function splitFirstComma(s: string): [string, string] {
	const i = s.indexOf(",");
	if (i === -1) return [s, ""];
	return [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Resolve the accumulator for an `SF` record, get-or-creating it in `accs`.
 * Returns `null` for an empty path (caller leaves the current file unchanged),
 * mirroring the original `if (!path) break` behavior.
 */
function resolveSfAcc(
	accs: Map<string, FileAcc>,
	rest: string,
	cwd: string | undefined,
): FileAcc | null {
	const path = normalizeSourcePath(rest, cwd);
	if (!path) return null;
	let acc = accs.get(path);
	if (!acc) {
		acc = emptyAcc();
		accs.set(path, acc);
	}
	return acc;
}

/** Apply a `DA:<line>,<hits>[,<checksum>]` record to the current accumulator. */
function applyDaRecord(cur: FileAcc, rest: string): void {
	const parts = rest.split(",");
	const ln = Number.parseInt(parts[0] ?? "", 10);
	const hits = Number.parseInt(parts[1] ?? "", 10);
	if (!Number.isFinite(ln) || !Number.isFinite(hits)) return;
	cur.lineHits.set(ln, (cur.lineHits.get(ln) ?? 0) + hits);
}

/** Apply an `FN:<line>,<name>` record (function start line). */
function applyFnRecord(cur: FileAcc, rest: string): void {
	const [lnStr, name] = splitFirstComma(rest);
	const ln = Number.parseInt(lnStr, 10);
	if (!name || !Number.isFinite(ln)) return;
	pushNamed(cur.fnStartLines, name, ln);
}

/** Apply an `FNDA:<hits>,<name>` record (function entry hits). */
function applyFndaRecord(cur: FileAcc, rest: string): void {
	const [hitsStr, name] = splitFirstComma(rest);
	const hits = Number.parseInt(hitsStr, 10);
	if (!name || !Number.isFinite(hits)) return;
	pushNamed(cur.fnEntryHits, name, hits);
}

/** Apply a `BRDA:<line>,<block>,<branch>,<taken|->` record. */
function applyBrdaRecord(cur: FileAcc, rest: string): void {
	const parts = rest.split(",");
	if (parts.length < 4) return;
	const key = `${parts[0]}:${parts[1]}:${parts[2]}`;
	const takenRaw = parts[3] ?? "-";
	const taken = takenRaw === "-" ? 0 : Number.parseInt(takenRaw, 10);
	if (!Number.isFinite(taken)) return;
	cur.branchTaken.set(key, (cur.branchTaken.get(key) ?? 0) + taken);
}

/**
 * Apply one already-tokenized detail record (`tag`/`rest`) to the in-progress
 * file accumulator `cur`. Records that require a file but arrive before any `SF`
 * (`cur === null`) are dropped, matching LCOV leniency. Summary tags
 * (LF/LH/BRF/BRH/FNF/FNH/TN) and unknown tags are ignored — every metric is
 * derived from the detail records instead.
 */
function applyDetailRecord(cur: FileAcc | null, tag: string, rest: string): void {
	if (!cur) return;
	switch (tag) {
		case "DA":
			applyDaRecord(cur, rest);
			break;
		case "FN":
			applyFnRecord(cur, rest);
			break;
		case "FNDA":
			applyFndaRecord(cur, rest);
			break;
		case "BRDA":
			applyBrdaRecord(cur, rest);
			break;
		default:
			break;
	}
}

/**
 * Parse an LCOV string into canonical coverage. Pure — never throws on
 * arbitrary input (malformed lines are skipped).
 */
export function parseLcov(content: string, opts: ParseLcovOptions = {}): CanonicalCoverage {
	const cwd = opts.cwd;
	const accs = new Map<string, FileAcc>();
	let cur: FileAcc | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line === "end_of_record") {
			cur = null;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const tag = line.slice(0, colon);
		const rest = line.slice(colon + 1);

		if (tag === "SF") {
			// An empty/invalid path leaves the current file unchanged.
			const acc = resolveSfAcc(accs, rest, cwd);
			if (acc) cur = acc;
		} else {
			applyDetailRecord(cur, tag, rest);
		}
	}

	const files = new Map<string, CanonicalFileCoverage>();
	for (const [path, acc] of accs) {
		files.set(path, finalizeFile(path, acc));
	}
	return { files, source: "lcov" };
}

function finalizeFile(path: string, acc: FileAcc): CanonicalFileCoverage {
	let linesCovered = 0;
	for (const hits of acc.lineHits.values()) if (hits > 0) linesCovered++;

	let branchesCovered = 0;
	for (const taken of acc.branchTaken.values()) if (taken > 0) branchesCovered++;

	// Pair FN start lines with FNDA hits POSITIONALLY per name (LCOV correlates
	// them by order within a name, not by line — FNDA carries no line), then merge
	// by (name, line) so a name repeated within one file stays distinct while
	// merged reports still sum into the same function.
	const byKey = new Map<string, { name: string; line: number; hits: number }>();
	for (const [name, lines] of acc.fnStartLines) {
		const hitsList = acc.fnEntryHits.get(name) ?? [];
		for (const [k, line] of lines.entries()) {
			const hits = hitsList[k] ?? 0;
			const key = `${name}@${line}`;
			const existing = byKey.get(key);
			if (existing) existing.hits += hits;
			else byKey.set(key, { name, line, hits });
		}
	}
	const perFunction: CanonicalFunction[] = [];
	let functionsCovered = 0;
	for (const fn of byKey.values()) {
		if (fn.hits > 0) functionsCovered++;
		perFunction.push({ name: fn.name, line: fn.line, hits: fn.hits });
	}

	return {
		path,
		lines: metric(linesCovered, acc.lineHits.size),
		branches: metric(branchesCovered, acc.branchTaken.size),
		functions: metric(functionsCovered, byKey.size),
		perFunction,
		lineHits: acc.lineHits,
	};
}

/** Read + parse an `lcov.info` file. Returns null when absent/unreadable. */
export function loadLcovFile(path: string, opts: ParseLcovOptions = {}): CanonicalCoverage | null {
	if (!existsSync(path)) return null;
	try {
		return parseLcov(readFileSync(path, "utf-8"), opts);
	} catch {
		return null;
	}
}

/**
 * Bridge canonical coverage into the ratchet's `CoverageSummary` shape, so the
 * existing per-file coverage ratchet (and CRAP) consume LCOV-derived data
 * unchanged. This is the seam that makes the ratchet language-agnostic: any
 * engine → LCOV → canonical → this → ratchet.
 */
export function canonicalToCoverageSummary(cov: CanonicalCoverage): CoverageSummary {
	const out: CoverageSummary = {};
	for (const [path, f] of cov.files) {
		out[path] = {
			lines: { pct: f.lines.pct, covered: f.lines.covered, total: f.lines.total },
			branches: { pct: f.branches.pct, covered: f.branches.covered, total: f.branches.total },
			functions: { pct: f.functions.pct, covered: f.functions.covered, total: f.functions.total },
		};
	}
	return out;
}

/**
 * Bridge one LCOV file record into the per-function `PerFileCoverage` shape CRAP
 * scoring consumes — the cross-language equivalent of the istanbul
 * `coverage-final.json` reader. LCOV records per-LINE hits (`DA`) and per-
 * function entry hits (`FNDA`) but NOT per-function statement coverage, so each
 * function's coverage is derived by intersecting the line-hit map with the
 * function's source range (supplied from the AST complexity pass): covered =
 * lines in `[line, endLine]` with hits > 0, over the lines in that range LCOV
 * recorded at all. This mirrors istanbul's `computeStatementPct` at line
 * granularity, letting any LCOV-emitting engine (coverage.py, cargo-llvm-cov,
 * gcov, vitest's lcov reporter) feed `interlinked metrics` CRAP — not just the
 * istanbul JSON reporter.
 */
export function perFileCoverageFromCanonical(
	canonicalFile: CanonicalFileCoverage,
	rel: string,
	mtime: number,
	fnRanges: ReadonlyArray<{ name: string; line: number; endLine: number }>,
): PerFileCoverage {
	const lineHits = canonicalFile.lineHits;
	const fnEntryHits = new Map<number, number>();
	for (const fn of canonicalFile.perFunction) fnEntryHits.set(fn.line, fn.hits);

	const functions: FunctionCoverage[] = [];
	for (const fn of fnRanges) {
		let total = 0;
		let covered = 0;
		for (let ln = fn.line; ln <= fn.endLine; ln++) {
			const hits = lineHits.get(ln);
			if (hits === undefined) continue;
			total++;
			if (hits > 0) covered++;
		}
		// The function's line range (derived from the CURRENT source AST) covers
		// no line the report knows about — the source moved since the coverage
		// run. That is an absent measurement, not 0% coverage; reporting 0 here
		// fabricated maximal CRAP scores for well-tested functions. Omit the
		// entry so consumers distinguish "unknown" from "uncovered".
		if (total === 0) continue;
		functions.push({
			name: fn.name,
			line: fn.line,
			endLine: fn.endLine,
			hits: fnEntryHits.get(fn.line) ?? (covered > 0 ? 1 : 0),
			statement_pct: (covered / total) * 100,
		});
	}
	return { filePath: rel, mtime, functions };
}
