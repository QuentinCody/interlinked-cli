// Effective-value comparison for cap-style water-line fields (red team
// 2026-10-21 round 4; sibling of baseline-integrity-gate.ts, which sits near
// the 500-line cap).
//
// A cap the runtime reads is the FILE value when it is present and valid, else
// the RUNTIME DEFAULT. The old detectors compared only keys present on both
// sides, so `{}` or a dropped `max_cyclomatic` read as "unchanged" while the
// runtime silently fell back to a looser default. Every comparison here goes
// through the consumer's own normalizer and default constants (imported, never
// copied), so the gate and the runtime cannot disagree about what a value
// means: a removed or invalid key whose default is looser is a loosening, and
// a removed key whose default is equal or tighter is not.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { DEFAULT_MAX_LINES, LARGE_FILE_BASELINE_REL, normalizeBaseline as normalizeLargeFiles } from "../large-file-policy.js";
import {
	DEFAULT_CRAP_THRESHOLD,
	DEFAULT_MAX_COGNITIVE_CAP,
	DEFAULT_MAX_CYCLOMATIC,
	DEFAULT_MAX_FUNCTION_TOKENS,
	DEFAULT_MIN_COVERAGE,
	normalizeOverrides,
} from "../metric-caps.js";
import { emptySkippedTestsBaseline, parseSkippedTestsBaseline } from "../skipped-tests-policy.js";
import { DEFAULT_MIN_COVERAGE_PCT, normalizeBaseline as normalizeUntested } from "../tested-file-policy.js";

/** Structurally identical to baseline-integrity-gate's `BaselineGamingFinding`
 *  (the import edge stays one-way: the gate imports this module). */
export interface CapFinding {
	file: string;
	rule: string;
	before: unknown;
	after: unknown;
	message: string;
}

type Doc = Record<string, unknown>;

/** The value a ceiling takes when nothing at runtime enforces it. */
const NO_LIMIT = Number.POSITIVE_INFINITY;

interface CapField {
	key: string;
	/** "ceiling" may only fall; "floor" may only rise. */
	direction: "ceiling" | "floor";
	/** The value the runtime reads from this document, or undefined when it falls back. */
	fileValue: (doc: Doc) => number | undefined;
	/** What the runtime uses when `fileValue` is undefined. */
	fallback: number;
	/** Message prefix (`<label> <key>`) and the policy sentence after the numbers. */
	label: string;
	policy: string;
}

function asDoc(v: unknown): Doc {
	return isJsonObject(v) ? v : {};
}

function show(n: number): string {
	return n === NO_LIMIT ? "no limit" : String(n);
}

/** Why the after-image fell back: the key was removed, or holds a value the runtime rejects. */
function fallbackNote(doc: Doc, field: CapField, effective: number): string {
	const how = field.key in doc ? `set to ${JSON.stringify(doc[field.key])}, which the runtime rejects` : "removed";
	return ` (${field.key} ${how}; the runtime then uses ${show(effective)})`;
}

function compareField(file: string, field: CapField, before: Doc, after: Doc): CapFinding | null {
	const afterFile = field.fileValue(after);
	const bv = field.fileValue(before) ?? field.fallback;
	const av = afterFile ?? field.fallback;
	const looser = field.direction === "ceiling" ? av > bv : av < bv;
	if (!looser) return null;
	const verb = field.direction === "ceiling" ? "raised" : "lowered";
	const note = afterFile === undefined ? fallbackNote(after, field, av) : "";
	return {
		file,
		rule: field.key,
		before: bv === NO_LIMIT ? undefined : bv,
		after: av === NO_LIMIT ? undefined : av,
		message: `${field.label} ${field.key} ${verb} ${show(bv)}→${show(av)}${note}. ${field.policy}`,
	};
}

function compareFields(file: string, fields: readonly CapField[], before: unknown, after: unknown): CapFinding[] {
	const b = asDoc(before);
	const a = asDoc(after);
	return fields.flatMap((f) => compareField(file, f, b, a) ?? []);
}

// ---- where a water-line's repository root is ------------------------------

/** Repository root of a `.interlinked/` water-line path; `fallbackRoot`
 *  anchors a root-relative path (the effect arm passes `.interlinked/<file>`). */
export function waterLineRoot(filePath: string, fallbackRoot?: string): string | null {
	const norm = filePath.replace(/\\/g, "/");
	const at = norm.startsWith(".interlinked/") ? 0 : norm.lastIndexOf("/.interlinked/");
	if (at < 0) return null;
	const prefix = norm.slice(0, at);
	if (prefix === "") return norm.startsWith("/") ? "/" : (fallbackRoot ?? null);
	if (isAbsolute(prefix)) return prefix;
	return fallbackRoot ? join(fallbackRoot, prefix) : null;
}

/** The line cap the runtime uses when metric-caps.json sets none: the
 *  large-files baseline's cap, else the shipped default (`maxLinesFor`). Read
 *  fresh, never from the runtime's process-lifetime cache. */
export function legacyLineCap(root: string | null): number {
	if (root === null) return DEFAULT_MAX_LINES;
	const path = join(root, LARGE_FILE_BASELINE_REL);
	try {
		if (!existsSync(path)) return DEFAULT_MAX_LINES;
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return normalizeLargeFiles(raw)?.max_lines ?? DEFAULT_MAX_LINES;
	} catch {
		return DEFAULT_MAX_LINES;
	}
}

// ---- metric-caps.json -----------------------------------------------------

const CAPS_POLICY = "Caps may only tighten.";

type OverrideCap = "max_lines" | "max_function_tokens" | "max_cyclomatic" | "max_cognitive" | "crap_threshold";

function capField(key: OverrideCap, fallback: number): CapField {
	return { key, direction: "ceiling", fileValue: (d) => normalizeOverrides(d)[key], fallback, label: "metric-caps", policy: CAPS_POLICY };
}

function finiteOrUndefined(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// `coverage_goal` is deliberately NOT direction-locked (2026-08-17): it is a
// display/nudge TARGET, not a gate input, so moving it gains an agent nothing.
function metricCapFields(lineFallback: number): CapField[] {
	return [
		capField("max_lines", lineFallback),
		capField("max_function_tokens", DEFAULT_MAX_FUNCTION_TOKENS),
		capField("max_cyclomatic", DEFAULT_MAX_CYCLOMATIC),
		capField("max_cognitive", DEFAULT_MAX_COGNITIVE_CAP),
		// The CRAP legacy layer (the coverage-gate config's crap_threshold) ships
		// at the same default; a looser local config lives outside this file.
		capField("crap_threshold", DEFAULT_CRAP_THRESHOLD),
		// `max_predicate_drift` is a repo-wide COUNT water-line with no runtime
		// default: a removed or non-numeric value leaves no limit at all.
		{
			key: "max_predicate_drift",
			direction: "ceiling",
			fileValue: (d) => finiteOrUndefined(d.max_predicate_drift),
			fallback: NO_LIMIT,
			label: "metric-caps",
			policy: CAPS_POLICY,
		},
		{
			key: "min_coverage",
			direction: "floor",
			fileValue: (d) => normalizeOverrides(d).min_coverage,
			fallback: DEFAULT_MIN_COVERAGE,
			label: "metric-caps",
			policy: "The coverage floor may only rise.",
		},
	];
}

/** metric-caps.json: every cap compared by the value the runtime would use.
 *  `lineFallback` is what `max_lines` falls back to (see `legacyLineCap`). */
export function detectMetricCaps(file: string, before: unknown, after: unknown, lineFallback: number): CapFinding[] {
	return compareFields(file, metricCapFields(lineFallback), before, after);
}

// ---- large-files / untested-files / skipped-tests --------------------------

const LARGE_FILES_CAP: CapField = {
	key: "max_lines",
	direction: "ceiling",
	fileValue: (d) => normalizeLargeFiles(d)?.max_lines,
	fallback: DEFAULT_MAX_LINES,
	label: "large-files",
	policy: "The line cap may only tighten.",
};

/** The large-files cap the runtime reads from this document. */
export function effectiveLargeFilesCap(doc: unknown): number {
	return LARGE_FILES_CAP.fileValue(asDoc(doc)) ?? LARGE_FILES_CAP.fallback;
}

export function detectLargeFilesCap(file: string, before: unknown, after: unknown): CapFinding[] {
	return compareFields(file, [LARGE_FILES_CAP], before, after);
}

const UNTESTED_FLOOR: CapField = {
	key: "min_coverage_pct",
	direction: "floor",
	fileValue: (d) => normalizeUntested(d)?.min_coverage_pct,
	fallback: DEFAULT_MIN_COVERAGE_PCT,
	label: "untested-files",
	policy: "The coverage floor may only rise.",
};

export function detectUntestedFloor(file: string, before: unknown, after: unknown): CapFinding[] {
	return compareFields(file, [UNTESTED_FLOOR], before, after);
}

// The cap is judged as a FIELD: a wrong `version` resets the whole document to
// the empty baseline (cap 0, no grandfathers), which is never looser, so it
// must not hide a raised `max_skipped` that a later version fix would enforce.
const SKIPPED_CAP: CapField = {
	key: "max_skipped",
	direction: "ceiling",
	fileValue: (d) => parseSkippedTestsBaseline({ ...d, version: 1 })?.max_skipped,
	fallback: emptySkippedTestsBaseline().max_skipped,
	label: "skipped-tests",
	policy: "The skip cap may only tighten — fix or delete the skipped test instead.",
};

/** The skip cap the runtime reads from this document. */
export function effectiveSkipCap(doc: unknown): number {
	return SKIPPED_CAP.fileValue(asDoc(doc)) ?? SKIPPED_CAP.fallback;
}

export function detectSkippedCap(file: string, before: unknown, after: unknown): CapFinding[] {
	return compareFields(file, [SKIPPED_CAP], before, after);
}
