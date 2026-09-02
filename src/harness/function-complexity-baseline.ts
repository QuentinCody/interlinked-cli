// ===========================================
// Per-function complexity grandfather ledger + stepped ratchet
// ===========================================
// `.interlinked/function-complexity-baseline.json` is the per-FUNCTION analog
// of `large-files-baseline.json`: when a complexity cap is ratcheted down
// (`interlinked caps ratchet <metric> --to <n>`), every function already over
// the new cap is recorded here at its current value. The two per-function
// write gates (complexity-write-guard.ts / cognitive-write-guard.ts, both
// instantiating per-function-metric-gate.ts) then consult this ledger:
//
//   listed function, hold or shrink        → allowed (the burn-down path)
//   listed function, ANY growth            → blocked (names the grandfathered value)
//   unlisted function over the cap         → blocked (bound by the cap)
//   no ledger / no section for the metric  → legacy delta semantics (on-disk before-state)
//
// The entries list is SHRINK-ONLY under the baseline-integrity gate
// (evaluator/function-complexity-baseline-gate.ts): a hand-edit may drop an
// entry or lower a value, never add or raise one. The harness's own writes go
// through `saveFunctionComplexityBaseline` (internal fs), never the edit tools,
// so the ratchet's regeneration bypasses that gate — the same exemption every
// ratchet raise relies on.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { computeCognitiveAst } from "./checks/cognitive-ast.js";
import { computeCyclomaticAst } from "./checks/cyclomatic-ast.js";
import { getGitSourceFiles } from "./checks/export-ripple.js";
import { isCappableFile } from "./large-file-policy.js";

/** Repo-relative path of the committed ledger. */
export const FUNCTION_COMPLEXITY_BASELINE_REL = ".interlinked/function-complexity-baseline.json";
/** Sibling snapshot the ratchet keeps so `caps status` can show a delta. */
export const FUNCTION_COMPLEXITY_PREVIOUS_REL =
	".interlinked/function-complexity-baseline.previous.json";

/** The two per-function complexity metrics the ledger tracks. */
export const COMPLEXITY_METRICS = ["cyclomatic", "cognitive"] as const;
export type ComplexityMetric = (typeof COMPLEXITY_METRICS)[number];

export function isComplexityMetric(value: string): value is ComplexityMetric {
	return (COMPLEXITY_METRICS as readonly string[]).includes(value);
}

/** One grandfathered function: repo-relative POSIX `file`, the analyzer's
 *  function `name`, its 1-based `line` at ratchet time, and the recorded
 *  `value` it may hold or shrink from but never exceed. */
export interface GrandfatheredFunction {
	file: string;
	name: string;
	line: number;
	value: number;
}

export interface MetricLedger {
	cap: number;
	entries: GrandfatheredFunction[];
}

export interface FunctionComplexityLedger {
	version: 1;
	metrics: Partial<Record<ComplexityMetric, MetricLedger>>;
}

export type GrandfatherVerdict = "allowed" | "grow";

// ---- load / save ----------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function parseEntry(raw: unknown): GrandfatheredFunction | null {
	if (!isJsonObject(raw)) return null;
	const { file, name, line, value } = raw;
	if (typeof file !== "string" || typeof name !== "string") return null;
	if (!isFiniteNumber(line) || !isFiniteNumber(value)) return null;
	return { file, name, line, value };
}

function parseMetricLedger(raw: unknown): MetricLedger | null {
	if (!isJsonObject(raw) || !isFiniteNumber(raw.cap) || !Array.isArray(raw.entries)) return null;
	const entries: GrandfatheredFunction[] = [];
	for (const e of raw.entries) {
		const parsed = parseEntry(e);
		if (parsed) entries.push(parsed);
	}
	return { cap: raw.cap, entries };
}

function parseLedger(raw: unknown): FunctionComplexityLedger | null {
	if (!isJsonObject(raw) || raw.version !== 1 || !isJsonObject(raw.metrics)) return null;
	const metrics: FunctionComplexityLedger["metrics"] = {};
	for (const metric of COMPLEXITY_METRICS) {
		const section = parseMetricLedger(raw.metrics[metric]);
		if (section) metrics[metric] = section;
	}
	return { version: 1, metrics };
}

let ledgerCache = new Map<string, { mtimeMs: number; value: FunctionComplexityLedger | null }>();

/** Test hook: forget every memoized ledger. */
export function resetFunctionComplexityBaselineCache(): void {
	ledgerCache = new Map();
}

/**
 * Load the ledger for `cwd`. Mtime-aware cache (a `caps ratchet` is picked up
 * without a daemon restart). Fail-soft: absent, malformed, or wrong-shaped →
 * `null`, which every consumer reads as "legacy delta semantics".
 */
export function loadFunctionComplexityBaseline(cwd: string): FunctionComplexityLedger | null {
	const path = join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL);
	let mtimeMs = -1;
	try {
		if (existsSync(path)) mtimeMs = statSync(path).mtimeMs;
	} catch {
		mtimeMs = -1;
	}
	if (mtimeMs < 0) {
		ledgerCache.delete(cwd);
		return null;
	}
	const cached = ledgerCache.get(cwd);
	if (cached && cached.mtimeMs === mtimeMs) return cached.value;
	let value: FunctionComplexityLedger | null = null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		value = parseLedger(raw);
	} catch {
		value = null;
	}
	ledgerCache.set(cwd, { mtimeMs, value });
	return value;
}

/** Internal fs write (never the edit tools — so the integrity gate never sees it). */
export function saveFunctionComplexityBaseline(cwd: string, ledger: FunctionComplexityLedger): void {
	const path = join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
	resetFunctionComplexityBaselineCache();
}

/** The `.previous` snapshot `caps ratchet` keeps (uncached; null when absent/malformed). */
export function loadPreviousFunctionComplexityBaseline(cwd: string): FunctionComplexityLedger | null {
	const text = safeRead(join(cwd, FUNCTION_COMPLEXITY_PREVIOUS_REL));
	if (text === null) return null;
	try {
		const raw: unknown = JSON.parse(text);
		return parseLedger(raw);
	} catch {
		return null;
	}
}

/** Copy the current ledger to its `.previous` sibling before a ratchet
 *  rewrites it, so `caps status` can show the delta. False when no ledger exists. */
export function snapshotPreviousFunctionComplexityBaseline(cwd: string): boolean {
	const text = safeRead(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL));
	if (text === null) return false;
	writeFileSync(join(cwd, FUNCTION_COMPLEXITY_PREVIOUS_REL), text);
	return true;
}

// ---- scan -----------------------------------------------------------------

/** One analyzed function, metric-agnostic; null = analyzer unavailable. */
type Scanner = (
	content: string,
	filePath: string,
) => Array<{ name: string; line: number; value: number }> | null;

function scannerFor(metric: ComplexityMetric): Scanner {
	if (metric === "cyclomatic") {
		return (content, filePath) =>
			computeCyclomaticAst(content, filePath)?.map((e) => ({
				name: e.name,
				line: e.line,
				value: e.cyclomatic,
			})) ?? null;
	}
	return (content, filePath) =>
		computeCognitiveAst(content, filePath)?.map((e) => ({
			name: e.name,
			line: e.line,
			value: e.cognitive,
		})) ?? null;
}

function safeRead(abs: string): string | null {
	try {
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}

/** Over-cap functions in ONE file, or null when the analyzer is unavailable. */
function overCapInFile(
	cwd: string,
	rel: string,
	metric: ComplexityMetric,
	cap: number,
): GrandfatheredFunction[] | null {
	const abs = join(cwd, rel);
	const content = safeRead(abs);
	if (content === null || !isCappableFile({ filePath: abs, content, root: cwd })) return [];
	const entries = scannerFor(metric)(content, rel);
	if (entries === null) return null;
	return entries.filter((e) => e.value > cap).map((e) => ({ file: rel, ...e }));
}

/**
 * Every function over `cap` across the repo's git-visible cappable product
 * files (tracked + untracked-not-ignored; tests / generated / scratch / tool
 * state excluded via `isCappableFile`). Sorted by file then line. Returns
 * `null` when the TS analyzer is unavailable — the caller must say so loudly
 * rather than write an empty ledger.
 */
export function computeOverCap(
	cwd: string,
	metric: ComplexityMetric,
	cap: number,
): GrandfatheredFunction[] | null {
	const out: GrandfatheredFunction[] = [];
	for (const rel of [...getGitSourceFiles(cwd)].sort()) {
		const inFile = overCapInFile(cwd, rel, metric, cap);
		if (inFile === null) return null;
		out.push(...inFile);
	}
	return out;
}

// ---- lookup / verdict -----------------------------------------------------

/** Repo-relative POSIX path for a ledger key (absolute or relative input). */
export function toLedgerRelPath(cwd: string, filePath: string): string {
	const norm = filePath.replace(/\\/g, "/");
	if (!isAbsolute(norm)) return norm;
	return relative(resolve(cwd), norm).replace(/\\/g, "/");
}

/** The grandfathered value for (file, name) — the max over same-named entries —
 *  or null when unlisted (or no ledger / no section for the metric). */
export function lookupGrandfathered(
	ledger: FunctionComplexityLedger | null,
	metric: ComplexityMetric,
	file: string,
	name: string,
): number | null {
	const section = ledger?.metrics[metric];
	if (!section) return null;
	let best: number | null = null;
	for (const e of section.entries) {
		if (e.file === file && e.name === name && (best === null || e.value > best)) best = e.value;
	}
	return best;
}

/** Highest value a grandfathered function may reach in one edit: never above
 *  its recorded value, and never above what it was before the edit. */
export function grandfatheredCeiling(value: number, before: number | undefined): number {
	return before === undefined ? value : Math.min(value, before);
}

/** Pure verdict: a listed function may hold or shrink, never grow. */
export function grandfatherVerdict(
	entry: { value: number },
	before: number | undefined,
	after: number,
): GrandfatherVerdict {
	return after <= grandfatheredCeiling(entry.value, before) ? "allowed" : "grow";
}

// ---- per-file view for the write gates -------------------------------------

/** The ledger's view of ONE file, in the shape the metric gate compares against. */
export interface FileGrandfather {
	/** Uniquely-named entries for this file → recorded value. */
	byName: Map<string, number>;
	/** Anonymous / colliding entries for this file, values sorted descending. */
	pooled: number[];
	/** Ledger-wide entry count for the metric (the burn-down denominator). */
	total: number;
	/** The cap the ledger was generated against. */
	cap: number;
}

/** Split a file's entries into unique-name and pooled (anonymous/collision) views. */
function splitFileEntries(
	entries: readonly GrandfatheredFunction[],
	anonName: string,
	file: string,
): { byName: Map<string, number>; pooled: number[] } {
	const counts = new Map<string, number>();
	for (const e of entries) if (e.file === file) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
	const byName = new Map<string, number>();
	const pooled: number[] = [];
	for (const e of entries) {
		if (e.file !== file) continue;
		if (e.name === anonName || (counts.get(e.name) ?? 0) > 1) pooled.push(e.value);
		else byName.set(e.name, e.value);
	}
	pooled.sort((a, b) => b - a);
	return { byName, pooled };
}

/** The per-file view, or null when no ledger section exists for `metric`
 *  (legacy delta mode). An empty view is still authoritative. */
export function fileGrandfather(
	ledger: FunctionComplexityLedger | null,
	metric: ComplexityMetric,
	anonName: string,
	relFile: string,
): FileGrandfather | null {
	const section = ledger?.metrics[metric];
	if (!section) return null;
	const { byName, pooled } = splitFileEntries(section.entries, anonName, relFile);
	return { byName, pooled, total: section.entries.length, cap: section.cap };
}

/** The extensions `computeOverCap` can ledger (git-visible JS/TS). A file outside
 *  this set — e.g. a `.py` the cyclomatic gate routes to radon — can never be
 *  listed, so the gate must keep legacy delta semantics for it. */
const LEDGERABLE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

/** Resolver a `MetricGateSpec` plugs in: loads the ledger for `cwd` and views
 *  `filePath`; null (legacy delta) when no ledger section exists or the file
 *  is not one the ledger can describe. */
export function makeGrandfatherResolver(
	metric: ComplexityMetric,
	anonName: string,
): (cwd: string, filePath: string) => FileGrandfather | null {
	return (cwd, filePath) =>
		!LEDGERABLE_RE.test(filePath)
			? null
			: fileGrandfather(
			loadFunctionComplexityBaseline(cwd),
			metric,
			anonName,
			toLedgerRelPath(cwd, filePath),
		);
}

/**
 * Ledger-mode rule for an UNLISTED entry. A value at or under the ledger's OWN
 * cap is not "unlisted over-cap" — the ledger was generated at `gf.cap`, and a
 * subsequently TIGHTENED effective cap (the only direction the
 * baseline-integrity gate allows) does not retroactively demand it be listed.
 * It is simply not yet ratcheted, so it falls back to the legacy
 * hold/shrink-vs-prior comparison: held or shrunk is allowed, any growth
 * blocks. Only a value genuinely above the ledger's cap is "not grandfathered".
 */
function unlistedOverCapViolation(
	label: string,
	name: string,
	value: number,
	prior: number | undefined,
	gf: FileGrandfather,
): string | null {
	if (value > gf.cap) {
		return (
			`${name} (${label} ${value}, over the ${gf.cap} cap and not grandfathered — ` +
			`the ledger lists ${gf.total} function(s); shrink it to ≤ ${gf.cap})`
		);
	}
	if (prior !== undefined && value <= prior) return null; // held or reduced
	const how = prior !== undefined ? `raised from ${prior}` : "new over-cap function";
	return `${name} (${label} ${value}, ${how})`;
}

/**
 * Ledger-mode identity rule for ONE uniquely-named over-cap function. Returns
 * the violation text, or null when the edit holds/shrinks a listed function.
 */
export function ledgerOverCapViolation(
	label: string,
	name: string,
	value: number,
	prior: number | undefined,
	gf: FileGrandfather,
): string | null {
	const recorded = gf.byName.get(name);
	if (recorded === undefined) return unlistedOverCapViolation(label, name, value, prior, gf);
	if (value <= grandfatheredCeiling(recorded, prior)) return null;
	const was = prior !== undefined && prior !== recorded ? `, was ${prior}` : "";
	return (
		`${name} (${label} ${value}, grandfathered at ${recorded}${was} — 1 of ${gf.total} ` +
		`grandfathered over the ${gf.cap} cap; a grandfathered function may hold or shrink, never grow)`
	);
}

/** Trailing note for a ledger-mode block message. */
export function ledgerNote(label: string, gf: FileGrandfather): string {
	return (
		`Grandfather ledger ${FUNCTION_COMPLEXITY_BASELINE_REL} lists ${gf.total} ${label} ` +
		"function(s) over the cap; `interlinked caps status` shows the burn-down."
	);
}

/** Drift note: null when the ledger's cap matches the currently effective cap;
 *  otherwise names the drift and the ratchet verb that regenerates the ledger
 *  at the new cap (a non-`caps ratchet` writer of `metric-caps.json` — a
 *  tightening Edit, or a checked-out lower value — leaves the ledger stamped
 *  with its old generation cap, which `ledgerOverCapViolation` above must be
 *  told about rather than silently judging every unlisted function against). */
export function ledgerDriftNote(
	label: string,
	gf: FileGrandfather,
	effectiveCap: number,
): string | null {
	if (gf.cap === effectiveCap) return null;
	return (
		`Ledger cap (${gf.cap}) differs from the effective ${label} cap (${effectiveCap}) — ` +
		`run \`interlinked caps ratchet ${label} --to ${effectiveCap}\` to regenerate it.`
	);
}

// ---- ratchet regeneration -------------------------------------------------

function entryKey(e: GrandfatheredFunction): string {
	return `${e.file}::${e.name}`;
}

/**
 * Regenerate entries from a live scan WITHOUT laundering growth: a function
 * present in both keeps the smaller value (the ledger is shrink-only, so a
 * live value above the recorded one is a regression, reported separately);
 * resolved functions drop; new over-cap functions enter at their live value.
 */
export function mergeShrinkOnly(
	prev: readonly GrandfatheredFunction[],
	live: readonly GrandfatheredFunction[],
): { entries: GrandfatheredFunction[]; regressed: GrandfatheredFunction[] } {
	const recorded = new Map<string, number>();
	for (const e of prev) recorded.set(entryKey(e), Math.max(recorded.get(entryKey(e)) ?? 0, e.value));
	const entries: GrandfatheredFunction[] = [];
	const regressed: GrandfatheredFunction[] = [];
	for (const e of live) {
		const was = recorded.get(entryKey(e));
		if (was !== undefined && e.value > was) regressed.push(e);
		entries.push(was === undefined ? e : { ...e, value: Math.min(was, e.value) });
	}
	return { entries, regressed };
}
