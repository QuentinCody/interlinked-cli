// ===========================================
// Phase C — Tiered Harness Modes
// ===========================================
// Three operational tiers tied to provider hook timeouts. Distinct from the
// check-policy ModeName concept in `src/harness/modes.ts`, which governs
// per-check action overrides (balanced/strict/lenient/custom). These modes
// drive HARNESS_POST_TIMEOUT_MS in the generated .mjs hook plus which heavy
// quality checks are enabled.
//
// Provider compatibility (see master plan §"Phase C"):
//
//   Mode      Timeout   Heavy checks                                   Best for
//   ----      -------   ------------                                   --------
//   budget    30 000    none                                           Copilot CLI (30 s floor)
//   quality   50 000    structural_checks, affected_tests, semgrep     Claude/Cursor/Gemini (60 s)
//   ci        60 000    + prompt_injection, full mutation gate         Codex (600 s) / CI runners
//
// The mode is persisted in `.interlinked/config.json` under the `mode`
// key. The CLI command `interlinked harness mode <name>` writes it and
// regenerates the hook .mjs so the timeout literal is baked in.
//
// Migration policy (per the master plan four-question Q&A):
//   `balanced` → `quality`  (non-Copilot runners; gives users the headroom
//                            to actually run structural / semgrep)
//   `balanced` → `budget`   (Copilot CLI users; the 30 s provider floor
//                            collides with quality's 50 s timeout)
//   strict / lenient / custom / unknown → `quality` (safe default; users
//                            who actually want strict per-check actions
//                            keep using the orthogonal check-policy file)

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type HarnessMode = "budget" | "quality" | "ci";

export interface HarnessModePreset {
	name: HarnessMode;
	description: string;
	/** Hook-side timeout for the PostToolUse harness round-trip. Baked into
	 *  the generated `.mjs` as the literal `HARNESS_POST_TIMEOUT_MS`. The
	 *  daemon's actual check budget is this minus a safety margin. */
	post_timeout_ms: number;
	/** Per-check enablement map. Heavy checks gated by the operational tier
	 *  (see plan §C.3). Checks not listed here are unaffected — daemon-side
	 *  defaults apply. Use the canonical check id (e.g. `structural_checks`,
	 *  `affected_tests`, `prompt_injection`, `semgrep`). */
	quality_checks_enabled: Readonly<Record<string, boolean>>;
}

// -----------------------------------------------------------------------------
// Presets
// -----------------------------------------------------------------------------

export const BUDGET_MODE: HarnessModePreset = {
	name: "budget",
	description:
		"30 s timeout — recommended for Copilot CLI users. Heavy checks disabled to fit the 30 s provider floor.",
	post_timeout_ms: 30_000,
	quality_checks_enabled: {
		structural_checks: false,
		affected_tests: false,
		prompt_injection: false,
		semgrep: false,
	},
};

export const QUALITY_MODE: HarnessModePreset = {
	name: "quality",
	description:
		"50 s timeout — recommended for Claude Code, Cursor, and Gemini. Structural checks, affected tests, and semgrep enabled.",
	post_timeout_ms: 50_000,
	quality_checks_enabled: {
		structural_checks: true,
		affected_tests: true,
		prompt_injection: false,
		semgrep: true,
	},
};

export const CI_MODE: HarnessModePreset = {
	name: "ci",
	description:
		"60 s timeout — recommended for Codex (600 s budget) and CI runners. Every heavy check enabled including prompt-injection scanning.",
	post_timeout_ms: 60_000,
	quality_checks_enabled: {
		structural_checks: true,
		affected_tests: true,
		prompt_injection: true,
		semgrep: true,
	},
};

/** Iteration order matches the budget→quality→ci progression — used by
 *  the CLI command for help text and validation. */
export const HARNESS_MODE_NAMES: readonly HarnessMode[] = ["budget", "quality", "ci"] as const;

/** Default mode for new installs. `quality` is the safe choice for the
 *  three providers most users run (Claude / Cursor / Gemini). Copilot CLI
 *  users get migrated down to `budget` via `migrateLegacyMode`. */
export const DEFAULT_HARNESS_MODE: HarnessMode = "quality";

const PRESETS_BY_NAME: Readonly<Record<HarnessMode, HarnessModePreset>> = {
	budget: BUDGET_MODE,
	quality: QUALITY_MODE,
	ci: CI_MODE,
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Type guard for the three valid HarnessMode names. Mirrors the existing
 *  `isKnownMode` helper in `../modes.ts` (which guards the orthogonal
 *  check-policy ModeName) — same name, different module, different type. */
export function isKnownMode(name: string): name is HarnessMode {
	return name === "budget" || name === "quality" || name === "ci";
}

/** Return the preset for a known HarnessMode. `PRESETS_BY_NAME` is a total
 *  `Record<HarnessMode, _>`, so this lookup can never miss for a value the
 *  type checker accepts as `HarnessMode`. */
export function getModePreset(name: HarnessMode): HarnessModePreset {
	return PRESETS_BY_NAME[name];
}

/** Auto-migrate a legacy or unknown mode string to a HarnessMode, respecting
 *  the active runner. Per the master plan Q&A: `balanced` → `budget` for
 *  Copilot CLI (30 s floor); `balanced` → `quality` everywhere else; any
 *  other unknown / legacy / undefined value → `quality` (safe default).
 *
 *  Already-valid HarnessMode strings pass through unchanged so this can be
 *  called unconditionally on read. */
export function migrateLegacyMode(
	raw: string | undefined,
	runner: string | undefined,
): HarnessMode {
	if (raw && isKnownMode(raw)) return raw;
	if (raw === "balanced") {
		return runner === "copilot-cli" ? "budget" : "quality";
	}
	// strict, lenient, custom, undefined, or anything else — fall back to
	// the safe default. Users who genuinely want strict-per-check action
	// behavior keep using the orthogonal check-policy.json file; this
	// migration is purely about the operational tier.
	return DEFAULT_HARNESS_MODE;
}
