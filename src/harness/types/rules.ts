// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Guard Rule & Active-When Scoping Types
// ===========================================

import type { JsonObject } from "../../lib/json-types.js";
import type { AgentRole, AgentSource } from "./events.js";

// ===========================================
// Guard Rules
// ===========================================

/**
 * Coarse "blast radius" axis for the side effects a tool call can have.
 *
 * Distinct from the read/write predicates that only describe local
 * file-system semantics:
 *
 * - `pure_read`       — observation only (no mutation, no network).
 * - `local_write`     — mutates state confined to this machine.
 * - `external_action` — escapes the machine (network, remote API, push,
 *                       deploy, publish, email, …).
 *
 * Mirrors the same union exported from
 * `src/harness/evaluator/tool-classifiers.ts`; declared here so
 * `GuardRule.tool_externality` can reference it without pulling in the
 * evaluator module (types/rules.ts is intentionally side-effect free).
 */
export type ToolExternality = "pure_read" | "local_write" | "external_action";

/** Input rewrite specification for guard rules with action: "rewrite" */
export interface InputRewrite {
	/** Field to rewrite (dot-path, e.g. "command") */
	field: string;
	/** Regex pattern to match in the field value */
	match: string;
	/** Replacement string (supports $1, $2, etc. for capture groups) */
	replace: string;
}

export interface GuardRule {
	/** Unique rule identifier */
	id: string;
	/** Whether this rule is active */
	enabled: boolean;
	/** When to evaluate: before tool execution, after, or both */
	trigger: "PreToolUse" | "PostToolUse" | "both";
	/** Tool names this rule applies to. Use "*" for all tools. */
	tool_match: string[];
	/**
	 * What to do when the rule fires.
	 * - `block`: refuse the call. Reason returned to the agent.
	 * - `warn`: allow but emit a stderr warning (visible to the agent on Claude/Codex/Gemini; logged-only on Copilot).
	 * - `rewrite`: transform the tool input via `rule.rewrite` before execution.
	 * - `soft_block`: block first attempt but allow retry — used for "are you sure?" patterns.
	 * - `ask`: surface a per-call user confirmation prompt on agents that support
	 *   it (Claude Code, Cursor). On agents that lack an ask primitive (Copilot,
	 *   Codex, Gemini) the provider-response formatter collapses this to a hard
	 *   deny so the user still sees the reason and can retry deliberately.
	 *   Used for *potentially* destructive operations where human review beats
	 *   blanket denial: REST DELETE calls, GraphQL mutations carrying delete
	 *   verbs, MCP tools whose name suggests deletion.
	 */
	action: "block" | "warn" | "rewrite" | "soft_block" | "ask";
	/** Patterns to match against tool input fields */
	patterns: RulePattern[];
	/** Human-readable reason shown to the agent */
	reason: string;
	/** Suggested alternative action */
	suggestion?: string | undefined;
	/** Severity for logging and dashboard display */
	severity: "critical" | "high" | "medium" | "low";
	/** Category for documentation grouping */
	category?: string | undefined;
	/** Agent roles this rule applies to (omit or empty = all roles) */
	applies_to_roles?: AgentRole[] | undefined;
	/** Input rewrite function key — used when action is "rewrite" */
	rewrite?: InputRewrite | undefined;
	/**
	 * Keyword tokens that, when ANY of them appear in the wrapper-normalized
	 * command, gate evaluation of this rule. Empty/missing list = "always
	 * evaluate" (used for rules whose canonical pattern has no word tokens,
	 * like the fork bomb `:(){:|:&};:`). Quick-reject filter — see
	 * `evaluator/keyword-quick-reject.ts`. Tokens are matched
	 * case-insensitively against shell-tokenized command text.
	 */
	keywords?: string[] | undefined;
	/**
	 * Optional ISO 8601 expiry timestamp. If set and in the past at rule-load
	 * time, the rule is silently dropped from the loaded set. Used for
	 * temporary rules ("block X until 2026-06-01") so they don't linger as
	 * forgotten allowlist entries.
	 */
	expires_at?: string | undefined;
	/**
	 * Optional duration after which the rule expires, expressed as e.g.
	 * "30d", "12h", "1w". Loader resolves to a concrete `expires_at` at the
	 * moment the rule is first loaded. Convenience for human-authored configs.
	 */
	expires_after?: string | undefined;
	/**
	 * Optional runtime scope condition. When present, the rule is dormant
	 * unless every listed axis holds (skill active, TDD phase matches,
	 * recent command in window, etc.). See `ActiveWhen` and
	 * docs/design/harness-active-when-scoping.md.
	 */
	active_when?: ActiveWhen | undefined;
	/**
	 * Optional file-extension allowlist. When set, the rule only fires if the
	 * tool input's `file_path` (or `path`) field has an extension in this
	 * list. Used by language-specific content rules so a Python regex doesn't
	 * fire on a Markdown file that *describes* the same pattern in a code
	 * block, and so a "DROP TABLE" regex doesn't trip on marketing copy
	 * mentioning what the harness blocks. Match is case-insensitive and
	 * tolerant of leading dot ('.py' and 'py' both work). Undefined =
	 * unrestricted (the existing default).
	 */
	file_extensions?: string[] | undefined;
	/**
	 * Optional externality-tier allowlist. When set, the rule only fires if
	 * `classifyToolExternality(tool_name, tool_input)` (see
	 * `evaluator/tool-classifiers.ts`) is in this list. Lets policy authors
	 * target the strictest tier (`external_action`) cleanly — e.g. "block
	 * destructive Bash unless I'm pushing/publishing" reduces to
	 * `tool_externality: ["external_action"]` rather than a hand-rolled
	 * regex over every network verb. Undefined = unrestricted (preserves
	 * existing fire-on-all behaviour).
	 */
	tool_externality?: ToolExternality[] | undefined;
	/**
	 * Temporal precondition. After content patterns match, evaluated against
	 * the live `SessionTrajectory`. Rule fires only when predicate is NOT
	 * satisfied (the required earlier action is missing). Pure read; see
	 * `src/harness/evaluator/temporal-matching.ts`.
	 */
	requires_prior?: TemporalPredicate | undefined;
	/**
	 * Temporal anti-precondition. After content patterns match, evaluated
	 * against the live `SessionTrajectory`. Rule fires only when predicate
	 * IS satisfied (the forbidden earlier action is present). Pure read.
	 */
	forbids_after?: TemporalPredicate | undefined;
}

/**
 * Predicate over the session's recent trajectory — `tool_sequence`,
 * `commands_run`, `files_read`, `verification_observed`. Used by `GuardRule`'s
 * `requires_prior` / `forbids_after` axes. A predicate with multiple fields
 * set is AND-combined: every populated field must hold for the predicate to
 * be considered satisfied.
 */
export interface TemporalPredicate {
	/** Match against `session.tool_sequence` entries (format `"ToolName:target"`).
	 *  Case-sensitive prefix match on tool name; `"*"` matches any tool. */
	tool?: string;
	/** Case-insensitive regex applied to entries of `session.commands_run`. */
	bash_match?: string;
	/** Path or simple glob (`*` matches one segment, `**` matches any number)
	 *  tested against `session.files_read`. */
	file_read?: string;
	/** Membership check against `session.verification_observed`. */
	verification_kind?: "typecheck" | "test" | "lint" | "build" | "dev_server" | "browser";
	/** How far back in `tool_sequence` / `commands_run` to scan. Omit (or
	 *  non-positive) to scan the full session. */
	within_last_n?: number;
}

export interface RulePattern {
	/** Dot-path into tool_input: "command", "file_path", "content" */
	field: string;
	/** Regex pattern string */
	regex: string;
	/** Regex flags (default: "i") */
	flags?: string;
	/** If true, pattern must NOT match (exception pattern) */
	negate?: boolean;
	/**
	 * Strip wrapper prefixes (`sudo`, `doas`, `env VAR=val`, `command -p`,
	 * `\cmd`) from the matched value before testing the regex. Use on
	 * patterns that anchor to the start of the command line; harmless
	 * elsewhere. Off by default to preserve raw-text rules
	 * (`\bsudo\s+rm\b`, etc.) that depend on the prefix being visible.
	 * Plan 01 §1.1.
	 */
	strip_wrappers?: boolean;
	/**
	 * Mask non-executed spans (single/double-quoted strings, comments,
	 * heredocs) with whitespace before testing the regex. Suppresses the
	 * `git commit -m 'rm -rf /'` class of FP. Off by default to preserve
	 * rules that *want* to inspect quoted argument shape (SQL payloads,
	 * `pkill -f 'wrangler dev'` exceptions). Plan 01 §1.2.
	 */
	executed_only?: boolean;
	/**
	 * Name of a capture group in `regex` that holds a file operand. The
	 * pattern then matches only when that operand, resolved against the
	 * event's cwd (same-command `cd` hops and `VAR=` assignments applied),
	 * is an existing regular file with contents. For rules whose harm IS the
	 * destruction of contents (`: > file`): the daemon has the filesystem,
	 * so creating an empty file is not a truncation. With no cwd, or an
	 * operand the resolver cannot place, the match stands (fail closed).
	 */
	nonempty_file_group?: string;
}

// ===========================================
// Active-When Scoping
// ===========================================
//
// `active_when` lets a distilled rule stay dormant until a runtime context
// signal fires. See docs/design/harness-active-when-scoping.md for the full
// rationale. Axes are AND-ed; an omitted axis is always-on. Rules without
// `active_when` keep current always-on behavior.

export interface ActiveWhen {
	/** One or more skill names; rule is active if ANY listed skill is in the session's `active_skills` map. */
	skill?: string | string[];
	/** Phase predicate (TDD red/green, ship phase, review phase, …). */
	phase?: PhaseSpec;
	/** Rule active only if the trajectory's recent commands match `pattern` within last `window_steps`. */
	after_command?: AfterCommandSpec;
	/**
	 * Additional file_path regex AND-ed with rule.patterns. Useful when the
	 * scope axis is "only when editing files matching X" but you don't want
	 * to merge into every positive pattern. Empty/missing = no extra filter.
	 */
	file_scope?: string;
	/** One or more model-overlay names (e.g., "claude", "gpt"). */
	overlay?: string | string[];
	/**
	 * One or more agent_source names. Distinct from `applies_to_roles`:
	 * roles gate evaluation entirely; agent_source here is a scope axis
	 * (rule loads but is dormant unless source matches).
	 */
	agent_source?: AgentSource | AgentSource[];
	/** Generic escape hatch for §6.5 predicates not yet promoted to a typed axis. */
	predicate?: SessionPredicateSpec;
}

export interface PhaseSpec {
	/** Predicate name — open string keeps the vocabulary extensible. Built-in: "tdd_state", "ship_phase", "review_phase". */
	name: string;
	/** Required value (e.g., "red", "green"). */
	value: string;
	/** "file" = per-file phase (tdd_state); "session" = whole-session phase. Default "session". */
	scope?: "file" | "session";
}

export interface AfterCommandSpec {
	/** Regex matched against entries in `SessionTrajectory.commands_run`. */
	pattern: string;
	/** How many recent entries to scan; default 10. */
	window_steps?: number;
}

export interface SessionPredicateSpec {
	name: string;
	args?: JsonObject;
}

/** Per-session record of an active skill marker. Garbage-collected on every session event. */
export interface ActiveSkillRecord {
	name: string;
	/** ms-since-epoch. */
	entered_at: number;
	/** ms-since-epoch; rule lookups treat the marker as expired once `Date.now() > expires_at`. */
	expires_at: number;
	/** "cli" = explicit `interlinked skill enter`; "hook" = agent-native skill lifecycle event; "manual" = enable-side toggle. */
	source: "cli" | "hook" | "manual";
}
