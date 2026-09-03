// ===========================================
// Guard Rule Dispatch (per-subcommand)
// ===========================================
// Split out of command-decomposition.ts to keep that orchestrator under the
// line cap. Holds the per-rule block/warn/rewrite dispatch used by
// evaluateSubcommand, plus the small pieces it alone depends on: the shared
// result/matcher types, the trigger/tool-match gate, and the trusted-config
// regex helpers that back rewrite application. command-decomposition.ts
// re-exports `applyRewrite` for backward-compatible import paths.

import type { JsonObject } from "../lib/json-types.js";
import type { GuardRule, InputRewrite } from "./types.js";

/** Callback type for custom rule matching (mirrors evaluator's matchesRule) */
export type MatchRuleFn = (
	cmd: string,
	input: JsonObject,
	rule: GuardRule,
	extras?: Record<string, string[]>,
) => boolean;

export interface CompoundEvalResult {
	decision: "allow" | "block";
	reason?: string | undefined;
	warnings: string[];
	updated_input?: JsonObject | undefined;
	rule_id?: string | undefined;
	severity?: "critical" | "high" | "medium" | "low" | undefined;
	category?: string | undefined;
}

/** Per-subcommand verdict from evaluateSubcommand: either a block
 *  the caller must return immediately, or a rewritten command string to
 *  splice back into the subcommand list (absent when nothing matched). */
export interface SubcommandOutcome {
	block?: CompoundEvalResult;
	rewritten?: string;
}

export function shouldEvaluateForBash(rule: GuardRule): boolean {
	if (!rule.enabled) return false;
	if (rule.trigger !== "PreToolUse" && rule.trigger !== "both") return false;
	if (rule.tool_match.includes("*")) return true;
	return rule.tool_match.some((m) => {
		const lower = m.toLowerCase();
		return lower === "bash" || lower === "shell";
	});
}

/**
 * Dispatch one guard rule against one subcommand: block/warn/rewrite.
 *
 * Extracted from {@link evaluateSubcommand} in command-decomposition.ts, so
 * the per-rule three-way dispatch doesn't nest inside its rule loop — this
 * function IS that loop body for a single `rule`, callable and
 * independently testable. `warnings` is the caller's shared array; this
 * function pushes onto it directly rather than returning a copy. A rule
 * that doesn't apply (wrong event/tool, or the matcher rejects it) returns
 * `{}`, the loop's "continue" outcome.
 */
export function applyGuardRuleToSubcommand(
	rule: GuardRule,
	sub: string,
	stripped: string,
	extraExceptions: Record<string, string[]> | undefined,
	matcher: MatchRuleFn,
	warnings: string[],
): SubcommandOutcome {
	if (!shouldEvaluateForBash(rule)) return {};
	const subInput: JsonObject = { command: stripped };
	if (!matcher(stripped, subInput, rule, extraExceptions)) return {};

	if (rule.action === "block") {
		return {
			block: {
				decision: "block",
				reason: `BLOCKED: ${rule.reason} (in subcommand: ${sub.slice(0, 80)})`,
				warnings,
				rule_id: rule.id,
				severity: rule.severity,
				category: rule.category,
			},
		};
	}

	if (rule.action === "warn") {
		warnings.push(`[interlinked] Warning: ${rule.reason} (in subcommand: ${sub.slice(0, 60)})`);
	}

	if (rule.action === "rewrite" && rule.rewrite) {
		const next = applyRewrite(sub, rule.rewrite);
		if (next !== sub) {
			warnings.push(`[interlinked:rewrite] Rewrote: ${sub.slice(0, 40)} → ${next.slice(0, 40)}`);
			return { rewritten: next };
		}
	}

	return {};
}

// ===========================================
// Input Rewrite Application
// ===========================================

/** Apply an InputRewrite spec to a command string.
 *  Rewrite patterns come from trusted admin config (guard-rules.json), not user input.
 *  Regex length is capped to prevent accidental complexity from config errors. */
export function applyRewrite(command: string, rewrite: InputRewrite): string {
	if (rewrite.match.length > 200) return command;
	try {
		const regex = safeRegex(rewrite.match, "g");
		return regex ? command.replace(regex, rewrite.replace) : command;
	} catch {
		return command;
	}
}

// ===========================================
// Trusted Config Regex Helper
// ===========================================

/**
 * Pre-compiled regex cache for trusted admin config patterns.
 * Guard rule patterns come from guard-rules.json files authored by
 * the project admin — they are NOT user/agent input.
 */
const _regexCache = new Map<string, RegExp | null>();

export function safeRegex(pattern: string, flags: string): RegExp | null {
	if (pattern.length > 200) return null;
	const key = `${pattern}\0${flags}`;
	const cached = _regexCache.get(key);
	if (cached !== undefined) return cached;
	try {
		// Reason: pattern source is the admin-authored guard-rules file;
		// length is capped above (≤200) and compile failures fall through.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		const re = new RegExp(pattern, flags);
		_regexCache.set(key, re);
		return re;
	} catch {
		_regexCache.set(key, null);
		return null;
	}
}
