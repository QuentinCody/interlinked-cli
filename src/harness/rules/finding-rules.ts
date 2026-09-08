// ===========================================
// Rules — Findings-distilled Rules (4th loader layer)
// ===========================================
// Loads rules distilled from corpus Findings by the `finding-distill` skill.
// A SEPARATE file from `/enforce`'s distilled-rules.json on purpose: a bare
// `/enforce` run fully regenerates its pristine file (keyed on source-file
// hashes), so co-tenanting finding rules there would silently delete them.
//
//   .interlinked/findings-rules.json           — pristine (skill-written)
//   .interlinked/findings-rules.overrides.json — user mods (survive re-distill)
//
// Same runtime layer / ReDoS gate / hot-reload as distilled-rules. The `source`
// sidecar (finding_id back-link, provenance) is metadata the harness IGNORES at
// evaluation — the CLI + recurrence use it. Fail-open on any parse error: rule
// loading must never block the daemon (feedback_safety_continuity).
//
// loadFindingRules returns only the ACTIVE set (drops disabled rules), so the
// rules-loader can spread it directly without re-filtering.

import { join } from "node:path";
import { readJsonObject } from "../../lib/json-file.js";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { looksLikeReDoS } from "../redos-validation.js";
import type { GuardRule } from "../types.js";
import { parseRuleModifications, parseRuntimeRule, stringList, type RuleModification } from "./parsed-rule.js";

/** Provenance sidecar emitted by the `finding-distill` skill. Ignored at eval. */
export interface FindingRuleSource {
	kind: "finding";
	bug_class: string;
	[key: string]: unknown;
	repo?: string;
	commit?: string;
	file?: string;
	lines?: [number, number];
	reviewer?: string;
	quote?: string;
}

export interface FindingRule extends GuardRule {
	source?: FindingRuleSource;
	distilled_action_reason?: string;
	confidence?: number;
	user_modified?: boolean;
}

interface FindingRulesFile {
	version?: number;
	// Raw parsed JSON, not yet validated — a hand-edited or LLM-authored
	// findings-rules.json can carry any shape here, so this stays `unknown[]`
	// rather than `FindingRule[]` (an honest boundary type, not a lie the
	// no-unnecessary-condition checks below would then have to work around).
	rules?: unknown[];
}

export function findingRulesPath(cwd: string): string {
	return join(cwd, ".interlinked", "findings-rules.json");
}

function findingRulesOverridesPath(cwd: string): string {
	return join(cwd, ".interlinked", "findings-rules.overrides.json");
}

// `rawSource` is unvalidated JSON — the raw file may have any `kind`, or not
// even be an object — so this is honestly `unknown`, not `FindingRuleSource`.
function normalizeFindingRuleSource(rawSource: unknown): FindingRuleSource | undefined {
	if (!isJsonObject(rawSource)) return undefined;
	const source = rawSource;
	if (source.kind !== "finding" || typeof source.bug_class !== "string") return undefined;
	const normalized: FindingRuleSource = {
		kind: "finding",
		bug_class: source.bug_class,
	};
	copyStringSourceField(source, normalized, "finding_id");
	if (typeof source.repo === "string") normalized.repo = source.repo;
	if (typeof source.commit === "string") normalized.commit = source.commit;
	if (typeof source.file === "string") normalized.file = source.file;
	if (Array.isArray(source.lines) && source.lines.length === 2) {
		const [start, end] = source.lines;
		if (typeof start === "number" && typeof end === "number") normalized.lines = [start, end];
	}
	if (typeof source.reviewer === "string") normalized.reviewer = source.reviewer;
	copyStringSourceField(source, normalized, "found_at");
	if (typeof source.quote === "string") normalized.quote = source.quote;
	return normalized;
}

function copyStringSourceField(
	source: JsonObject,
	target: FindingRuleSource,
	key: string,
): void {
	const value = source[key];
	if (typeof value === "string") target[key] = value;
}

/**
 * Apply a user override's action/severity to a rule and mark it modified.
 * No-op when there is no override for this rule id — the caller passes
 * `mods[raw.id]` (possibly `undefined`) straight through.
 */
function applyRuleModification(rule: FindingRule, mod: RuleModification | undefined): void {
	if (!mod) return;
	if (mod.action !== undefined) rule.action = mod.action;
	if (mod.severity !== undefined) rule.severity = mod.severity;
	rule.user_modified = true;
}

/**
 * Public API — consumed by `rules-loader.ts` via `loadRules()`. Reads the
 * pristine file, applies overrides, drops ReDoS-prone AND disabled rules, and
 * returns the active GuardRules. Mirrors `loadDistilledRules` minus the group
 * concept (findings have no source-file groups).
 */
export function loadFindingRules(cwd: string): GuardRule[] {
	const file: FindingRulesFile | null = readJsonObject(findingRulesPath(cwd));
	if (!file?.rules || !Array.isArray(file.rules)) return [];

	const overrides = readJsonObject(findingRulesOverridesPath(cwd)) ?? {};
	const overrideState: FindingRuleOverrideState = {
		removed: new Set(stringList(overrides.removed_rule_ids)),
		disabled: new Set(stringList(overrides.disabled_rule_ids)),
		mods: parseRuleModifications(overrides.modifications),
	};

	const out: GuardRule[] = [];
	for (const entry of file.rules) {
		const rule = resolveActiveFindingRule(entry, overrideState);
		if (rule) out.push(rule); // return only the active set
	}
	return out;
}

interface FindingRuleOverrideState {
	removed: Set<string>;
	disabled: Set<string>;
	mods: Record<string, RuleModification>;
}

/**
 * Validate, build, and apply overrides to one raw findings-rules.json entry.
 * Returns `null` for anything that should be dropped (malformed shape,
 * explicitly removed, ReDoS-prone, or disabled) — the caller only pushes a
 * non-null result, so this is the whole per-entry decision in one place.
 */
function resolveActiveFindingRule(entry: unknown, overrides: FindingRuleOverrideState): FindingRule | null {
	const raw = parseRuntimeRule(entry);
	if (!raw) return null;
	const id = raw.id;
	if (overrides.removed.has(id)) return null;

	// ReDoS gate — a finding rule's regex is LLM-authored from arbitrary
	// review prose; a nested-quantifier shape would hang the daemon. Same
	// guard as distilled rules. Skip the whole rule + one stderr line.
	const patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
	const unsafeRegex = findUnsafePatternRegex(patterns);
	if (unsafeRegex !== undefined) {
		process.stderr.write(`[interlinked] skipping finding rule ${id}: ReDoS-prone pattern ${unsafeRegex.slice(0, 120)}\n`);
		return null;
	}

	const rule = normalizeFindingMetadata(raw);
	applyRuleModification(rule, overrides.mods[id]);
	rule.enabled = overrides.disabled.has(id) ? false : raw.enabled !== false;
	return rule.enabled ? rule : null;
}

function normalizeFindingMetadata(raw: GuardRule & JsonObject): FindingRule {
	const { source: rawSource, distilled_action_reason, confidence, user_modified, ...runtimeRule } = raw;
	const rule: FindingRule = { ...runtimeRule };
	if (typeof distilled_action_reason === "string") rule.distilled_action_reason = distilled_action_reason;
	if (typeof confidence === "number" && Number.isFinite(confidence)) rule.confidence = confidence;
	if (typeof user_modified === "boolean") rule.user_modified = user_modified;
	const source = normalizeFindingRuleSource(rawSource);
	if (source) rule.source = source;
	return rule;
}

/**
 * First ReDoS-prone `regex` field found among unvalidated pattern entries, or
 * `undefined` if none. Entries are raw JSON — each `p` may not even be an
 * object — so every access here is a real (not type-proven) narrowing.
 */
function findUnsafePatternRegex(patterns: unknown[]): string | undefined {
	for (const p of patterns) {
		if (!isJsonObject(p)) continue;
		const regex = p.regex;
		if (typeof regex === "string" && looksLikeReDoS(regex)) return regex;
	}
	return undefined;
}

/** Public API — paths watched by `watchRulesFiles()` so changes hot-reload. */
export function getFindingRulesWatchPaths(cwd: string): string[] {
	return [findingRulesPath(cwd), findingRulesOverridesPath(cwd)];
}
