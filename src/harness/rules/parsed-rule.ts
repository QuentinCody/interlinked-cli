import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { GuardRule, RulePattern } from "../types.js";

export function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optional(value: unknown, valid: (value: unknown) => boolean): boolean {
	return value === undefined || valid(value);
}

function string(value: unknown): value is string {
	return typeof value === "string";
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
	return values.some((candidate) => candidate === value);
}

export function isRuleAction(value: unknown): value is GuardRule["action"] {
	return member(["block", "warn", "rewrite", "soft_block", "ask"], value);
}

export function isRuleSeverity(value: unknown): value is GuardRule["severity"] {
	return member(["critical", "high", "medium", "low"], value);
}

function isPattern(value: unknown): value is RulePattern {
	if (!isJsonObject(value) || !string(value.field) || !string(value.regex)) return false;
	if (!optional(value.flags, string)) return false;
	return [value.negate, value.strip_wrappers, value.executed_only].every(
		(flag) => flag === undefined || typeof flag === "boolean",
	);
}

function isTemporal(value: unknown): boolean {
	return isJsonObject(value)
		&& [value.tool, value.bash_match, value.file_read].every((field) => optional(field, string))
		&& optional(value.verification_kind, (kind) => member(["typecheck", "test", "lint", "build", "dev_server", "browser"], kind))
		&& optional(value.within_last_n, finite);
}

function isPhase(value: unknown): boolean {
	return isJsonObject(value) && string(value.name) && string(value.value)
		&& optional(value.scope, (scope) => member(["file", "session"], scope));
}

function isAfterCommand(value: unknown): boolean {
	return isJsonObject(value) && string(value.pattern) && optional(value.window_steps, finite);
}

function isPredicate(value: unknown): boolean {
	return isJsonObject(value) && string(value.name) && optional(value.args, isJsonObject);
}

function isAgentSource(value: unknown): boolean {
	return member(["claude", "cowork", "copilot", "gemini", "codex", "cursor", "opencode", "pi", "factory-droid", "windsurf", "antigravity", "crush"], value);
}

function isActiveWhen(value: unknown): boolean {
	if (!isJsonObject(value)) return false;
	return [value.skill, value.overlay].every((field) => optional(field, (item) => string(item) || isStringList(item)))
		&& optional(value.file_scope, string)
		&& optional(value.phase, isPhase)
		&& optional(value.after_command, isAfterCommand)
		&& optional(value.predicate, isPredicate)
		&& optional(value.agent_source, (source) => isAgentSource(source) || (Array.isArray(source) && source.every(isAgentSource)));
}

function isRewrite(value: unknown): boolean {
	return isJsonObject(value) && string(value.field) && string(value.match) && string(value.replace);
}

function validOptionalFields(value: JsonObject): boolean {
	return [value.suggestion, value.category, value.expires_at, value.expires_after].every((field) => optional(field, string))
		&& [value.keywords, value.file_extensions].every((field) => optional(field, isStringList))
		&& optional(value.applies_to_roles, (roles) => Array.isArray(roles) && roles.every((role) => member(["lead", "worker", "subagent", "unknown"], role)))
		&& optional(value.tool_externality, (tiers) => Array.isArray(tiers) && tiers.every((tier) => member(["pure_read", "local_write", "external_action"], tier)))
		&& optional(value.rewrite, isRewrite)
		&& optional(value.active_when, isActiveWhen)
		&& optional(value.requires_prior, isTemporal)
		&& optional(value.forbids_after, isTemporal);
}

function isRuntimeRule(value: JsonObject): value is JsonObject & GuardRule {
	return string(value.id) && value.id.length > 0
		&& typeof value.enabled === "boolean"
		&& member(["PreToolUse", "PostToolUse", "both"], value.trigger)
		&& isStringList(value.tool_match)
		&& isRuleAction(value.action)
		&& Array.isArray(value.patterns) && value.patterns.every(isPattern)
		&& string(value.reason) && isRuleSeverity(value.severity)
		&& validOptionalFields(value);
}

/** Validate every field consumed by the evaluator; keep legacy omitted defaults. */
export function parseRuntimeRule(value: unknown): (JsonObject & GuardRule) | null {
	if (!isJsonObject(value)) return null;
	const normalized = {
		...value,
		enabled: value.enabled === undefined ? true : value.enabled,
		patterns: value.patterns === undefined ? [] : value.patterns,
	};
	return isRuntimeRule(normalized) ? normalized : null;
}

export interface RuleModification {
	action?: GuardRule["action"];
	severity?: GuardRule["severity"];
	enabled?: boolean;
	note?: string;
}

export function parseRuleModifications(value: unknown): Record<string, RuleModification> {
	const result: Record<string, RuleModification> = {};
	if (!isJsonObject(value)) return result;
	for (const [id, raw] of Object.entries(value)) {
		if (!isJsonObject(raw)) continue;
		const mod: RuleModification = {};
		if (isRuleAction(raw.action)) mod.action = raw.action;
		if (isRuleSeverity(raw.severity)) mod.severity = raw.severity;
		if (typeof raw.enabled === "boolean") mod.enabled = raw.enabled;
		if (string(raw.note)) mod.note = raw.note;
		Object.defineProperty(result, id, { value: mod, enumerable: true });
	}
	return result;
}

export function stringList(value: unknown): string[] {
	return isStringList(value) ? value : [];
}
