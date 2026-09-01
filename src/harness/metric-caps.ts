// ===========================================
// Metric caps — the single source of truth for the quality-metric caps
// ===========================================
// The harness enforces six numeric quality metrics, each with a cap/goal every user
// can tune (we ship conservative defaults; users are in charge of the figures):
//
//   - lines       — per-file line count                         (lower is stricter)
//   - function-tokens — canonical tokens per implementation     (lower is stricter)
//   - cyclomatic  — per-function independent branch paths        (lower is stricter)
//   - cognitive   — per-function nesting-weighted readability    (lower is stricter)
//   - crap        — per-function complexity × under-coverage     (lower is stricter)
//   - coverage    — per-file statement coverage floor            (higher is stricter)
//
// Any cap can be overridden per repo in the committed file
// `.interlinked/metric-caps.json`; an absent key falls back to the legacy
// per-metric config (where one exists) and then to the shipped DEFAULT here.
//
// This module is deliberately LOW-LEVEL — it imports only `node:fs`/`node:path`
// so the enforcement modules (complexity-write-guard, the coverage/CRAP gates,
// large-file-policy) import the constants + resolvers from HERE without a cycle.
// It also owns METRIC_DEFS, the one canonical glossary the `interlinked caps`
// command, the generated docs, and every block message read from — so an agent
// working on ANY codebase where this harness runs gets ONE consistent, legible
// definition of each metric and how to change its cap. "No agent ever confused
// about what these metrics are" is this file's job.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Shipped default per-file line cap (overridable). Imported + re-exported by
 *  `large-file-policy.ts`, which keeps the grandfather list + legacy baseline. */
export const DEFAULT_MAX_LINES = 500;
/** Shipped, model-independent per-function canonical-token ceiling. */
export const DEFAULT_MAX_FUNCTION_TOKENS = 500;
/** Shipped default per-function cyclomatic cap (overridable). */
export const DEFAULT_MAX_CYCLOMATIC = 25;
/** Shipped default per-function COGNITIVE-complexity cap (overridable). This is
 *  the GATE backstop (≈ this repo's p99, measured 2026-07-24: 70/8,497 functions
 *  above it) — deliberately looser than the Sonar-default 15 the advisory
 *  `cognitive_complexity` registry check warns at. Two numbers, two roles: the
 *  advisory nags early; the cap is the never-grow-past line. See
 *  docs/design/history-relational-metrics.md §5. */
export const DEFAULT_MAX_COGNITIVE_CAP = 30;
/** Shipped default per-function CRAP cap (overridable). The McCabe/SonarQube
 *  cutoff: a cyclomatic-10 function at 0% coverage scores 110, fully covered 10. */
export const DEFAULT_CRAP_THRESHOLD = 30;
/** Shipped default coverage FLOOR, in percent. 0 = floor disabled (the
 *  per-file non-decrease ratchet still applies independently). This is the
 *  hard-block lever; the user-facing "coverage" metric is the GOAL below. */
export const DEFAULT_MIN_COVERAGE = 0;
/** Shipped default coverage GOAL, in percent — the target the ratchets climb
 *  toward, default 100 (operator decision 2026-08-17: ambition is the default;
 *  a team may lower it to 80/90 as a less ambitious target). A goal never
 *  bricks a brownfield repo: enforcement stays hold-or-rise from the adopted
 *  baseline plus cover-what-you-add — the goal states where that ratchet is
 *  heading and drives display/nudges, while `min_coverage` remains the
 *  separate opt-in hard floor (rise-only under baseline_integrity_gate). */
export const DEFAULT_COVERAGE_GOAL = 100;
/** Coverage percentages live on a 0–100 scale; this is the scale's own ceiling
 *  (shared by the goal validation here and `caps set coverage` bounds). */
export const COVERAGE_SCALE_MAX = 100;

/** The six metrics, by stable key. */
export type MetricKey =
	| "lines"
	| "function-tokens"
	| "cyclomatic"
	| "cognitive"
	| "crap"
	| "coverage";

/** Fully-resolved caps for a repo (every key populated). `coverage_goal` is a
 *  TARGET, not a gate input: enforcement reads `min_coverage` (hard floor) and
 *  the per-file high-water ratchet; the goal drives display and nudges. */
interface MetricCaps {
	max_lines: number;
	max_function_tokens: number;
	max_cyclomatic: number;
	max_cognitive: number;
	crap_threshold: number;
	min_coverage: number;
	coverage_goal: number;
}

/** Where a resolved cap's value came from (shown by `interlinked caps`). */
type CapSource = "metric-caps.json" | "legacy-config" | "default";

/** Repo-relative path of the committed override file. */
export const METRIC_CAPS_REL = ".interlinked/metric-caps.json";

/**
 * One metric's canonical metadata: the definition an agent reads, the config
 * key, the shipped default, the direction, and the fix. SINGLE-SOURCED — the
 * CLI command, `docs/generated/metrics.md`, and every enforcement message all
 * read these strings, so a metric is described identically everywhere.
 */
interface MetricDef {
	key: MetricKey;
	/** Key in `.interlinked/metric-caps.json`. */
	configKey: keyof MetricCaps;
	/** Short human label, e.g. "cyclomatic complexity (per function)". */
	label: string;
	/** Unit suffix for a value, e.g. "branches", "lines", "%". */
	unit: string;
	/** "lower" → a smaller cap is stricter; "higher" → a larger floor is stricter. */
	stricter: "lower" | "higher";
	/** Shipped default value. */
	defaultValue: number;
	/** What the metric IS and why it matters — the agent-facing definition. */
	definition: string;
	/** How to change this cap. */
	howToConfigure: string;
	/** What to DO when an edit is blocked on this metric. */
	fixHint: string;
}

/**
 * One display row for a metric's SHIPPED DEFAULT, shared by every surface
 * that lists them (`interlinked caps`, the setup wizard, the browser demo —
 * the demo bundles this module, so the wording cannot drift).
 *
 * The row must respect the metric's direction. Four caps are maxima; coverage
 * is a GOAL (higher-is-stricter): the target the hold-or-rise ratchet climbs
 * toward, default 100, never a cap. Two operator reports shaped this wording —
 * 2026-08-16 ("no one talks about coverage in terms of zero percent as a
 * maximum cap") and 2026-08-17 ("adjust the number as a goal rather than a
 * cap; the default should be 100").
 */
export function formatMetricDefaultRow(def: MetricDef): string {
	const key = def.key.padEnd(11);
	if (def.stricter === "higher") {
		const value =
			def.defaultValue === 0
				? "goal off — hold-or-rise ratchet only (adopt seeds your repo's current %)"
				: `goal ${def.defaultValue}${def.unit ? ` ${def.unit}` : ""} — adopt seeds today's % as the floor; ratchets rise toward the goal`;
		return `${key} ${value}`;
	}
	return `${key} ≤ ${String(def.defaultValue).padStart(3)}${def.unit ? ` ${def.unit}` : ""}`;
}

/** The canonical glossary. Order is the display order. */
export const METRIC_DEFS: readonly MetricDef[] = [
	{
		key: "lines",
		configKey: "max_lines",
		label: "file size (lines)",
		unit: "lines",
		stricter: "lower",
		defaultValue: DEFAULT_MAX_LINES,
		definition:
			"The number of lines in a single hand-written code file. Large files are " +
			"harder for a human or agent to read, review, and safely edit, and slower to " +
			"run a full mutation-test pass over. Generated, test, .d.ts, and non-code files " +
			"are exempt.",
		howToConfigure: "`interlinked caps set lines <n>` (or .interlinked/metric-caps.json → max_lines)",
		fixHint:
			"Split the file into a re-exporting entry module plus smaller sibling modules " +
			"grouped by responsibility. Shrinking or holding an over-cap file is always allowed.",
	},
	{
		key: "function-tokens",
		configKey: "max_function_tokens",
		label: "canonical function size (per function)",
		unit: "tokens",
		stricter: "lower",
		defaultValue: DEFAULT_MAX_FUNCTION_TOKENS,
		definition:
			"The number of non-trivia lexical code tokens in one implementation under " +
			"the stable interlinked-code-v1 contract. It is independent of any embedding " +
			"model tokenizer: 500 passes, 501 is over the shipped absolute ceiling.",
		howToConfigure:
			"`interlinked caps set function-tokens <n>` (or .interlinked/metric-caps.json → max_function_tokens)",
		fixHint:
			"Split the implementation into cohesive named helpers. Existing over-cap " +
			"functions may hold or shrink, but may not grow; there is no inline suppression.",
	},
	{
		key: "cyclomatic",
		configKey: "max_cyclomatic",
		label: "cyclomatic complexity (per function)",
		unit: "branches",
		stricter: "lower",
		defaultValue: DEFAULT_MAX_CYCLOMATIC,
		definition:
			"The number of independent paths through a single function — +1 for each branch " +
			"point: if / else-if / for / while / case / catch / && / || / ?:. High complexity " +
			"means more test cases are needed to cover the function and it is harder to reason " +
			"about. Enforced per function, and additionally ratcheted: a named function may not " +
			"INCREASE its complexity even below the cap (no edit makes a function worse).",
		howToConfigure:
			"`interlinked caps set cyclomatic <n>` (or .interlinked/metric-caps.json → max_cyclomatic)",
		fixHint:
			"Extract cohesive groups of branches into smaller, named helper functions. There is " +
			"no suppression; decomposition is the only way past.",
	},
	{
		key: "cognitive",
		configKey: "max_cognitive",
		label: "cognitive complexity (per function)",
		unit: "",
		stricter: "lower",
		defaultValue: DEFAULT_MAX_COGNITIVE_CAP,
		definition:
			"SonarSource's readability model: nesting is penalized (+1 plus the current depth " +
			"per if/loop/switch/ternary/catch), boolean-run transitions cost 1, and a flat " +
			"switch is nearly free — so it disagrees with cyclomatic exactly where human " +
			"readers disagree with branch counting. Surfaced per edit as a PreToolUse warning " +
			"when a function GROWS past the cap (delta semantics; holding or shrinking an " +
			"over-cap function is always allowed). The stricter Sonar-default 15 fires " +
			"separately as the advisory `cognitive_complexity` check.",
		howToConfigure:
			"`interlinked caps set cognitive <n>` (or .interlinked/metric-caps.json → max_cognitive)",
		fixHint:
			"Flatten with early returns, extract nested blocks into named helpers (extraction " +
			"to top level also clears the lambda-depth penalty), or split mixed &&/|| chains " +
			"into named intermediate booleans.",
	},
	{
		key: "crap",
		configKey: "crap_threshold",
		label: "CRAP score (per function)",
		unit: "",
		stricter: "lower",
		defaultValue: DEFAULT_CRAP_THRESHOLD,
		definition:
			"Change Risk Anti-Patterns = cyclomatic² · (1 − coverage)³ + cyclomatic, per " +
			"function. It is high only when a function is BOTH complex AND under-tested — a " +
			"fully-covered function scores exactly its cyclomatic complexity; an uncovered " +
			"complex function explodes. It is the single number for 'this function is risky to change.'",
		howToConfigure: "`interlinked caps set crap <n>` (or .interlinked/metric-caps.json → crap_threshold)",
		fixHint:
			"Add tests to cover the function, reduce its cyclomatic complexity, or both. At full " +
			"coverage CRAP equals cyclomatic complexity, so keeping cyclomatic under its cap keeps CRAP safe.",
	},
	{
		key: "coverage",
		configKey: "coverage_goal",
		label: "coverage goal (per file)",
		unit: "%",
		stricter: "higher",
		defaultValue: DEFAULT_COVERAGE_GOAL,
		definition:
			"The coverage target this repo is climbing toward — a GOAL, not a cap (coverage " +
			"cannot be capped, and nothing above the goal is ever penalized). Default 100; a " +
			"team may set a less ambitious target like 80 or 90. The goal changes no gate and " +
			"never bricks a brownfield repo: `interlinked adopt` records today's per-file " +
			"coverage as the floor, every edit must hold-or-raise it, and added lines must be " +
			"covered — so coverage only moves toward the goal. The separate `min_coverage` " +
			"hard floor (default 0 = off) blocks edits below it outright and, once set, may " +
			"only rise.",
		howToConfigure:
			"`interlinked caps set coverage <pct>` (or .interlinked/metric-caps.json → coverage_goal; the hard floor is min_coverage)",
		fixHint:
			"Add tests that execute the added or changed lines before (or alongside) the code change.",
	},
] as const;

/** Look up a metric definition by key. */
export function metricDef(key: MetricKey): MetricDef {
	const def = METRIC_DEFS.find((d) => d.key === key);
	if (!def) throw new Error(`unknown metric key: ${key}`);
	return def;
}

/** Raw parsed shape of metric-caps.json — every field optional + unknown. */
interface RawMetricCaps {
	version?: unknown;
	max_lines?: unknown;
	max_function_tokens?: unknown;
	max_cyclomatic?: unknown;
	max_cognitive?: unknown;
	crap_threshold?: unknown;
	min_coverage?: unknown;
	coverage_goal?: unknown;
}

/** A partial set of overrides parsed from the file (only present, valid keys). */
type MetricCapsOverrides = Partial<MetricCaps>;

interface CacheEntry {
	mtimeMs: number;
	value: MetricCapsOverrides;
}
let overridesCache = new Map<string, CacheEntry>();

function readPositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Goal percentages live on a bounded scale: a goal of 0 is meaningless
 *  ("aiming for nothing") and 100 is the scale's own ceiling — outside 1..100
 *  the entry is invalid and falls back to the default. */
function readGoalPct(value: unknown): number | undefined {
	const n = readPositive(value);
	return n !== undefined && n >= 1 && n <= COVERAGE_SCALE_MAX ? n : undefined;
}

function readFunctionTokenCap(value: unknown): number | undefined {
	const n = readPositive(value);
	if (n === undefined || !Number.isInteger(n)) return undefined;
	return n >= 1 && n <= DEFAULT_MAX_FUNCTION_TOKENS ? n : undefined;
}

/** Parse a raw object into the present, valid overrides only. Caps must be
 *  strictly positive; a coverage floor of 0 is valid (means "no floor"). */
function normalizeOverrides(raw: unknown): MetricCapsOverrides {
	if (typeof raw !== "object" || raw === null) return {};
	const obj = raw as RawMetricCaps;
	const out: MetricCapsOverrides = {};
	const maxLines = readPositive(obj.max_lines);
	if (maxLines !== undefined && maxLines > 0) out.max_lines = maxLines;
	const maxFunctionTokens = readFunctionTokenCap(obj.max_function_tokens);
	if (maxFunctionTokens !== undefined) out.max_function_tokens = maxFunctionTokens;
	const maxCyclomatic = readPositive(obj.max_cyclomatic);
	if (maxCyclomatic !== undefined && maxCyclomatic > 0) out.max_cyclomatic = maxCyclomatic;
	const maxCognitive = readPositive(obj.max_cognitive);
	if (maxCognitive !== undefined && maxCognitive > 0) out.max_cognitive = maxCognitive;
	const crap = readPositive(obj.crap_threshold);
	if (crap !== undefined && crap > 0) out.crap_threshold = crap;
	const minCoverage = readPositive(obj.min_coverage);
	if (minCoverage !== undefined) out.min_coverage = minCoverage;
	const goal = readGoalPct(obj.coverage_goal);
	if (goal !== undefined) out.coverage_goal = goal;
	return out;
}

/**
 * Load `.interlinked/metric-caps.json` overrides for `cwd`. Mtime-aware cache
 * so an `interlinked caps set` (or hand edit) is picked up without a daemon
 * restart, while repeated hot-path calls stay ~free. Fail-soft: a missing or
 * malformed file yields `{}` (all caps fall back to legacy/default).
 */
export function loadMetricCaps(cwd: string): MetricCapsOverrides {
	const path = join(cwd, METRIC_CAPS_REL);
	let mtimeMs = -1;
	try {
		if (existsSync(path)) mtimeMs = statSync(path).mtimeMs;
	} catch {
		mtimeMs = -1; // stat failed → treat as absent
	}
	if (mtimeMs < 0) {
		overridesCache.delete(cwd);
		return {};
	}
	const cached = overridesCache.get(cwd);
	if (cached && cached.mtimeMs === mtimeMs) return cached.value;

	let value: MetricCapsOverrides = {};
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		value = normalizeOverrides(raw);
	} catch {
		value = {}; // malformed JSON → no overrides
	}
	overridesCache.set(cwd, { mtimeMs, value });
	return value;
}

/** Clear the memoized overrides (after writing the file in-process). */
export function resetMetricCapsCache(): void {
	overridesCache = new Map();
}

/** Optional legacy per-metric values a caller already has (e.g. the line
 *  baseline's max_lines, the coverage-gate config's crap_threshold). Layered
 *  BELOW metric-caps.json and ABOVE the shipped defaults. */
interface LegacyCapInputs {
	max_lines?: number | undefined;
	crap_threshold?: number | undefined;
}

const DEFAULTS: MetricCaps = {
	max_lines: DEFAULT_MAX_LINES,
	max_function_tokens: DEFAULT_MAX_FUNCTION_TOKENS,
	max_cyclomatic: DEFAULT_MAX_CYCLOMATIC,
	max_cognitive: DEFAULT_MAX_COGNITIVE_CAP,
	crap_threshold: DEFAULT_CRAP_THRESHOLD,
	min_coverage: DEFAULT_MIN_COVERAGE,
	coverage_goal: DEFAULT_COVERAGE_GOAL,
};

/** A resolved cap value plus where it came from. */
interface ResolvedCap {
	value: number;
source: CapSource;
}

function resolveOne(
	override: number | undefined,
	legacy: number | undefined,
	fallback: number,
): ResolvedCap {
	if (override !== undefined) return { value: override, source: "metric-caps.json" };
	if (legacy !== undefined) return { value: legacy, source: "legacy-config" };
	return { value: fallback, source: "default" };
}

/** Resolve every cap (and the coverage goal) with provenance:
 *  metric-caps.json → legacy → default. */
export function resolveMetricCaps(
	cwd: string,
	legacy: LegacyCapInputs = {},
): Record<keyof MetricCaps, ResolvedCap> {
	const o = loadMetricCaps(cwd);
	return {
		max_lines: resolveOne(o.max_lines, legacy.max_lines, DEFAULTS.max_lines),
		max_function_tokens: resolveOne(
			o.max_function_tokens,
			undefined,
			DEFAULTS.max_function_tokens,
		),
		max_cyclomatic: resolveOne(o.max_cyclomatic, undefined, DEFAULTS.max_cyclomatic),
		max_cognitive: resolveOne(o.max_cognitive, undefined, DEFAULTS.max_cognitive),
		crap_threshold: resolveOne(o.crap_threshold, legacy.crap_threshold, DEFAULTS.crap_threshold),
		min_coverage: resolveOne(o.min_coverage, undefined, DEFAULTS.min_coverage),
		coverage_goal: resolveOne(o.coverage_goal, undefined, DEFAULTS.coverage_goal),
	};
}

/** Effective per-function cyclomatic cap for `cwd` (override else default). */
export function maxCyclomaticFor(cwd: string): number {
	return loadMetricCaps(cwd).max_cyclomatic ?? DEFAULT_MAX_CYCLOMATIC;
}

/** Effective canonical per-function token cap. The absolute ceiling is 500. */
export function maxFunctionTokensFor(cwd: string): number {
	return loadMetricCaps(cwd).max_function_tokens ?? DEFAULT_MAX_FUNCTION_TOKENS;
}

/** Doctor-facing validation for the fixed function-token cap. Ordinary
 * analysis still falls soft to 500; this makes that degradation visible. */
export function functionTokenCapConfigIssue(cwd: string): string | null {
	const path = join(cwd, METRIC_CAPS_REL);
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "metric-caps.json must contain a JSON object";
		}
		// SAFETY: object-ness is checked above; every field remains unknown until
		// the same strict parser used by ordinary analysis validates it.
		const raw = parsed as RawMetricCaps;
		if (raw.max_function_tokens === undefined) return null;
		return readFunctionTokenCap(raw.max_function_tokens) === undefined
			? `max_function_tokens must be an integer from 1 through ${DEFAULT_MAX_FUNCTION_TOKENS}; analysis is using ${DEFAULT_MAX_FUNCTION_TOKENS}`
			: null;
	} catch {
		return `metric-caps.json is malformed; function-token analysis is using ${DEFAULT_MAX_FUNCTION_TOKENS}`;
	}
}

/** Effective per-function cognitive cap for `cwd` (override else default). */
export function maxCognitiveFor(cwd: string): number {
	return loadMetricCaps(cwd).max_cognitive ?? DEFAULT_MAX_COGNITIVE_CAP;
}

/** Effective per-function CRAP cap for `cwd`. `legacy` is the coverage-gate
 *  config's crap_threshold, honored when metric-caps.json doesn't override. */
export function crapThresholdFor(cwd: string, legacy?: number): number {
	return loadMetricCaps(cwd).crap_threshold ?? legacy ?? DEFAULT_CRAP_THRESHOLD;
}

/** Effective coverage floor (percent) for `cwd`. */
export function minCoverageFor(cwd: string): number {
	return loadMetricCaps(cwd).min_coverage ?? DEFAULT_MIN_COVERAGE;
}

/** Effective coverage GOAL (percent) for `cwd` — the display/nudge target;
 *  never consulted by a blocking gate (that is `minCoverageFor` + the
 *  high-water ratchet). */
export function coverageGoalFor(cwd: string): number {
	return loadMetricCaps(cwd).coverage_goal ?? DEFAULT_COVERAGE_GOAL;
}

/** The metric-caps.json `max_lines` override, if any (large-file-policy layers
 *  this over its grandfather baseline). Undefined ⇒ no override. */
export function maxLinesOverride(cwd: string): number | undefined {
	return loadMetricCaps(cwd).max_lines;
}

/**
 * One-line, self-contained explanation appended to a block/warning message so
 * the agent is never confused about what tripped it. Reads METRIC_DEFS, so the
 * wording matches the CLI and the docs exactly.
 */
export function describeMetricForAgent(key: MetricKey, cap: number): string {
	const d = metricDef(key);
	const unit = d.unit ? ` ${d.unit}` : "";
	const dir = d.stricter === "lower" ? "cap" : "floor";
	return (
		`What "${d.key}" means: ${d.definition} ` +
		`Current ${dir}: ${cap}${unit} (${d.stricter} is stricter; configurable — ${d.howToConfigure}). ` +
		`Fix: ${d.fixHint}`
	);
}
