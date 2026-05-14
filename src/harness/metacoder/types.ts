// interlinked-tdd: exempt
// ===========================================
// Metacoder — Types
// ===========================================
// Per-prompt, session-scoped overlay rules emitted by an LLM. See
// docs/design/metacoding-agent-plan.md for the full architecture.
// Declarative — types, type aliases, one default-config literal, one constant.
// Behavior is tested through the consumers (overlay-loader, metacoder-client).

import type { AgentSource, GuardRule } from "../types.js";

/** Wire shape of `.interlinked/sessions/<sid>/overlay-rules.json`. The model
 *  emits `version`, `rules`, and `system_prompt_addendum`; the harness fills
 *  in the rest. */
export interface OverlayRulesFile {
	version: 1;
	session_id: string;
	generated_at: string;
	generated_by: "metacoder";
	source_prompt_sha256: string;
	system_prompt_addendum?: string;
	rules: GuardRule[];
}

/** What the metacoder LLM is asked to author. Matches `OverlayRulesFile`
 *  minus the server-filled fields. */
export interface OverlayRulesEmission {
	version: 1;
	rules: GuardRule[];
	system_prompt_addendum?: string;
}

/** Input passed to the metacoder LLM as JSON. */
export interface MetacoderInputContext {
	prompt: string;
	client: AgentSource;
	session_id: string;
	cwd: string;
	/** Exact prefix every overlay rule id MUST start with. Computed by the
	 *  server as `overlayIdPrefix(session_id)`, then truncated/sanitized.
	 *  Passed in literal form so the LLM can copy it byte-for-byte —
	 *  guessing from `session_id` and a description in the system prompt
	 *  produces collisions with the loader's expected prefix. */
	overlay_prefix: string;
	/** AGENTS.md + CLAUDE.md (+ peers) concatenated, capped at ~20kB. */
	project_instructions: string;
	/** Floor rule ids so the LLM knows what NOT to duplicate or disable. */
	floor_rule_ids: string[];
	/** Optional structural-cache summary. Stub when cache is empty. */
	project_graph_summary?: string;
}

/** Outcome of a single metacoder run. `ok` returns the overlay the harness
 *  should persist; the other variants are fail-open paths. */
export type MetacoderOutcome =
	| { kind: "ok"; overlay: OverlayRulesFile; warnings: string[] }
	| { kind: "skipped"; reason: SkippedReason; warnings: string[] }
	| { kind: "failed"; reason: string; warnings: string[] };

export type SkippedReason =
	| "disabled"
	| "no_prompt"
	| "no_api_key"
	| "subprocess_not_found"
	| "recursion_guard"
	| "empty_overlay";

/** Resolved metacoder config. */
export interface MetacoderConfig {
	enabled: boolean;
	/** Internal LLM call timeout. Must be < hook user-prompt timeout (35s). */
	timeout_ms: number;
	/** Hard cap on rules per overlay. Defensive against runaway emissions. */
	max_rules: number;
	/** Hard cap on regex length per pattern. */
	max_pattern_length: number;
	/** Hard cap on patterns per rule. */
	max_patterns_per_rule: number;
	/** Hard cap on system_prompt_addendum length. */
	max_addendum_chars: number;
}

/** Default metacoder timeout. Strictly less than `USER_PROMPT_HOOK_TIMEOUT_MS`
 *  so the harness has a buffer to return its own timeout decision before the
 *  hook gives up. */
export const METACODER_TIMEOUT_DEFAULT_MS = 30_000;

/** Hard cap on overlay rule count per emission. */
export const METACODER_MAX_RULES_DEFAULT = 20;

/** Hard cap on regex pattern length (chars). Bounds compilation cost. */
export const METACODER_MAX_PATTERN_LENGTH_DEFAULT = 200;

/** Hard cap on patterns per rule. */
export const METACODER_MAX_PATTERNS_PER_RULE_DEFAULT = 10;

/** Hard cap on `system_prompt_addendum` length (chars). 2 KB × N turns
 *  accumulates in the agent's context window — see plan §10 risk #5. */
export const METACODER_MAX_ADDENDUM_CHARS_DEFAULT = 2000;

export const DEFAULT_METACODER_CONFIG: MetacoderConfig = {
	enabled: true,
	timeout_ms: METACODER_TIMEOUT_DEFAULT_MS,
	max_rules: METACODER_MAX_RULES_DEFAULT,
	max_pattern_length: METACODER_MAX_PATTERN_LENGTH_DEFAULT,
	max_patterns_per_rule: METACODER_MAX_PATTERNS_PER_RULE_DEFAULT,
	max_addendum_chars: METACODER_MAX_ADDENDUM_CHARS_DEFAULT,
};

/** Hook adapter timeout for the user-prompt phase. Strictly greater than
 *  `MetacoderConfig.timeout_ms` so the harness has a buffer to convert a
 *  clean metacoder timeout into an allow decision before the hook gives up
 *  on the socket and falls back. Drift here means 100% cold-fallback. */
export const USER_PROMPT_HOOK_TIMEOUT_MS = 35_000;
