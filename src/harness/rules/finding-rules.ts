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
import { looksLikeReDoS } from "../redos-validation.js";
import type { GuardRule } from "../types.js";

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

interface RuleModification {
	action?: GuardRule["action"];
	severity?: GuardRule["severity"];
	note?: string;
}

interface FindingRulesOverrides {
	version?: number;
	removed_rule_ids?: string[];
	disabled_rule_ids?: string[];
	modifications?: Record<string, RuleModification>;
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
	if (!rawSource || typeof rawSource !== "object") return undefined;
	const source = rawSource as Partial<FindingRuleSource>;
	if (source.kind !== "finding" || typeof source.bug_class !== "string") return undefined;
	const normalized: FindingRuleSource = {
		kind: "finding",
		bug_class: source.bug_class,
	};
	copyStringSourceField(source, normalized, "finding_id");
	if (source.repo !== undefined) normalized.repo = source.repo;
	if (source.commit !== undefined) normalized.commit = source.commit;
	if (source.file !== undefined) normalized.file = source.file;
	if (source.lines !== undefined) normalized.lines = source.lines;
	if (source.reviewer !== undefined) normalized.reviewer = source.reviewer;
	copyStringSourceField(source, normalized, "found_at");
	if (source.quote !== undefined) normalized.quote = source.quote;
	return normalized;
}

function copyStringSourceField(
	source: Partial<FindingRuleSource>,
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
	const file = readJsonObject(findingRulesPath(cwd)) as FindingRulesFile | null;
	if (!file?.rules || !Array.isArray(file.rules)) return [];

	const overrides = (readJsonObject(findingRulesOverridesPath(cwd)) ?? {}) as FindingRulesOverrides;
	const removed = new Set(overrides.removed_rule_ids ?? []);
	const disabled = new Set(overrides.disabled_rule_ids ?? []);
	const mods = overrides.modifications ?? {};

	const out: GuardRule[] = [];
	for (const entry of file.rules) {
		if (!entry || typeof entry !== "object") continue;
		// `entry` is unvalidated JSON at this point; `id` is the one field we
		// must confirm before trusting the rest of the shape below.
		const raw = entry as Record<string, unknown>;
		if (typeof raw.id !== "string" || !raw.id) continue;
		const id = raw.id;
		if (removed.has(id)) continue;

		// ReDoS gate — a finding rule's regex is LLM-authored from arbitrary
		// review prose; a nested-quantifier shape would hang the daemon. Same
		// guard as distilled rules. Skip the whole rule + one stderr line.
		const patterns = Array.isArray(raw.patterns) ? raw.patterns : [];
		const unsafeRegex = findUnsafePatternRegex(patterns);
		if (unsafeRegex !== undefined) {
			process.stderr.write(`[interlinked] skipping finding rule ${id}: ReDoS-prone pattern ${unsafeRegex.slice(0, 120)}\n`);
			continue;
		}

		const rule: FindingRule = { ...(raw as unknown as FindingRule), id };
		const source = normalizeFindingRuleSource(raw.source);
		delete rule.source;
		if (source) rule.source = source;
		applyRuleModification(rule, mods[id]);
		rule.enabled = disabled.has(id) ? false : raw.enabled !== false;
		if (rule.enabled) out.push(rule); // return only the active set
	}
	return out;
}

/**
 * First ReDoS-prone `regex` field found among unvalidated pattern entries, or
 * `undefined` if none. Entries are raw JSON — each `p` may not even be an
 * object — so every access here is a real (not type-proven) narrowing.
 */
function findUnsafePatternRegex(patterns: unknown[]): string | undefined {
	for (const p of patterns) {
		if (!p || typeof p !== "object") continue;
		const regex = (p as Record<string, unknown>).regex;
		if (typeof regex === "string" && looksLikeReDoS(regex)) return regex;
	}
	return undefined;
}

/** Public API — paths watched by `watchRulesFiles()` so changes hot-reload. */
export function getFindingRulesWatchPaths(cwd: string): string[] {
	return [findingRulesPath(cwd), findingRulesOverridesPath(cwd)];
}
