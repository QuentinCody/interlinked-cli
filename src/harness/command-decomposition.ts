// ===========================================
// Command Decomposition & Env Var Safety
// ===========================================
// Splits compound bash commands into subcommands for individual
// guard rule evaluation, and classifies env var prefixes as safe/dangerous.

import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { type CohortManager, getActiveCohort } from "./cohort.js";
import {
	applyGuardRuleToSubcommand,
	applyRewrite,
	type CompoundEvalResult,
	type MatchRuleFn,
	safeRegex,
	type SubcommandOutcome,
} from "./command-rule-dispatch.js";
import { classifyTopLevelSplit, nextBracketDepth } from "./command-split-classifiers.js";
import { classifySpans } from "./evaluator/spans.js";
import type { AgentRole, GuardRule, HarnessEvent, ToolConcurrencyClass } from "./types.js";
import { DANGEROUS_ENV_VARS, SAFE_ENV_VARS } from "./types.js";

export { applyRewrite };

// ===========================================
// Compound Command Decomposition
// ===========================================

/** Split a compound bash command into its subcommands.
 *
 *  Splits on top-level `&&`, `||`, `;`, `|`, `&` (background), and newlines.
 *  Span-classified regions (quoted strings, inline-exec payloads, comments,
 *  heredoc bodies) are atomic — operators inside them never split. Newlines
 *  and pipes matter: `npm publish --dry-run\nnpm publish` must decompose so
 *  the second segment is evaluated without the first segment's `--dry-run`
 *  suppressing it (the compound-bypass shape destructive_command_guard
 *  closed for `safe-cmd && destructive-cmd`; see
 *  docs/external-pulse/destructive-command-guard.md).
 *
 *  Heredoc glue rules keep bodies attached to their command: no split on the
 *  header line's operators or newline (`cat <<EOF | grep x` stays whole), and
 *  none inside the body — otherwise body text would be evaluated as commands.
 *
 *  Per-character decisions are delegated to two pure classifiers
 *  (`command-split-classifiers.ts`) so this orchestrator reads as the
 *  algorithm's shape: consume atomic spans, track bracket/backtick nesting,
 *  then (at top level) classify compound operators. Both classifiers take
 *  plain values and return a decision with no loop state, so each is
 *  independently testable. */
export function decomposeCommand(command: string): string[] {
	const spans = classifySpans(command);
	const atomic = spans.filter((s) => s.kind !== "executed");
	const heredocs = spans.filter((s) => s.kind === "heredoc");

	const atomicEndFor = (idx: number): number | null => {
		for (const s of atomic) {
			if (idx >= s.start && idx < s.end) return s.end;
		}
		return null;
	};
	const heredocStartsAt = (idx: number): boolean => heredocs.some((s) => s.start === idx);
	// A heredoc whose body begins after this position's line: operators here
	// belong to the heredoc's header line and must not split.
	const pendingHeredocOnLine = (idx: number): boolean => {
		let lineEnd = command.indexOf("\n", idx);
		if (lineEnd === -1) lineEnd = command.length;
		return heredocs.some((s) => s.start > idx && s.start <= lineEnd + 1);
	};

	const parts: string[] = [];
	let current = "";
	let depth = 0;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const atomicEnd = atomicEndFor(i);
		if (atomicEnd !== null) {
			current += command.slice(i, atomicEnd);
			i = atomicEnd - 1;
			continue;
		}

		const ch = command[i];
		const next = command[i + 1];

		// Track subshell/substitution depth
		const newDepth = nextBracketDepth(ch, next, depth);
		if (newDepth !== null) {
			depth = newDepth;
			current += ch;
			continue;
		}

		// Only split at top level
		if (depth === 0) {
			const action = classifyTopLevelSplit(
				command,
				i,
				ch,
				next,
				heredocStartsAt,
				pendingHeredocOnLine,
			);
			if (action) {
				if (action.split) push();
				current += action.append;
				i += action.extraChars;
				continue;
			}
		}

		current += ch;
	}

	push();
	return parts;
}

// ===========================================
// Env Var Prefix Stripping
// ===========================================

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/;

interface EnvStripResult {
	stripped: string;
	dangerous_var?: string;
}

/**
 * Strip leading env var assignments from a command string.
 *
 * For deny rule matching: strips ALL env vars (aggressive — prevents bypass).
 * For allow rule matching: strips only SAFE_ENV_VARS (conservative — prevents escalation).
 */
export function stripEnvVarPrefix(command: string, mode: "deny" | "allow"): EnvStripResult {
	const parts = command.trim().split(/\s+/);
	let i = 0;

	while (i < parts.length && ENV_VAR_ASSIGN_RE.test(nonNull(parts[i]))) {
		const varName = nonNull(nonNull(parts[i]).split("=")[0]);

		if (DANGEROUS_ENV_VARS.has(varName)) {
			return { stripped: command, dangerous_var: varName };
		}

		if (mode === "allow" && !SAFE_ENV_VARS.has(varName)) {
			break;
		}

		i++;
	}

	return { stripped: parts.slice(i).join(" ") };
}

// ===========================================
// Guard Rule Evaluation with Decomposition
// ===========================================

/**
 * Evaluate one subcommand against every applicable guard rule.
 *
 * Extracted from {@link evaluateCompoundCommand} so the per-rule dispatch
 * (block/warn/rewrite) doesn't nest three levels inside the subcommand loop —
 * {@link applyGuardRuleToSubcommand} (in command-rule-dispatch.ts) IS that
 * nested body, callable and independently testable. `warnings` is the
 * caller's shared array; that function pushes onto it directly rather than
 * returning a copy.
 *
 * Preserves the original's rewrite semantics exactly: each matching
 * `rewrite` rule is applied to the ORIGINAL `sub` text (not chained onto a
 * prior rewrite within the same subcommand), and the last rule to produce a
 * change wins — matching the pre-extraction loop's repeated
 * `rewrittenParts[idx] = rewritten` overwrite.
 */
function evaluateSubcommand(
	sub: string,
	guardRules: GuardRule[],
	extraExceptions: Record<string, string[]> | undefined,
	matcher: MatchRuleFn,
	warnings: string[],
): SubcommandOutcome {
	const { stripped, dangerous_var } = stripEnvVarPrefix(sub, "deny");

	if (dangerous_var) {
		return {
			block: {
				decision: "block",
				reason: `BLOCKED: Dangerous environment variable ${dangerous_var}= detected in command. This can hijack library loading or alter execution.`,
				warnings,
				severity: "critical",
				category: "Security",
			},
		};
	}

	let rewritten: string | null = null;

	for (const rule of guardRules) {
		const outcome = applyGuardRuleToSubcommand(rule, sub, stripped, extraExceptions, matcher, warnings);
		if (outcome.block) return outcome;
		if (outcome.rewritten !== undefined) rewritten = outcome.rewritten;
	}

	return rewritten !== null ? { rewritten } : {};
}

/**
 * Evaluate a compound bash command by decomposing it into subcommands
 * and checking each against guard rules individually.
 *
 * Returns a block if ANY subcommand is blocked, aggregates warnings,
 * and applies rewrites where applicable.
 */
export function evaluateCompoundCommand(
	fullCommand: string,
	guardRules: GuardRule[],
	extraExceptions?: Record<string, string[]>,
	matchFn?: MatchRuleFn,
): CompoundEvalResult {
	const subcommands = decomposeCommand(fullCommand);
	const warnings: string[] = [];

	// Single command — no decomposition needed (fast path)
	if (subcommands.length <= 1) {
		return { decision: "allow", warnings };
	}

	let rewrittenParts: string[] | null = null;
	const matcher = matchFn ?? defaultMatchRule;

	for (let idx = 0; idx < subcommands.length; idx++) {
		const sub = nonNull(subcommands[idx]);
		const outcome = evaluateSubcommand(sub, guardRules, extraExceptions, matcher, warnings);

		if (outcome.block) return outcome.block;

		if (outcome.rewritten !== undefined) {
			if (!rewrittenParts) rewrittenParts = [...subcommands];
			rewrittenParts[idx] = outcome.rewritten;
		}
	}

	const result: CompoundEvalResult = { decision: "allow", warnings };
	if (rewrittenParts) {
		result.updated_input = { command: rewrittenParts.join(" && ") };
	}
	return result;
}

/** Minimal rule matching for subcommand evaluation (mirrors evaluator's matchesRule).
 *  All regex patterns come from trusted admin config (guard-rules.json). */
function defaultMatchRule(command: string, toolInput: JsonObject, rule: GuardRule): boolean {
	const positivePatterns = rule.patterns.filter((p) => !p.negate);
	const negatedPatterns = rule.patterns.filter((p) => p.negate);

	let anyPositiveMatched = positivePatterns.length === 0;
	for (const pattern of positivePatterns) {
		const value = resolvePatternValue(pattern.field, command, toolInput);
		if (!value) continue;
		const regex = safeRegex(pattern.regex, pattern.flags || "i");
		if (regex?.test(value)) {
			anyPositiveMatched = true;
			break;
		}
	}

	if (!anyPositiveMatched) return false;

	for (const pattern of negatedPatterns) {
		const value = resolvePatternValue(pattern.field, command, toolInput);
		if (!value) continue;
		const regex = safeRegex(pattern.regex, pattern.flags || "i");
		if (regex?.test(value)) return false;
	}

	return true;
}

function resolvePatternValue(field: string, command: string, toolInput: JsonObject): string {
	if (field === "command") return command;
	return String(toolInput[field] ?? "");
}

// ===========================================
// Tool Concurrency Classification
// ===========================================

/** Read-only tools that never mutate state */
const READ_ONLY_TOOLS = new Set([
	"Read",
	"ReadFile",
	"read_file",
	"FileRead",
	"Glob",
	"GlobTool",
	"Grep",
	"GrepTool",
	"Ls",
	"ListFiles",
	"WebSearch",
	"web_search",
	"WebFetch",
	"web_fetch",
	"ToolSearch",
	"TaskGet",
	"TaskList",
	"AskUserQuestion",
]);

/** Tools that modify state */
const STATE_CHANGING_TOOLS = new Set([
	"Write",
	"WriteFile",
	"write_file",
	"FileWrite",
	"Edit",
	"EditFile",
	"edit_file",
	"FileEdit",
	"Bash",
	"Shell",
	"shell",
	"run_command",
	"NotebookEdit",
	"TaskCreate",
	"TaskUpdate",
]);

/** Classify a tool call's concurrency safety */
export function classifyToolConcurrency(toolName: string): ToolConcurrencyClass {
	if (READ_ONLY_TOOLS.has(toolName)) return "read_only";
	if (STATE_CHANGING_TOOLS.has(toolName)) return "state_changing";
	return "unknown";
}

// ===========================================
// Agent Role Inference
// ===========================================

/**
 * True when the cohort knows this event's agent as somebody's child. The wire
 * fields (`parent_agent`, `agent_type`) are populated only on Subagent
 * lifecycle envelopes — an ordinary PreToolUse tool call from inside a
 * subagent carries none of them, which left `applies_to_roles` a dead lever
 * at gate time (docs/design/cohort-git-discipline.md §3.3). The cohort DOES
 * know the lineage (SubagentStart recorded `parent_agent`), so ask it first;
 * falls back to the active-cohort provider when no cohort is passed.
 */
function cohortKnowsAsSubagent(event: HarnessEvent, cohort?: CohortManager | null): boolean {
	const cohortView = cohort ?? getActiveCohort();
	if (!event.agent_name || !cohortView) return false;
	return Boolean(cohortView.getAgent(event.agent_name)?.parent_agent);
}

/** Infer agent role from event context when not explicitly set */
export function inferAgentRole(event: HarnessEvent, cohort?: CohortManager | null): AgentRole {
	if (event.agent_role) return event.agent_role;

	if (cohortKnowsAsSubagent(event, cohort)) return "subagent";
	if (event.parent_agent) return "subagent";
	if (event.hook_event === "SubagentStart" || event.hook_event === "SubagentStop")
		return "subagent";

	const agentType = event.agent_type?.toLowerCase() || "";
	if (agentType.includes("explore") || agentType.includes("plan")) return "subagent";
	if (agentType.includes("worker")) return "worker";
	if (agentType.includes("lead") || agentType.includes("coordinator")) return "lead";

	const name = (event.agent_name || "").toLowerCase();
	if (name.includes("worker")) return "worker";
	if (name.includes("lead") || name.includes("coordinator")) return "lead";

	return "unknown";
}

/** Check if a guard rule applies to the given agent role */
export function ruleAppliesToRole(rule: GuardRule, role: AgentRole): boolean {
	if (!rule.applies_to_roles || rule.applies_to_roles.length === 0) return true;
	return rule.applies_to_roles.includes(role);
}
