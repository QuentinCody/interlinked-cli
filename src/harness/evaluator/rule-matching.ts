// ===========================================
// Guard-Rule Pattern Matching Helpers
// ===========================================
//
// Shared machinery for evaluating a single `GuardRule` against a tool-call
// payload: trigger/tool filters, cached regex compilation, positive +
// negated pattern logic, dot-path field lookup, and the canonical reason
// formatter that fronts every block decision.

import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type {
	GuardRule,
	HarnessEvent,
	ResolvedTarget,
	RulePattern,
	SessionTrajectory,
} from "../types.js";
import { extractScannableText } from "./spans.js";
import { evaluateForbidsAfter, evaluateRequiresPrior } from "./temporal-matching.js";
import { classifyToolExternality } from "./tool-classifiers.js";
import { normalizeCommandWrappers } from "./wrapper-normalization.js";

/** Nested indexable object type for dot-path field traversal in rule pattern matching */
interface Indexable {
	[key: string]: unknown;
}

/** Rule triggers that match every lifecycle phase regardless of the current phase. */
const TRIGGER_BOTH = "both";

/** Tool-match token meaning "applies to every tool call". */
const TOOL_MATCH_ALL = "*";

/** Public API — consumed by evaluator sub-modules to decide whether a rule applies
 *  to the current lifecycle phase and tool name. */
export function shouldEvaluateRule(
	rule: GuardRule,
	phase: "PreToolUse" | "PostToolUse",
	toolName: string,
): boolean {
	if (!rule.enabled) return false;
	if (rule.trigger !== phase && rule.trigger !== TRIGGER_BOTH) return false;
	if (rule.tool_match.includes(TOOL_MATCH_ALL)) return true;
	return rule.tool_match.some((m) => m.toLowerCase() === toolName.toLowerCase());
}

/**
 * Pre-compiled regex cache for guard rule patterns.
 * These patterns come from admin-authored guard-rules.json config files,
 * not from user or agent input. Caching avoids re-compiling on every
 * tool call (67+ built-in rules × multiple patterns each).
 */
const _ruleRegexCache = new Map<string, RegExp>();

/** Public API — consumed by evaluator sub-modules to cheaply reuse compiled regex
 *  objects derived from trusted guard-rule config patterns.
 *
 *  ReDoS validation is intentionally NOT applied here. Admin-authored built-in
 *  rules contain bounded patterns like `(-[rf]+\s+)*` whose outer shape
 *  matches a generic ReDoS heuristic but are actually safe (anchored by
 *  literal characters between groups). The ReDoS gate runs at the LOAD point
 *  for user-supplied / `/enforce`-distilled rules instead — see
 *  `rules/distilled-rules.ts` and `safeCompileRegex` in `redos-validation.ts`. */
export function getCachedRegex(pattern: string, flags: string): RegExp {
	const key = `${pattern}\0${flags}`;
	let re = _ruleRegexCache.get(key);
	if (!re) {
		// Reason: pattern/flags come from the admin-authored guard-rules
		// config (trusted); the cache and isolation are orthogonal to ReDoS.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		re = new RegExp(pattern, flags);
		_ruleRegexCache.set(key, re);
	}
	// Reset lastIndex for stateful flags (g, y) — guard rules don't use them,
	// but defensive in case a config adds them.
	re.lastIndex = 0;
	return re;
}

/** Public API — arguments to {@link matchesRule}. Grouped as a struct so the
 *  evaluator and `command-decomposition.ts` can share a single call contract. */
export interface MatchRuleContext {
	command: string;
	toolInput: JsonObject;
	rule: GuardRule;
	extraExceptions?: Record<string, string[]> | undefined;
	/** Tool name from the hook event. Required when the rule declares
	 *  `tool_externality`; otherwise unused. */
	toolName?: string | undefined;
	/** Live session trajectory — required when the rule declares
	 *  `requires_prior` / `forbids_after`. Optional so callers without
	 *  a session in scope (compound-command decomposer) keep working;
	 *  rules with temporal predicates fall through to allow there. */
	session?: SessionTrajectory | undefined;
}

/** Return values from {@link evaluatePatterns}: either the rule's patterns
 *  passed (MATCH), no positive pattern hit, or a negated exception fired. */
const PATTERN_RESULT_MATCH = "match";
const PATTERN_RESULT_NO_POSITIVE = "no-positive-match";
const PATTERN_RESULT_NEGATED = "negated-match";
type PatternResult =
	| typeof PATTERN_RESULT_MATCH
	| typeof PATTERN_RESULT_NO_POSITIVE
	| typeof PATTERN_RESULT_NEGATED;

/** Apply opt-in projections (`strip_wrappers`, `executed_only`) to the
 *  raw field value before regex matching. Order: mask non-executed spans
 *  first (preserves indices via space-fill), then strip wrapper prefixes
 *  from the resulting executed-only string. Both off → identity. */
function projectForPattern(value: string, pattern: RulePattern): string {
	let v = value;
	if (pattern.executed_only) v = extractScannableText(v);
	if (pattern.strip_wrappers) v = normalizeCommandWrappers(v);
	return v;
}

/** Evaluate the positive + negated pattern pair against a resolved input value. */
function evaluatePatterns(rule: GuardRule, toolInput: JsonObject, fallback: string): PatternResult {
	const positivePatterns = rule.patterns.filter((p) => !p.negate);
	const negatedPatterns = rule.patterns.filter((p) => p.negate);

	// ANY positive pattern must match (OR logic); vacuously true with zero patterns.
	let anyPositiveMatched = positivePatterns.length === 0;
	for (const pattern of positivePatterns) {
		// getField's return is genuinely unknown (rule-config-driven field lookup),
		// so `|| fallback` can still land on a falsy runtime value (0, "", false) —
		// annotate explicitly to keep TS from over-narrowing this to "always truthy".
		const value: unknown = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags ?? "i");
		if (regex.test(projectForPattern(String(value), pattern))) {
			anyPositiveMatched = true;
			break;
		}
	}
	if (!anyPositiveMatched) return PATTERN_RESULT_NO_POSITIVE;

	// ALL negated patterns must NOT match (exceptions).
	for (const pattern of negatedPatterns) {
		// See the positive-pattern loop above: keep the type honestly `unknown`
		// so this falsy guard stays live for genuinely falsy field values.
		const value: unknown = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags ?? "i");
		if (regex.test(projectForPattern(String(value), pattern))) return PATTERN_RESULT_NEGATED;
	}
	return PATTERN_RESULT_MATCH;
}

/** Normalize an extension token: lowercase, strip a leading dot, drop empties. */
function normalizeExt(token: string): string {
	const t = token.trim().toLowerCase();
	return t.startsWith(".") ? t.slice(1) : t;
}

/** Extract the lower-cased file extension (no leading dot) from a path-like
 *  string. Returns "" when no dot is present. */
function extractFileExt(filePath: string): string {
	const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

/** When a rule declares `file_extensions`, the tool's `file_path` (or `path`)
 *  must end in one of them. */
function passesFileExtensionScope(rule: GuardRule, toolInput: JsonObject): boolean {
	const allowlist = rule.file_extensions;
	if (!allowlist || allowlist.length === 0) return true;
	const filePath = String(getField(toolInput, "file_path") || getField(toolInput, "path") || "");
	if (!filePath) return false;
	const ext = extractFileExt(filePath);
	if (!ext) return false;
	const normalized = allowlist.map(normalizeExt).filter((e) => e.length > 0);
	return normalized.includes(ext);
}

/** When a rule declares `tool_externality`, classify the current tool call
 *  and require the result to be in the allowlist. */
function passesToolExternalityGate(rule: GuardRule, ctx: MatchRuleContext): boolean {
	const allowlist = rule.tool_externality;
	if (!allowlist || allowlist.length === 0) return true;
	const tier = classifyToolExternality(ctx.toolName ?? "", ctx.toolInput);
	return allowlist.includes(tier);
}

/** Public API — consumed by evaluator sub-modules to test a rule against a tool-call payload.
 *  Applies OR over positive patterns, exceptions via `negate: true` patterns, a final
 *  allowlist from `extra_exceptions`, externality gating, and temporal precondition gating. */
export function matchesRule(ctx: MatchRuleContext): boolean {
	const { command, toolInput, rule, extraExceptions, session } = ctx;

	if (!passesFileExtensionScope(rule, toolInput)) return false;
	if (!passesToolExternalityGate(rule, ctx)) return false;

	const patternResult = evaluatePatterns(rule, toolInput, command);
	if (patternResult !== PATTERN_RESULT_MATCH) return false;

	// Check extra exceptions from local config (substring allowlist on command).
	const exceptions = extraExceptions?.[rule.id];
	if (exceptions) {
		const cmd = String(getField(toolInput, "command") || command);
		for (const exc of exceptions) {
			if (cmd.includes(exc)) return false;
		}
	}

	// Temporal-precondition gating. After content patterns + extra_exceptions
	// so the rule is already a content-level hit. Semantics:
	//   - `requires_prior` fires when predicate NOT satisfied (precondition missing).
	//   - `forbids_after` fires when predicate IS satisfied (forbidden state present).
	// Without a session in scope, rules with temporal predicates fall through to
	// not-fire — content-level callers (compound decomposer) don't gate temporally.
	if ((rule.requires_prior || rule.forbids_after) && !session) {
		return false;
	}
	if (rule.requires_prior && session) {
		const result = evaluateRequiresPrior(session, rule.requires_prior);
		if (result.satisfied) return false; // precondition met → rule stays dormant
	}
	if (rule.forbids_after && session) {
		const result = evaluateForbidsAfter(session, rule.forbids_after);
		if (!result.satisfied) return false; // forbidden state absent → rule stays dormant
	}

	return true;
}

/** `typeof` keyword for non-primitive indexable containers; anything else (string,
 *  number, function, etc.) is a dead-end during dot-path traversal. */
const TYPEOF_OBJECT = "object";

/** Public API — consumed by evaluator sub-modules for dot-path field traversal
 *  (e.g., "tool_response.stdout") into a payload object. */
export function getField(obj: Indexable, path: string): unknown {
	if (!path.includes(".")) return obj[path];
	const parts = path.split(".");
	let current: Indexable = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const value = current[nonNull(parts[i])];
		if (value == null || typeof value !== TYPEOF_OBJECT || Array.isArray(value))
			return undefined;
		current = value as Indexable;
	}
	return current[nonNull(parts[parts.length - 1])];
}

/** Public API — consumed by evaluator sub-modules to format the `reason` field
 *  on a blocking decision, appending the rule's optional remediation suggestion. */
export function formatReason(rule: GuardRule): string {
	let msg = `BLOCKED: ${rule.reason}`;
	if (rule.suggestion) {
		msg += `\n\nSuggestion: ${rule.suggestion}`;
	}
	return msg;
}

/** Public API — agent-facing reason for `decision: "ask"`. */
export function formatAskReason(rule: GuardRule): string {
	let msg = `POTENTIALLY DESTRUCTIVE: ${rule.reason}\n\n`;
	msg += "This action requires user confirmation before proceeding. ";
	msg += "If the user approves, the operation will run; if not, choose a non-destructive alternative.";
	if (rule.suggestion) {
		msg += `\n\nSuggestion: ${rule.suggestion}`;
	}
	return msg;
}

/** Public API — user-only message attached to ask decisions on clients that
 *  surface a separate user channel. */
export function formatAskSystemMessage(rule: GuardRule, event: HarnessEvent): string {
	const lines = [
		`⚠️  Interlinked detected a potentially destructive operation.`,
		`   Tool:     ${event.tool_name || "unknown"}`,
		`   Rule:     ${rule.id} (${rule.severity})`,
		`   Why:      ${rule.reason}`,
	];
	if (rule.suggestion) {
		lines.push(`   Safer:    ${rule.suggestion}`);
	}
	lines.push("");
	lines.push("Approve only if you intended this action. Deny to make the agent pick a non-destructive path.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Resolved-target extraction for ask-decision confirmation prompts.
// ---------------------------------------------------------------------------

/** Maximum number of resolved targets surfaced per ask-decision. */
const MAX_RESOLVED_TARGETS = 5;

/** Maximum length (chars) of a single resolved target value. */
const MAX_TARGET_VALUE_LEN = 200;

const MCP_KEY_PATTERNS: Array<{ kind: ResolvedTarget["kind"]; suffixes: string[] }> = [
	{ kind: "url", suffixes: ["url"] },
	{ kind: "branch", suffixes: ["branch"] },
	{ kind: "table", suffixes: ["table"] },
	{ kind: "recipient", suffixes: ["recipient", "to"] },
	{ kind: "file", suffixes: ["path"] },
];

const RM_FLAG_PREFIX = "-";

function truncateTargetValue(value: string): string {
	if (value.length <= MAX_TARGET_VALUE_LEN) return value;
	return `${value.slice(0, MAX_TARGET_VALUE_LEN - 1)}…`;
}

function pushTarget(
	acc: ResolvedTarget[],
	kind: ResolvedTarget["kind"],
	value: string,
): boolean {
	if (acc.length >= MAX_RESOLVED_TARGETS) return true;
	const trimmed = value.trim();
	if (!trimmed) return false;
	acc.push({ kind, value: truncateTargetValue(trimmed) });
	return acc.length >= MAX_RESOLVED_TARGETS;
}

function tokenizeShell(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const ch of cmd) {
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function extractRmTargets(cmd: string, acc: ResolvedTarget[]): void {
	const tokens = tokenizeShell(cmd);
	let started = false;
	for (const tok of tokens) {
		if (!started) {
			const base = tok.split("/").pop() || tok;
			if (base === "rm") started = true;
			continue;
		}
		if (tok.startsWith(RM_FLAG_PREFIX)) continue;
		if (pushTarget(acc, "file", tok)) return;
	}
}

function extractUrlFromCommand(cmd: string, acc: ResolvedTarget[]): void {
	const urlRe = /https?:\/\/[^\s'"`)<>]+/g;
	let match: RegExpExecArray | null = urlRe.exec(cmd);
	while (match) {
		if (pushTarget(acc, "url", match[0])) return;
		match = urlRe.exec(cmd);
	}
}

function extractGitPushBranch(cmd: string, acc: ResolvedTarget[]): void {
	const tokens = tokenizeShell(cmd);
	let i = 0;
	while (i < tokens.length) {
		const base = nonNull(tokens[i]).split("/").pop() || tokens[i];
		if (base === "git") break;
		i++;
	}
	if (i >= tokens.length) return;
	let j = i + 1;
	while (j < tokens.length && tokens[j] !== "push") j++;
	if (j >= tokens.length) return;
	const positionals: string[] = [];
	for (let k = j + 1; k < tokens.length && positionals.length < 2; k++) {
		const t = nonNull(tokens[k]);
		if (t.startsWith(RM_FLAG_PREFIX)) continue;
		positionals.push(t);
	}
	if (positionals.length >= 2) {
		pushTarget(acc, "branch", nonNull(positionals[1]));
	}
}

function extractBashTargets(cmd: string, acc: ResolvedTarget[]): void {
	if (!cmd) return;
	const trimmed = cmd.trim();
	if (/(^|\s|;|&&|\|\|)(?:sudo\s+)?(?:[a-z0-9_./-]*\/)?rm(\s|$)/i.test(trimmed)) {
		extractRmTargets(trimmed, acc);
	}
	if (/\b(?:curl|wget)\b/i.test(trimmed)) {
		extractUrlFromCommand(trimmed, acc);
	}
	if (/\bgit\s+push\b/i.test(trimmed)) {
		extractGitPushBranch(trimmed, acc);
	}
}

function classifyMcpKey(key: string): ResolvedTarget["kind"] | null {
	const lower = key.toLowerCase();
	for (const { kind, suffixes } of MCP_KEY_PATTERNS) {
		for (const suffix of suffixes) {
			if (lower === suffix) return kind;
			if (lower.endsWith(`_${suffix}`)) return kind;
		}
	}
	if (lower.endsWith("_id") || lower === "id") return "package";
	if (lower.endsWith("_name") || lower === "name") return "package";
	return null;
}

function extractMcpTargets(toolInput: JsonObject, acc: ResolvedTarget[]): void {
	for (const [key, value] of Object.entries(toolInput)) {
		if (acc.length >= MAX_RESOLVED_TARGETS) return;
		if (typeof value !== "string") continue;
		const kind = classifyMcpKey(key);
		if (!kind) continue;
		if (pushTarget(acc, kind, value)) return;
	}
}

function isWriteLikeTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return (
		lower === "write" ||
		lower === "edit" ||
		lower === "multiedit" ||
		lower === "notebookedit"
	);
}

function extractWriteTargets(toolInput: JsonObject, acc: ResolvedTarget[]): void {
	const fp = toolInput.file_path;
	if (typeof fp === "string" && fp) pushTarget(acc, "file", fp);
}

function extractWebFetchTargets(toolInput: JsonObject, acc: ResolvedTarget[]): void {
	const url = toolInput.url;
	if (typeof url === "string" && url) pushTarget(acc, "url", url);
}

/** Public API — format an ask-decision reason with resolved targets appended
 *  as a `Targets:` bullet list. Used by per-runner adapters. */
export function formatAskReasonWithTargets(
	reason: string,
	targets: ResolvedTarget[] | undefined,
): string {
	if (!targets || targets.length === 0) return reason;
	const lines = [reason, "", "Targets:"];
	for (const t of targets) {
		lines.push(`  • ${t.kind}: ${t.value}`);
	}
	return lines.join("\n");
}

/** Public API — extract concrete resolved targets for a tool invocation that
 *  fired `decision: "ask"`. */
export function extractResolvedTargets(
	toolName: string,
	toolInput: JsonObject,
	_rule: GuardRule,
): ResolvedTarget[] {
	const acc: ResolvedTarget[] = [];
	const lowerTool = (toolName || "").toLowerCase();

	if (lowerTool === "bash") {
		const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
		extractBashTargets(cmd, acc);
	} else if (isWriteLikeTool(toolName)) {
		extractWriteTargets(toolInput, acc);
	} else if (lowerTool === "webfetch") {
		extractWebFetchTargets(toolInput, acc);
	} else if (lowerTool.startsWith("mcp__")) {
		extractMcpTargets(toolInput, acc);
	}

	return acc;
}
