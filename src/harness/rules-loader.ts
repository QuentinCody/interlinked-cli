// ===========================================
// Rules Loader — Load, merge, and watch guard rules
// ===========================================
// This is the public entry point for the rules system. Implementation
// is split across `src/harness/rules/*.ts` to keep each file focused and
// under the file-size threshold:
//
//   rules/builtin-rules-processes.ts   — process, filesystem, git rules
//   rules/builtin-rules-database.ts    — database, container, cloud, wrangler
//   rules/builtin-rules-language.ts    — per-language destructive patterns
//   rules/builtin-rules-security.ts    — supply-chain, process-safety, info-flow
//   rules/builtin-rules.ts             — aggregates the four tables above
//   rules/default-config.ts            — DEFAULT_CONFIG value
//   rules/language-detection.ts        — project language detection + auto-tune
//   rules/merge.ts                     — team/local config merging
//   rules/file-io.ts                   — read/write guard-rules files
//   rules/distilled-rules.ts           — rules distilled from .md guidance by the `enforce` skill
//
// All existing exports from `rules-loader.ts` are preserved here.

import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { BUILTIN_RULES } from "./rules/builtin-rules.js";
import { DEFAULT_CONFIG } from "./rules/default-config.js";
import {
	getDistilledRulesWatchPaths,
	loadDistilledRules,
} from "./rules/distilled-rules.js";
import {
	readLocalGuardRules,
	readTeamGuardRules,
	writeLocalGuardRules,
	writeTeamGuardRules,
} from "./rules/file-io.js";
import { getFindingRulesWatchPaths, loadFindingRules } from "./rules/finding-rules.js";
import { autoTuneQualityChecks, detectProjectLanguages } from "./rules/language-detection.js";
import { mergeLocalOverrides, mergeTeamRules, sanitizePostureEnums } from "./rules/merge.js";
import {
	getModePreset,
	type HarnessModePreset,
	isKnownMode,
	migrateLegacyMode,
} from "./rules/modes.js";
import type { GuardRule, GuardRulesConfig } from "./types.js";

// Re-export file-io helpers as part of the public API.
// Consumers: `src/commands/reminder.ts`.
export { readLocalGuardRules, readTeamGuardRules, writeLocalGuardRules, writeTeamGuardRules };

/**
 * Public API — consumed by `src/harness/__tests__/docs-freshness.test.ts`
 * and by documentation generators. Returns a shallow clone so callers
 * cannot mutate the shared builtin-rules table.
 */
export function getBuiltinRules(): GuardRule[] {
	return [...BUILTIN_RULES];
}

/**
 * Public API — consumed by the harness server, the evaluator test suite,
 * and `interlinked verify`. Returns a deep clone of the default config
 * so callers can freely mutate it without affecting future calls.
 */
export function getDefaultConfig(): GuardRulesConfig {
	try {
		return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	} catch {
		// DEFAULT_CONFIG is a static object so this should never fail,
		// but guard against it to satisfy runtime safety checks
		return { ...DEFAULT_CONFIG, rules: [...DEFAULT_CONFIG.rules] };
	}
}

/**
 * Read the active harness mode from `.interlinked/config.json` and resolve
 * it to a preset. Returns null when the file is missing/unparseable so the
 * loader can keep using defaults — every consumer treats `null` as "no
 * mode-driven enablement override".
 *
 * Phase C: the hook script also reads this same field for
 * HARNESS_POST_TIMEOUT_MS, so the daemon and hook stay in sync via the
 * shared config file rather than a side channel.
 */
function readActiveModePreset(cwd: string): HarnessModePreset | null {
	const sharedConfigPath = join(cwd, ".interlinked", "config.json");
	if (!existsSync(sharedConfigPath)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(sharedConfigPath, "utf-8"));
		const rawMode = isJsonObject(parsed) && typeof parsed.mode === "string" ? parsed.mode : undefined;
		if (!rawMode) return null;
		const resolved = isKnownMode(rawMode) ? rawMode : migrateLegacyMode(rawMode, undefined);
		return getModePreset(resolved);
	} catch (_err) {
		/* intentional: malformed config.json — fall back to no mode override */
		return null;
	}
}

/**
 * Apply a mode preset's `quality_checks_enabled` map onto a fresh config.
 * Toggles `config.structural_checks.enabled` for the structural-checks key
 * and `config.quality_checks[name].enabled` for the rest. Keys not present
 * in `quality_checks` are skipped (legacy presets that named a check we no
 * longer ship). Mutates `config` in place.
 */
function applyModePresetEnablement(
	config: GuardRulesConfig,
	preset: HarnessModePreset,
): void {
	for (const [checkName, enabled] of Object.entries(preset.quality_checks_enabled)) {
		if (checkName === "structural_checks") {
			config.structural_checks.enabled = enabled;
			continue;
		}
		const entry = config.quality_checks[checkName];
		if (entry) entry.enabled = enabled;
	}
}

/**
 * Public API — the main entry point the harness server uses on startup
 * and on SIGHUP. Loads the default config, auto-tunes by detected
 * project language, and merges team + local overrides.
 *
 * Priority: local overrides > team rules > built-in defaults.
 */
export function loadRules(cwd: string = process.cwd()): GuardRulesConfig {
	const teamPath = join(cwd, ".interlinked", "guard-rules.json");
	const localPath = join(cwd, ".interlinked", "guard-rules.local.json");

	// Start with defaults
	const config = getDefaultConfig();

	// Auto-detect project languages and disable inapplicable checks
	const languages = detectProjectLanguages(cwd);
	autoTuneQualityChecks(config.quality_checks, languages);

	// Phase C — apply the operational tier preset BEFORE team/local merges
	// so user overrides remain authoritative. Without this branch
	// `interlinked harness mode budget` only lowered the hook timeout while
	// the daemon still ran structural / semgrep at their defaults; and
	// `ci` mode failed to enable the extra checks it advertises.
	const presetForMode = readActiveModePreset(cwd);
	if (presetForMode) {
		applyModePresetEnablement(config, presetForMode);
	}

	// Merge team rules
	if (existsSync(teamPath)) {
		try {
			const team = JSON.parse(readFileSync(teamPath, "utf-8"));
			mergeTeamRules(config, team);
		} catch (_err) {
			/* intentional: invalid JSON — best-effort fall back to defaults */
		}
	}

	// Merge local overrides (applied AFTER auto-tune so users can re-enable)
	if (existsSync(localPath)) {
		try {
			const local = JSON.parse(readFileSync(localPath, "utf-8"));
			mergeLocalOverrides(config, local);
		} catch (_err) {
			/* intentional: invalid JSON — best-effort skip overrides */
		}
	}

	// FINAL enum boundary (review 2026-08-30): after BOTH tiers merged, an
	// invalid posture enum value (e.g. test_first_mode: "typo" in the trusted
	// local file) is dropped so the built-in default applies — it never enters
	// the runtime config as a different posture. Doctor reports the details.
	sanitizePostureEnums(config);

	// Combine built-in rules with custom rules + rules distilled from .md
	// guidance by the `enforce` skill. Distilled rules are layered AFTER
	// custom rules so a hand-curated `guard-rules.json` entry with the same
	// id wins on conflict — committed team config remains authoritative
	// over per-developer distillation output.
	//
	// Test isolation: `INTERLINKED_SKIP_DISTILLED_RULES=1` skips the distilled
	// layer entirely. The vitest config sets this so the per-developer
	// `.interlinked/distilled-rules.json` (which varies by who has run
	// `/enforce` and against what) doesn't leak into test fixtures and cause
	// "passes on my machine" failures. Direct callers of `loadDistilledRules`
	// (e.g. `distilled-rules.test.ts`) are not affected.
	//
	// Backwards-compat: `INTERLINKED_SKIP_COMPILED_RULES` is honored as a
	// legacy alias so older test configs and CI setups keep working through
	// the rename. Remove on the next major.
	const disabledSet = new Set(config.disabled_rules || []);
	const skipDistilled =
		process.env.INTERLINKED_SKIP_DISTILLED_RULES === "1" ||
		process.env.INTERLINKED_SKIP_COMPILED_RULES === "1";
	const distilledRules = skipDistilled ? [] : loadDistilledRules(cwd);
	// 4th layer — findings-distilled rules (rules/finding-rules.ts). A SEPARATE
	// file from distilled (a bare /enforce run regenerates its pristine file and
	// would clobber these). loadFindingRules returns the active set already, so
	// spread it directly. Born advisory (action:warn); ratchets via recurrence.
	const allRules = [
		...BUILTIN_RULES.filter((r) => !disabledSet.has(r.id)),
		...config.rules.filter((r) => r.enabled !== false),
		...distilledRules.filter((r) => r.enabled !== false && !disabledSet.has(r.id)),
		...loadFindingRules(cwd),
	];
	config.rules = allRules;

	return config;
}

/**
 * Public API — consumed by the harness server to hot-reload rules when
 * the team or local config file changes on disk. Returns a cleanup
 * function that removes both watchers.
 */
export function watchRulesFiles(
	cwd: string,
	onReload: (config: GuardRulesConfig) => void,
): () => void {
	const teamPath = join(cwd, ".interlinked", "guard-rules.json");
	const localPath = join(cwd, ".interlinked", "guard-rules.local.json");
	const distilledPaths = getDistilledRulesWatchPaths(cwd);
	const findingRulePaths = getFindingRulesWatchPaths(cwd);

	const reload = () => {
		try {
			onReload(loadRules(cwd));
		} catch (_err) {
			/* intentional: best-effort hot-reload — swallow errors */
		}
	};

	/** Filesystem poll interval — 2s is a tradeoff between responsiveness
	 *  to rule edits and IO overhead. */
	const WATCH_POLL_INTERVAL_MS = 2_000;
	// Watch all rules files (watchFile is safe even when files don't exist —
	// it fires once they're created, which is the right behavior for the
	// distilled/findings pairs: skill runs create them mid-session and we want
	// the running daemon to pick them up without a restart).
	const watchedPaths = [teamPath, localPath, ...distilledPaths, ...findingRulePaths];
	for (const path of watchedPaths) {
		watchFile(path, { interval: WATCH_POLL_INTERVAL_MS }, reload);
	}

	return () => {
		for (const path of watchedPaths) {
			unwatchFile(path, reload);
		}
	};
}
