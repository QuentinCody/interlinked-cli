// ===========================================
// Generic PreToolUse gate — per-function metric cap (strict, no override)
// ===========================================
// The shared engine behind the two per-function metric gates:
// `checkFunctionComplexityWrite` (cyclomatic, complexity-write-guard.ts) and
// `checkCognitiveComplexityWrite` (cognitive, cognitive-write-guard.ts). Both
// were hand-mirrored copies of the same seven helpers differing only in which
// metric field they read; this module is that mirror collapsed into one
// parameterized implementation so the two gates can no longer drift.
//
// DELTA semantics, mirroring the line-cap gate: an edit that holds or reduces an
// already-over-cap function is always allowed — the refactor-down path — so the
// on-disk before-state is the implicit ratchet baseline. Only a NEW over-cap
// function, RAISING an existing function past the cap, or a sub-cap rise larger
// than the metric's per-edit slew tolerance is blocked.
//
// There is deliberately NO escape hatch / suppression: an agent-writable
// override gets gamed, which defeats the gate. The only way past is to
// decompose (or, for cognitive, to flatten).
//
// Everything a metric may differ in is a field on `MetricGateSpec`: the entry
// type and its value accessor, the analyzer dispatch (cyclomatic dispatches
// Python to radon; cognitive is JS/TS only), the loud-degrade callback, the cap
// resolver, the per-edit slew tolerance (cyclomatic 2, cognitive 4), and every
// word of the block message including the metric-specific advice.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import { extractApplyPatchRaw, looksLikeApplyPatch, parseApplyPatchSections } from "../apply-patch-content.js";
import { appendPlanHints, type PlanHintFn } from "./metric-gate-plan-hints.js";
import { type FileGrandfather, ledgerOverCapViolation } from "../function-complexity-baseline.js";
import { ledgerBlockLines } from "./metric-gate-ledger-line.js";
import { isCappableFile } from "../large-file-policy.js";
import { processApplyPatchSection } from "./apply-patch-section-metric.js";
import { safeReadFile } from "./safe-read-file.js";

/** The only structural requirement on a metric's per-function entry: a name.
 *  The numeric value is read through the spec's `metricOf`, so an entry may
 *  carry the metric under any field name. */
export interface NamedMetricEntry {
	name: string;
}

/** A per-function metric counter for ONE language. Returns `null` — the loud
 *  "analyzer unavailable" signal — when the backing parser is absent, which the
 *  caller fails open on. `language` only tags the degrade callback. */
export interface MetricAnalyzer<E extends NamedMetricEntry> {
	compute: (content: string, filePath: string) => E[] | null;
	language: string;
}

/**
 * Telemetry observer — receives the before/after entries the gate already
 * parsed for every analyzed file, plus the projected after-content (for
 * content-hash matching at PostToolUse). Observation only: it never affects the
 * block decision. Used by the cyclomatic pulse (complexity-pulse.ts); the
 * cognitive gate passes no observer.
 */
export type MetricObserver<E extends NamedMetricEntry> = (
	filePath: string,
	beforeFns: E[],
	afterFns: E[],
	afterContent: string,
) => void;

/** Everything one per-function metric gate differs in. */
export interface MetricGateSpec<E extends NamedMetricEntry> {
	/** Metric id — the `[interlinked:<label>]` tag, the `caps set <label>`
	 *  subject, and the word inside each violation string. */
	label: string;
	/** Entry name used by the analyzer for anonymous units (no cross-edit identity). */
	anonName: string;
	/** Max per-edit rise allowed for a uniquely-named function at/under the cap.
	 *  `null` means the metric has only an end-state cap and over-cap shrink rule. */
	slewTolerance: number | null;
	/** Read the metric value off one entry. */
	metricOf: (entry: E) => number;
	/** Pick the analyzer for a path, or null to skip the file entirely. */
	selectAnalyzer: (filePath: string) => MetricAnalyzer<E> | null;
	/** Resolve the hard cap for this repo (`.interlinked/metric-caps.json`). */
	capFor: (cwd: string) => number;
	/** Called (fail-open) when the analyzer for `language` is unavailable. */
	onAnalyzerUnavailable?: (language: string) => void;
	/** The grandfather ledger's view of `filePath` (function-complexity-baseline.ts),
	 *  or null for legacy delta semantics. When present it is AUTHORITATIVE over
	 *  the cap band: a listed function may hold/shrink at its recorded value; an
	 *  unlisted over-cap function blocks even when merely held. */
	grandfatherFor?: (cwd: string, filePath: string) => FileGrandfather | null;
	/** Message: the noun phrase after "past a" (e.g. "cyclomatic limit"). */
	limitPhrase: string;
	/** Message: plural unit for the slew allowance (e.g. "branch(es)"). */
	unitPlural: string;
	/** Message: adjectival unit for the cap (e.g. "branch" → "25-branch cap"). */
	unitAdj: string;
	/** Message: the metric-specific remediation sentence(s). */
	advice: string;
	/** Optional per-function decomposition planner; its sentence is appended as a
	 *  `↳ plan:` sub-line under the violation naming that function. */
	planFor?: PlanHintFn;
}

export interface MetricWriteBlock {
	block: string;
}

/** One file-path resolution rule for every per-function metric gate — no drift
 *  between them about which key carries the target path. */
export function resolveFilePath(toolInput: JsonObject): string {
	return (
		(typeof toolInput.file_path === "string" && toolInput.file_path) ||
		(typeof toolInput.path === "string" && toolInput.path) ||
		""
	);
}

/** Apply one old→new replacement (first occurrence, or all when replace_all). */
function applyEdit(text: string, oldStr: string, newStr: string, all: boolean): string {
	if (all) return text.split(oldStr).join(newStr);
	const idx = text.indexOf(oldStr);
	return idx === -1 ? text : text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
}

/** Apply a MultiEdit `edits` array in order, skipping any entry that is not a
 *  well-formed `{ old_string, new_string }` pair. */
function applyEditList(text: string, edits: readonly unknown[]): string {
	let after = text;
	for (const raw of edits) {
		if (typeof raw !== "object" || raw === null) continue;
		const e = raw as JsonObject;
		if (typeof e.old_string !== "string" || typeof e.new_string !== "string") continue;
		after = applyEdit(after, e.old_string, e.new_string, e.replace_all === true);
	}
	return after;
}

/** Materialize before/after content for a Write/Edit/MultiEdit, else null. One
 *  edit-application rule for every per-function metric gate. */
export function projectContent(
	toolInput: JsonObject,
	abs: string,
): { before: string; after: string } | null {
	const before = existsSync(abs) ? safeReadFile(abs) : "";
	if (before === null) return null;

	if (typeof toolInput.content === "string") {
		return { before, after: toolInput.content };
	}
	if (typeof toolInput.old_string === "string" && typeof toolInput.new_string === "string") {
		if (before === "") return null; // Edit needs an existing file
		const all = toolInput.replace_all === true;
		return { before, after: applyEdit(before, toolInput.old_string, toolInput.new_string, all) };
	}
	if (Array.isArray(toolInput.edits)) {
		if (before === "") return null;
		return { before, after: applyEditList(before, toolInput.edits) };
	}
	return null; // unknown shape — fail open (apply_patch is handled separately)
}

/** Count of entries per name within ONE state, used to tell a uniquely-named
 *  function from a same-file name collision. */
function countByName(entries: readonly NamedMetricEntry[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of entries) m.set(e.name, (m.get(e.name) ?? 0) + 1);
	return m;
}

/** True when `name` has no reliable cross-edit identity in that state:
 *  anonymous, or colliding with another same-named function. */
function isAmbiguousName(anonName: string, name: string, counts: Map<string, number>): boolean {
	return name === anonName || (counts.get(name) ?? 0) > 1;
}

/** name → max metric value among same-named entries (anonymous skipped). */
function maxByName<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	entries: readonly E[],
): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of entries) {
		if (e.name === spec.anonName) continue;
		m.set(e.name, Math.max(m.get(e.name) ?? 0, spec.metricOf(e)));
	}
	return m;
}

/** Map of UNIQUELY-named entries (name appears exactly once) → metric value.
 *  Collisions and anonymous entries are excluded — no cross-edit identity. */
function uniqueByName<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	entries: readonly E[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const e of entries) {
		if (e.name === spec.anonName) continue;
		counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
	}
	const out = new Map<string, number>();
	for (const e of entries) {
		if (e.name !== spec.anonName && counts.get(e.name) === 1) out.set(e.name, spec.metricOf(e));
	}
	return out;
}

/** Violation text for ONE uniquely-named over-cap entry, or null when allowed.
 *  Ledger mode delegates to the ledger's rule; legacy mode is the on-disk delta. */
function overCapText<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	entry: E,
	prior: number | undefined,
	gf: FileGrandfather | null,
): string | null {
	const value = spec.metricOf(entry);
	if (gf) return ledgerOverCapViolation(spec.label, entry.name, value, prior, gf);
	if (prior !== undefined && value <= prior) return null; // held or reduced
	const how = prior !== undefined ? `raised from ${prior}` : "new over-cap function";
	return `${entry.name} (${spec.label} ${value}, ${how})`;
}

/** (1a) Identity-based over-cap violations: a uniquely-named over-cap entry is
 *  compared against ITS OWN prior value (and, in ledger mode, its grandfathered
 *  value), or against the cap when the name is brand new. Never against another
 *  entry's rank. This is what catches a decomposition that RELOCATES the excess
 *  into a new, still-over-cap helper. */
function identityOverCapViolations<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	afterOver: readonly E[],
	afterNameCounts: Map<string, number>,
	beforeByName: Map<string, number>,
	gf: FileGrandfather | null,
): string[] {
	const out: string[] = [];
	for (const e of afterOver) {
		if (isAmbiguousName(spec.anonName, e.name, afterNameCounts)) continue;
		const text = overCapText(spec, e, beforeByName.get(e.name), gf);
		if (text) out.push(text);
	}
	return out;
}

/** Rank-i ceiling for the pooled band: the before-state rank (or the cap),
 *  further bounded by the ledger's same rank in ledger mode. */
function pooledCeiling(
	beforeVal: number | undefined,
	gf: FileGrandfather | null,
	rank: number,
	cap: number,
): number {
	const fromBefore = beforeVal ?? cap;
	return gf ? Math.min(fromBefore, gf.pooled[rank] ?? cap) : fromBefore;
}

/** (1b) Pooled sorted-multiset comparison, scoped to AMBIGUOUS (anonymous /
 *  collision-named) entries only — names genuinely cannot be trusted there, so
 *  the identity-free rank comparison still owns that subset. */
function pooledAmbiguousOverCapViolations<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	afterOver: readonly E[],
	beforeEntries: readonly E[],
	afterNameCounts: Map<string, number>,
	beforeNameCounts: Map<string, number>,
	cap: number,
	gf: FileGrandfather | null,
): string[] {
	const afterAmbiguous = afterOver
		.filter((e) => isAmbiguousName(spec.anonName, e.name, afterNameCounts))
		.sort((a, b) => spec.metricOf(b) - spec.metricOf(a));
	if (afterAmbiguous.length === 0) return [];

	const beforeVals = beforeEntries
		.filter(
			(e) =>
				spec.metricOf(e) > cap && isAmbiguousName(spec.anonName, e.name, beforeNameCounts),
		)
		.map((e) => spec.metricOf(e))
		.sort((a, b) => b - a);

	const out: string[] = [];
	for (let i = 0; i < afterAmbiguous.length; i++) {
		const post = nonNull(afterAmbiguous[i]);
		const baseline = pooledCeiling(beforeVals[i], gf, i, cap);
		const value = spec.metricOf(post);
		if (value <= baseline) continue; // this rank held or reduced
		const how =
			post.name === spec.anonName ? "new anonymous function over cap" : "new over-cap function";
		out.push(`${post.name} (${spec.label} ${value}, ${how})`);
	}
	return out;
}

/** (2) Over-tolerance sub-cap rises of uniquely-named entries vs the
 *  before-state. `<= cap` band only — a rise that lands over the cap is owned
 *  by the over-cap path, not double-reported. */
function subCapSlewViolations<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	beforeEntries: readonly E[],
	afterEntries: readonly E[],
	cap: number,
): string[] {
	if (spec.slewTolerance === null) return [];
	const before = uniqueByName(spec, beforeEntries);
	const out: string[] = [];
	for (const [name, post] of uniqueByName(spec, afterEntries)) {
		const pre = before.get(name);
		if (pre !== undefined && post <= cap && post - pre > spec.slewTolerance) {
			out.push(
				`${name} (${spec.label} ${pre} -> ${post} — rose ${post - pre} in one edit, ` +
					`over the +${spec.slewTolerance}/edit sub-cap limit)`,
			);
		}
	}
	return out.sort();
}

/**
 * Metric violations for ONE file's before→after content. Returns an array of
 * human-readable violation strings (empty = no violation), or `null` when the
 * analyzer is unavailable → caller fails open.
 *
 * The over-cap band is a HYBRID of identity-based and identity-free comparison.
 * Pure rank comparison misses relocation (shrink the target, spawn an over-cap
 * helper: the sorted profile improves at every rank). Pure name comparison
 * misses shuffles between same-named functions and new anonymous callbacks. So
 * uniquely-named entries compare by identity (1a) and ambiguous ones pool by
 * rank (1b).
 */
export function metricViolations<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	before: string,
	after: string,
	filePath: string,
	analyzer: MetricAnalyzer<E>,
	cap: number,
	observe?: MetricObserver<E>,
	gf: FileGrandfather | null = null,
): string[] | null {
	const afterEntries = analyzer.compute(after, filePath);
	if (!afterEntries) {
		// Analyzer unavailable → fail open (no FP-blocking), but let the spec
		// surface the degrade so it is never silent.
		spec.onAnalyzerUnavailable?.(analyzer.language);
		return null;
	}
	const beforeEntries = analyzer.compute(before, filePath) ?? [];
	// Hand the already-paid parses to the telemetry observer (decision unaffected).
	observe?.(filePath, beforeEntries, afterEntries, after);

	const violations: string[] = [];
	const afterOver = afterEntries.filter((e) => spec.metricOf(e) > cap);
	if (afterOver.length > 0) {
		const afterNameCounts = countByName(afterEntries);
		violations.push(
			...identityOverCapViolations(
				spec,
				afterOver,
				afterNameCounts,
				maxByName(spec, beforeEntries),
				gf,
			),
		);
		violations.push(
			...pooledAmbiguousOverCapViolations(
				spec,
				afterOver,
				beforeEntries,
				afterNameCounts,
				countByName(beforeEntries),
				cap,
				gf,
			),
		);
	}
	violations.push(...subCapSlewViolations(spec, beforeEntries, afterEntries, cap));
	if (!spec.planFor) return violations;
	return appendPlanHints(violations, afterOver, spec.anonName, spec.planFor, after, filePath, cap);
}

/** The shared block payload for a set of violation strings. */
export function buildMetricBlock<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	violations: string[],
	cap: number,
	gf: FileGrandfather | null = null,
): string {
	const ledgerLine = ledgerBlockLines(spec.label, gf, cap);
	const policy = spec.slewTolerance === null
		? `no function may exceed the ${cap}-${spec.unitAdj} cap`
		: `a function may rise by at most ${spec.slewTolerance} ${spec.unitPlural} ` +
			`per edit, and no function may exceed the ${cap}-${spec.unitAdj} cap`;
	return (
		`[interlinked:${spec.label}] BLOCKED: this edit pushes ${violations.length} function(s) past a ` +
		`${spec.limitPhrase} — ${policy}:\n` +
		`${violations.map((v) => `  • ${v}`).join("\n")}\n` +
		`${spec.advice} Holding or reducing an existing function is always allowed; ` +
		"there is no suppression.\n" +
		`This ${cap}-${spec.unitAdj} cap is per-repo configurable: \`interlinked caps set ${spec.label} <n>\` ` +
		`(run \`interlinked caps explain ${spec.label}\` for what ${spec.label} complexity measures).` +
		ledgerLine
	);
}

/**
 * apply_patch path: reconstruct each section's post-edit content and run the
 * same comparison per file. Fails open per-file when the applier can't
 * confidently reconstruct (so a misparse never false-blocks), and entirely when
 * the analyzer is unavailable.
 */
function checkApplyPatch<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	toolInput: JsonObject,
	cwd: string,
	observe?: MetricObserver<E>,
): MetricWriteBlock | null {
	const raw = extractApplyPatchRaw(toolInput);
	if (!raw || !looksLikeApplyPatch(raw)) return null;

	const violations: string[] = [];
	const cap = spec.capFor(cwd);
	let lastGf: FileGrandfather | null = null;
	for (const section of parseApplyPatchSections(raw)) {
		const outcome = processApplyPatchSection(spec, section, cwd, cap, observe, metricViolations);
		if (outcome === "fail-open") return null; // analyzer unavailable → fail open entirely
		if (outcome === "skip") continue;
		for (const item of outcome.items) violations.push(`${section.path}: ${item}`);
		if (outcome.items.length > 0) lastGf = outcome.gf;
	}
	if (violations.length === 0) return null;
	return { block: buildMetricBlock(spec, violations, cap, lastGf) };
}

/**
 * Block a Write/Edit/MultiEdit/apply_patch that introduces or worsens an
 * over-cap function under `spec`'s metric. Returns null (allow) for unanalyzable
 * extensions, exempt files, missing analyzer support, or when the edit only
 * holds/reduces the metric.
 */
export function checkPerFunctionMetricWrite<E extends NamedMetricEntry>(
	spec: MetricGateSpec<E>,
	toolInput: JsonObject,
	cwd: string,
	observe?: MetricObserver<E>,
): MetricWriteBlock | null {
	const filePath = resolveFilePath(toolInput);
	if (filePath) {
		const analyzer = spec.selectAnalyzer(filePath);
		if (!analyzer) return null; // extension the metric can't analyze → skip
		const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
		const projected = projectContent(toolInput, abs);
		if (!projected) return null;
		if (!isCappableFile({ filePath, content: projected.after, root: cwd })) return null;
		const cap = spec.capFor(cwd);
		const gf = spec.grandfatherFor?.(cwd, filePath) ?? null;
		const violations = metricViolations(
			spec,
			projected.before,
			projected.after,
			filePath,
			analyzer,
			cap,
			observe,
			gf,
		);
		if (violations === null || violations.length === 0) return null;
		return { block: buildMetricBlock(spec, violations, cap, gf) };
	}
	// No explicit file_path → may be an apply_patch payload (multi-file).
	return checkApplyPatch(spec, toolInput, cwd, observe);
}
