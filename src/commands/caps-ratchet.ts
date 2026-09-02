// ===========================================
// `interlinked caps ratchet <metric> --to <n>` and `interlinked caps status`
// ===========================================
// The stepped per-function complexity ratchet. `ratchet` tightens ONE cap in
// `.interlinked/metric-caps.json` AND regenerates the grandfather ledger
// (`.interlinked/function-complexity-baseline.json`) for every function over
// the new cap — the ledger is what lets the write gates allow those functions
// to hold/shrink while blocking every other over-cap function. Both files are
// gate-protected (baseline-integrity gate), so this command writes them via
// internal fs exactly like the other ratchet writers, never the edit tools.
//
// `status` is the burn-down view: per metric, the cap, entries remaining, the
// top offenders, and the delta against the `.previous` snapshot the last
// ratchet left behind.
//
// Admission rule (mirrors the integrity detector in
// evaluator/function-complexity-baseline-gate.ts, so the effect arm reads the
// ratchet's own shell run as a tightening, not a loosening): with a prior
// section, a function ENTERS the ledger only when this tightening newly put it
// over the cap — live value in (newCap, oldCap]. A same-cap re-run adds nothing
// (it still drops resolved entries), and a function above the OLD cap that was
// never listed stays unlisted: it keeps blocking until decomposed, and is
// reported as `unlisted` rather than laundered in at its live value. The first
// section for a metric seeds every over-cap function (there is no old regime).
// Known limitation: that first seeding of a SECOND metric, run from the shell
// while the ledger already exists, trips one effect-arm warning — the detector
// has no old cap for a brand-new section.
//
// `caps set cyclomatic|cognitive <n>` delegates here whenever a ledger section
// exists, so a cap change can never leave the ledger stale (caps.ts).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ComplexityMetric,
	COMPLEXITY_METRICS,
	computeOverCap,
	type FunctionComplexityLedger,
	type GrandfatheredFunction,
	isComplexityMetric,
	loadFunctionComplexityBaseline,
	loadPreviousFunctionComplexityBaseline,
	mergeShrinkOnly,
	type MetricLedger,
	saveFunctionComplexityBaseline,
	snapshotPreviousFunctionComplexityBaseline,
} from "../harness/function-complexity-baseline.js";
import { maxCognitiveFor, maxCyclomaticFor, resetMetricCapsCache } from "../harness/metric-caps.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Parse an existing metric-caps.json into a plain object; {} on absent, malformed
 *  JSON, or JSON that parses to a non-object shape (array/string/number — valid
 *  JSON, wrong shape) — all three take the same documented overwrite-cleanly path. */
function readExisting(path: string): JsonObject {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isJsonObject(parsed) ? parsed : {}; // wrong shape → overwrite cleanly
	} catch {
		return {}; // malformed → overwrite cleanly
	}
}

/**
 * Write ONE cap into `.interlinked/metric-caps.json` via internal fs (the
 * harness's own ratchet writes never go through the edit tools, so the
 * baseline-integrity gate never sees them). The ONE writer, shared by
 * `caps set` and `caps ratchet`. Creates `.interlinked/` when absent so the
 * command works before `interlinked enable` (or in any repo lacking it) instead
 * of throwing ENOENT — the committed metric-caps.json is a policy file, not a
 * runtime artifact that presupposes enablement (finding 2026-06, round 8).
 */
export function writeMetricCapOverride(cwd: string, configKey: string, value: number): void {
	const dir = join(cwd, ".interlinked");
	const path = join(dir, "metric-caps.json");
	const next = { version: 1, ...readExisting(path), [configKey]: value };
	mkdirSync(dir, { recursive: true }); // recursive ⇒ idempotent
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	resetMetricCapsCache();
}

export interface CapsRatchetOpts {
	to?: string;
	dryRun?: boolean;
	json?: boolean;
}

interface CapsDeps {
	cwd?: string;
}

const CONFIG_KEY: Record<ComplexityMetric, "max_cyclomatic" | "max_cognitive"> = {
	cyclomatic: "max_cyclomatic",
	cognitive: "max_cognitive",
};

function effectiveCap(cwd: string, metric: ComplexityMetric): number {
	return metric === "cyclomatic" ? maxCyclomaticFor(cwd) : maxCognitiveFor(cwd);
}

function metricList(): string {
	return COMPLEXITY_METRICS.join(", ");
}

/** Positive integer from `--to`, or an error string. */
function parseTarget(raw: string | undefined): number | string {
	if (raw === undefined) return "--to <n> is required";
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) return `--to must be a positive integer (got "${raw}")`;
	return n;
}

interface RatchetPlan {
	section: MetricLedger;
	/** Known entries whose live value rose past the recorded one (kept at the recorded value). */
	regressed: GrandfatheredFunction[];
	/** Entries that entered the ledger in this run. */
	added: number;
	/** Over-cap functions NOT admitted (unlisted under the old regime) — they keep blocking. */
	unlisted: GrandfatheredFunction[];
}

type Admission = Pick<RatchetPlan, "added" | "unlisted"> & { entries: GrandfatheredFunction[] };

function entryKey(e: GrandfatheredFunction): string {
	return `${e.file}::${e.name}`;
}

/** May `e` (over the new cap, not previously listed) enter the ledger? See the header. */
function admits(prev: MetricLedger, cap: number, e: GrandfatheredFunction): boolean {
	return cap < prev.cap && e.value <= prev.cap;
}

/** With a prior section: keep known entries, admit the newly-over ones, report the rest. */
function admitEntries(prev: MetricLedger, cap: number, live: readonly GrandfatheredFunction[]): Admission {
	const known = new Set(prev.entries.map(entryKey));
	const out: Admission = { entries: [], added: 0, unlisted: [] };
	for (const e of live) {
		const isKnown = known.has(entryKey(e));
		if (!isKnown && !admits(prev, cap, e)) {
			out.unlisted.push(e);
			continue;
		}
		out.entries.push(e);
		if (!isKnown) out.added += 1;
	}
	return out;
}

/** The regenerated section for `metric` at `cap`, or null when the analyzer is unavailable. */
function regenerate(
	cwd: string,
	metric: ComplexityMetric,
	cap: number,
	prev: MetricLedger | undefined,
): RatchetPlan | null {
	const live = computeOverCap(cwd, metric, cap);
	if (live === null) return null;
	const merged = mergeShrinkOnly(prev?.entries ?? [], live);
	// First section for the metric: seed everything over the cap (no old regime).
	const admitted: Admission = prev
		? admitEntries(prev, cap, merged.entries)
		: { entries: merged.entries, added: merged.entries.length, unlisted: [] };
	return { section: { cap, entries: admitted.entries }, regressed: merged.regressed, added: admitted.added, unlisted: admitted.unlisted };
}

function fmtEntry(e: GrandfatheredFunction): string {
	return `${String(e.value).padStart(4)}  ${e.file}:${e.line}  ${e.name}`;
}

function printRatchetPlan(metric: ComplexityMetric, from: number, to: number, plan: RatchetPlan, dryRun: boolean): void {
	const verb = dryRun ? "Would ratchet" : "Ratcheted";
	console.log(`${verb} ${metric} cap ${from} → ${to}${dryRun ? "  (dry run — nothing written)" : ""}`);
	console.log(
		`  ${plan.section.entries.length} function(s) grandfathered over ${to} (${plan.added} newly listed)`,
	);
	if (plan.regressed.length > 0) {
		console.log(`  ${plan.regressed.length} regressed past their recorded value (kept at the recorded value):`);
		for (const e of plan.regressed) console.log(`    ${fmtEntry(e)}`);
	}
	if (plan.unlisted.length > 0) {
		console.log(
			`  ${plan.unlisted.length} over-cap function(s) NOT listed — never on the ledger and not newly over ${to} ` +
				"(a ratchet never launders growth); they block until decomposed:",
		);
		for (const e of plan.unlisted) console.log(`    ${fmtEntry(e)}`);
	}
	if (!dryRun) console.log("  Wrote .interlinked/metric-caps.json and .interlinked/function-complexity-baseline.json.");
}

/** `interlinked caps ratchet <metric> --to <n>` — tighten a cap + regenerate its ledger section. */
export async function capsRatchetAction(
	metric: string,
	opts: CapsRatchetOpts,
	deps: CapsDeps = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	if (!isComplexityMetric(metric)) {
		console.error(`Unknown metric "${metric}". Valid: ${metricList()}.`);
		return 1;
	}
	const to = parseTarget(opts.to);
	if (typeof to === "string") {
		console.error(`Cannot ratchet ${metric}: ${to}.`);
		return 1;
	}
	const from = effectiveCap(cwd, metric);
	if (to > from) {
		console.error(`Cannot ratchet ${metric}: ${to} would loosen the current ${from} cap; a cap may only tighten.`);
		return 1;
	}
	const prev = loadFunctionComplexityBaseline(cwd);
	const plan = regenerate(cwd, metric, to, prev?.metrics[metric]);
	if (plan === null) {
		console.error("Cannot ratchet: the TypeScript analyzer is unavailable (install the optional `typescript` dependency).");
		return 1;
	}
	if (opts.json) {
		console.log(
			JSON.stringify({
				metric,
				from,
				dry_run: opts.dryRun === true,
				cap: plan.section.cap,
				entries: plan.section.entries,
				regressed: plan.regressed,
				added: plan.added,
				unlisted: plan.unlisted,
			}),
		);
	} else {
		printRatchetPlan(metric, from, to, plan, opts.dryRun === true);
	}
	if (opts.dryRun) return 0;
	snapshotPreviousFunctionComplexityBaseline(cwd);
	const next: FunctionComplexityLedger = { version: 1, metrics: { ...prev?.metrics, [metric]: plan.section } };
	saveFunctionComplexityBaseline(cwd, next);
	writeMetricCapOverride(cwd, CONFIG_KEY[metric], to);
	return 0;
}

// ---- status ---------------------------------------------------------------

const TOP_N = 10;

interface MetricStatus {
	cap: number;
	effective_cap: number;
	remaining: number;
	top: GrandfatheredFunction[];
	previous: { cap: number; remaining: number } | null;
}

function metricStatus(cwd: string, metric: ComplexityMetric): MetricStatus | null {
	const section = loadFunctionComplexityBaseline(cwd)?.metrics[metric];
	if (!section) return null;
	const prev = loadPreviousFunctionComplexityBaseline(cwd)?.metrics[metric];
	const top = [...section.entries].sort((a, b) => b.value - a.value).slice(0, TOP_N);
	return {
		cap: section.cap,
		effective_cap: effectiveCap(cwd, metric),
		remaining: section.entries.length,
		top,
		previous: prev ? { cap: prev.cap, remaining: prev.entries.length } : null,
	};
}

function printMetricStatus(metric: ComplexityMetric, s: MetricStatus | null): void {
	if (!s) {
		console.log(`${metric}: no ledger — start one with \`interlinked caps ratchet ${metric} --to <n>\`.`);
		return;
	}
	const drift = s.effective_cap !== s.cap ? `  (effective cap ${s.effective_cap} — re-run caps ratchet)` : "";
	console.log(`${metric}: cap ${s.cap}${drift}, ${s.remaining} entries remaining`);
	if (s.previous) {
		console.log(`  previous: cap ${s.previous.cap}, ${s.previous.remaining} entries (Δ ${s.remaining - s.previous.remaining})`);
	}
	if (s.top.length > 0) console.log(`  top ${s.top.length} by value:`);
	for (const e of s.top) console.log(`    ${fmtEntry(e)}`);
}

/** `interlinked caps status` — the per-metric burn-down of the grandfather ledger. */
export async function capsStatusAction(opts: { json?: boolean }, deps: CapsDeps = {}): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const statuses = new Map<ComplexityMetric, MetricStatus | null>();
	for (const metric of COMPLEXITY_METRICS) statuses.set(metric, metricStatus(cwd, metric));
	if (opts.json) {
		console.log(JSON.stringify(Object.fromEntries(statuses), null, 2));
		return 0;
	}
	console.log("Per-function complexity grandfather ledger (.interlinked/function-complexity-baseline.json):");
	for (const [metric, s] of statuses) printMetricStatus(metric, s);
	return 0;
}
