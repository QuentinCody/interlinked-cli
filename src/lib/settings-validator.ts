// ===========================================
// Permission-rule validator for Claude Code settings files
// ===========================================
//
// Claude Code's "Always allow" flow auto-derives a permission rule
// (e.g. `Bash(node *)`) from the user's command. For commands that
// begin with shell tests like `[ -d dir ]` the extractor occasionally
// emits a string with mismatched parentheses, e.g.
//   "Bash(-d) && cd && echo && node /path *)"
// Claude Code's own /doctor flags those as "Invalid permission rule
// ... was skipped: Mismatched parentheses".
//
// We can't stop the upstream extractor from writing them, but we can
// detect them after the fact and offer to strip them. This module is
// the single source of truth for that check, consumed by
// `interlinked doctor` (read-only) and `interlinked doctor --fix`
// (rewrite settings file with offenders removed).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type PermissionBucket = "allow" | "deny" | "ask";

/** Reason why a rule is considered malformed. Used by the
 *  PreToolUse content-guard to render a specific error message at
 *  write time. Three detected classes today:
 *    - "paren_imbalance" matches Claude Code's /doctor diagnostic.
 *    - "empty_rule" catches blank-string entries which Claude
 *      Code's settings reader silently accepts but no rule ever
 *      matches against — pure dead weight in the allowlist.
 *    - "missing_tool_prefix" catches strings like `"just a string"`
 *      that don't start with `<Tool>(`. They never match any tool
 *      call so the rule has no effect; flagging at write time keeps
 *      the allowlist readable. */
export type MalformedRuleReason = "paren_imbalance" | "empty_rule" | "missing_tool_prefix";

export interface MalformedRule {
	bucket: PermissionBucket;
	index: number;
	rule: string;
	/** Why this rule was flagged. Optional so legacy callers that
	 *  populate the `MalformedRule[]` array without a reason still
	 *  compile; the PreToolUse guard treats `undefined` as
	 *  `"paren_imbalance"` (the only detected class today). */
	reason?: MalformedRuleReason;
}

/** Human-readable description for a `MalformedRuleReason`. Used by
 *  the PreToolUse settings-file content guard to render a precise
 *  error message at write time. */
export function describeReason(reason: MalformedRuleReason | undefined): string {
	switch (reason) {
		case "empty_rule":
			return "empty rule";
		case "missing_tool_prefix":
			return "missing Tool(...) prefix";
		case "paren_imbalance":
		case undefined:
			return "mismatched parentheses";
	}
}

/** Paren-balance analysis used to coach the agent on which side is short.
 *  Returns the net depth (positive = missing `)` closes; negative = extra
 *  `)`s) and the 0-based column where the imbalance first manifests. The
 *  column points at the offending `)` for negative depths, or at the end
 *  of the string for positive ones (no specific char is "missing"). */
export interface ParenBalance {
	depth: number;
	firstBadCol: number;
}

export function analyzeParenBalance(rule: string): ParenBalance {
	let depth = 0;
	let firstBadCol = -1;
	for (let i = 0; i < rule.length; i++) {
		const ch = rule[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth < 0 && firstBadCol === -1) firstBadCol = i;
		}
	}
	if (depth > 0 && firstBadCol === -1) firstBadCol = rule.length;
	return { depth, firstBadCol };
}

/** Suggest a corrected form of a malformed rule. Returns `null` when no
 *  mechanical fix is safe — the agent must rewrite the rule itself.
 *
 *  Strategies per reason:
 *    - paren_imbalance: append missing `)` × N for positive depth, or
 *      drop the first extra `)` for depth = -1. We don't try to repair
 *      deeper depth-negative cases — too many plausible edits.
 *    - empty_rule: no suggestion (the agent should remove the entry).
 *    - missing_tool_prefix: wrap the trimmed rule body in `Bash(...)` if
 *      it looks shell-shaped (contains spaces, *, or shell metacharacters).
 *      Otherwise return null — wrong tool prefix is too ambiguous to guess.
 */
export function suggestRuleFix(rule: string, reason: MalformedRuleReason | undefined): string | null {
	const r = reason ?? "paren_imbalance";
	if (r === "paren_imbalance") {
		const { depth } = analyzeParenBalance(rule);
		if (depth > 0) return rule + ")".repeat(depth);
		if (depth === -1) {
			// Drop the first extra `)` — usually the offending character.
			const { firstBadCol } = analyzeParenBalance(rule);
			if (firstBadCol >= 0) {
				return rule.slice(0, firstBadCol) + rule.slice(firstBadCol + 1);
			}
		}
		return null;
	}
	if (r === "missing_tool_prefix") {
		const body = rule.trim();
		if (body.length === 0) return null;
		if (/[\s*?[\]$|;&<>`]/.test(body)) return `Bash(${body})`;
		return null;
	}
	return null;
}

/** A well-formed rule starts with `<ToolName>(`. This regex matches
 *  identifier-then-open-paren without requiring full grammar
 *  validation — that's Claude Code's job. */
const RULE_TOOL_PREFIX_RE = /^[A-Za-z][\w]*\(/;

/** Classify a single rule string. Returns the reason if malformed,
 *  null if the rule looks well-formed. Single source of truth for
 *  the three detected classes; both `findMalformedRulesIn` (in-memory
 *  scan, used by PreToolUse content guard) and `validateSettingsFile`
 *  (on-disk scan, used by audit-time checks) call through this so the
 *  two paths can never disagree on what counts as malformed. */
export function classifyRule(rule: string): MalformedRuleReason | null {
	if (rule.trim() === "") return "empty_rule";
	if (!RULE_TOOL_PREFIX_RE.test(rule)) return "missing_tool_prefix";
	if (!isParenBalanced(rule)) return "paren_imbalance";
	return null;
}

/** Scan a parsed settings-JSON object and return every malformed
 *  rule it contains. Used by the PreToolUse content guard to inspect
 *  a proposed write BEFORE it lands on disk. Classification is
 *  shared with `validateSettingsFile` via `classifyRule`. */
export function findMalformedRulesIn(parsedJson: unknown): MalformedRule[] {
	const out: MalformedRule[] = [];
	if (typeof parsedJson !== "object" || parsedJson === null) return out;
	const perms = (parsedJson as { permissions?: Record<PermissionBucket, unknown> }).permissions;
	if (!perms || typeof perms !== "object") return out;
	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			const rule = list[i];
			if (typeof rule !== "string") continue;
			const reason = classifyRule(rule);
			if (reason !== null) out.push({ bucket, index: i, rule, reason });
		}
	}
	return out;
}

export interface SettingsValidationResult {
	filePath: string;
	exists: boolean;
	parseError?: string;
	totalRules: number;
	malformed: MalformedRule[];
}

/**
 * Parens-only balance check: every `(` must have a matching `)` and we
 * must never go negative. This is the same shape the upstream /doctor
 * complains about, so a rule passing this check will not trigger the
 * "Mismatched parentheses" warning. We deliberately do not validate
 * deeper rule grammar — that's Claude Code's job — and we do not want
 * to flag rules the upstream tool happily accepts.
 */
export function isParenBalanced(rule: string): boolean {
	let depth = 0;
	for (const ch of rule) {
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/**
 * Default scan set: project-local + user-global Claude Code settings.
 * Both `settings.json` and `settings.local.json` at each scope. Caller
 * may override (tests pass a tmpdir).
 */
export function defaultSettingsPaths(cwd: string): string[] {
	return [
		join(cwd, ".claude", "settings.json"),
		join(cwd, ".claude", "settings.local.json"),
		join(homedir(), ".claude", "settings.json"),
		join(homedir(), ".claude", "settings.local.json"),
	];
}

export function validateSettingsFile(filePath: string): SettingsValidationResult {
	const result: SettingsValidationResult = {
		filePath,
		exists: existsSync(filePath),
		totalRules: 0,
		malformed: [],
	};
	if (!result.exists) return result;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (e) {
		result.parseError = e instanceof Error ? e.message : String(e);
		return result;
	}

	// `parsed` is JSON.parse output typed `unknown` — the file can legally
	// contain a non-object JSON value (`null`, an array, a bare string/number),
	// which a blind `as {...}` cast would let through and crash on the
	// following property access. Guard the shape before trusting it.
	if (typeof parsed !== "object" || parsed === null) return result;
	const perms = (parsed as { permissions?: Record<PermissionBucket, unknown> }).permissions;
	if (!perms || typeof perms !== "object") return result;

	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			const rule = list[i];
			if (typeof rule !== "string") continue;
			result.totalRules++;
			const reason = classifyRule(rule);
			if (reason !== null) {
				result.malformed.push({ bucket, index: i, rule, reason });
			}
		}
	}
	return result;
}

/** Audit record for one stripped rule. Written one-per-line to the
 *  JSONL log so an external consumer can grep / tail without parsing
 *  a multi-line shape. Schema is stable — adding fields is fine, but
 *  renaming or removing existing fields is a breaking change to log
 *  consumers. */
export interface StripAuditRecord {
	timestamp: string;
	file: string;
	bucket: PermissionBucket;
	index: number;
	rule: string;
	reason: MalformedRuleReason;
}

/** Public — rich return shape for `stripMalformedRulesAudited`. The
 *  legacy number-returning `stripMalformedRules` is preserved as a
 *  thin wrapper around this. */
export interface StripResult {
	stripped: number;
	entries: StripAuditRecord[];
}

/**
 * Rewrite a settings file with malformed permission rules removed and
 * return every stripped entry as a `StripAuditRecord`. Classification
 * shares `classifyRule` with `findMalformedRulesIn` /
 * `validateSettingsFile`, so empty-string and missing-`Tool(`-prefix
 * rules are stripped here too (not only paren imbalances).
 *
 * Preserves field order and the file's existing 2-space indentation.
 * No-op when there are no offenders.
 */
export function stripMalformedRulesAudited(filePath: string): StripResult {
	const result: StripResult = { stripped: 0, entries: [] };
	if (!existsSync(filePath)) return result;
	let parsedRaw: unknown;
	try {
		parsedRaw = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return result;
	}
	// Same JSON-boundary hazard as validateSettingsFile above: the file can
	// legally hold a non-object JSON value, which a blind cast would let
	// through and crash the following property access.
	if (typeof parsedRaw !== "object" || parsedRaw === null) return result;
	const parsed = parsedRaw as { permissions?: Record<PermissionBucket, unknown> };
	const perms = parsed.permissions;
	if (!perms || typeof perms !== "object") return result;

	const now = new Date().toISOString();
	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		const cleaned: unknown[] = [];
		for (let i = 0; i < list.length; i++) {
			const r = list[i];
			if (typeof r !== "string") {
				cleaned.push(r);
				continue;
			}
			const reason = classifyRule(r);
			if (reason === null) {
				cleaned.push(r);
				continue;
			}
			result.entries.push({
				timestamp: now,
				file: filePath,
				bucket,
				index: i,
				rule: r,
				reason,
			});
			result.stripped++;
		}
		if (result.stripped > 0) perms[bucket] = cleaned;
	}

	if (result.stripped > 0) {
		writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
	}
	return result;
}

/**
 * Legacy thin wrapper — returns just the stripped count. Kept so the
 * existing `interlinked doctor --fix` call site stays single-line.
 * New callers should use `stripMalformedRulesAudited` directly.
 */
export function stripMalformedRules(filePath: string): number {
	return stripMalformedRulesAudited(filePath).stripped;
}

/** Append each strip-audit record to the given JSONL log path, one
 *  per line. Creates the parent directory if needed. Safe to call
 *  with an empty `entries` array (no-op). */
export function appendStripAuditLog(logPath: string, entries: readonly StripAuditRecord[]): void {
	if (entries.length === 0) return;
	mkdirSync(dirname(logPath), { recursive: true });
	const lines = entries.map((e) => JSON.stringify(e)).join("\n");
	appendFileSync(logPath, `${lines}\n`, "utf-8");
}

/** Aggregate strip result across multiple settings paths. Surfaces a
 *  total + the per-path breakdown so callers can render both. */
export interface AutoStripResult {
	totalStripped: number;
	entries: StripAuditRecord[];
}

/**
 * Run `stripMalformedRulesAudited` across every project + user-scope
 * Claude settings path, appending the union of stripped entries to
 * `auditLogPath`. The default `auditLogPath` lives under `.interlinked/`
 * so it travels with the project. Returns the aggregated result for
 * the caller to surface (e.g. a SessionStart warning).
 */
export function autoStripAllScopes(
	cwd: string,
	auditLogPath?: string,
): AutoStripResult {
	const out: AutoStripResult = { totalStripped: 0, entries: [] };
	const paths = defaultSettingsPaths(cwd);
	for (const p of paths) {
		const r = stripMalformedRulesAudited(p);
		if (r.stripped > 0) {
			out.totalStripped += r.stripped;
			out.entries.push(...r.entries);
		}
	}
	if (out.entries.length > 0 && auditLogPath) {
		appendStripAuditLog(auditLogPath, out.entries);
	}
	return out;
}

/** Default audit log path for an `autoStripAllScopes` invocation in a
 *  project. Co-located with other harness state under `.interlinked/`. */
export function defaultStripAuditLogPath(cwd: string): string {
	return join(cwd, ".interlinked", "permission-rule-strips.jsonl");
}
