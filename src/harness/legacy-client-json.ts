import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { HarnessDecision, ResolvedTarget } from "./types.js";

export function compactJson(value: JsonObject): JsonObject {
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) out[key] = item;
	}
	return out;
}

export function asJsonObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

export function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : null;
}

const RESOLVED_TARGET_KINDS = new Set<ResolvedTarget["kind"]>([
	"file", "table", "url", "branch", "recipient", "package",
]);

function parseResolvedTarget(value: unknown): ResolvedTarget | null {
	if (!isJsonObject(value)) return null;
	const kind = Array.from(RESOLVED_TARGET_KINDS).find((candidate) => candidate === value.kind);
	const v = value.value;
	if (!kind) return null;
	return typeof v === "string" ? { kind, value: v } : null;
}

/** Construct the legacy bridge's decision from the fields it validates and retains. */
export function parseHarnessDecision(value: unknown): HarnessDecision | null {
	if (!isJsonObject(value)) return null;
	const { decision } = value;
	if (decision !== "allow" && decision !== "block" && decision !== "ask") return null;
	const reason = typeof value.reason === "string" ? value.reason : undefined;
	const rule_id = typeof value.rule_id === "string" ? value.rule_id : undefined;
	const additional_context =
		typeof value.additional_context === "string" ? value.additional_context : undefined;
	const warnings = Array.isArray(value.warnings)
		? value.warnings.filter((w): w is string => typeof w === "string")
		: undefined;
	const resolved_targets = Array.isArray(value.resolved_targets)
		? value.resolved_targets.map(parseResolvedTarget).filter((t): t is ResolvedTarget => t !== null)
		: undefined;
	return {
		decision,
		...parseDecisionExtensions(value),
		...(reason !== undefined ? { reason } : {}),
		...(rule_id !== undefined ? { rule_id } : {}),
		...(additional_context !== undefined ? { additional_context } : {}),
		...(warnings !== undefined ? { warnings } : {}),
		...(resolved_targets !== undefined ? { resolved_targets } : {}),
	};
}

function parseDecisionExtensions(value: JsonObject): Partial<HarnessDecision> {
	const extensions: Partial<HarnessDecision> = {};
	if (isJsonObject(value.updated_input)) extensions.updated_input = value.updated_input;
	if (Array.isArray(value.watch_paths) && value.watch_paths.every(path => typeof path === "string")) extensions.watch_paths = value.watch_paths;
	return extensions;
}
