import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { parseMetricPolicies, type MetricPolicies, type MetricPolicyScope } from "../../harness/metric-policy.js";
import { isJsonObject } from "../json-types.js";
import { METRIC_CATALOG } from "../metrics/catalog-metrics.js";
import { hashBytes } from "../metrics/inventory.js";
import { CANONICAL_TOKENIZER_ID, TYPESCRIPT_TOKENIZER_ID } from "../../harness/function-tokens/types.js";

export interface ProfileRule {
	check: string;
	mode: "report" | "warn" | "off";
	scope?: MetricPolicyScope;
}
export interface PolicyProfile {
	schemaVersion: 1;
	id: string;
	description?: string;
	metrics: MetricPolicies;
	rules: Record<string, ProfileRule>;
}

export function profileMeasurementContract(id: string): string | null {
	if (id === "tokens") return TYPESCRIPT_TOKENIZER_ID;
	if (id === "function-tokens") return CANONICAL_TOKENIZER_ID;
	if (id === "file.lines") return 'content.split("\\n").length';
	return null;
}

export function structuralPolicyId(id: string): "cyclomatic" | "cognitive" | "function-tokens" | null {
	if (id === "function-tokens") return "function-tokens";
	return id === "cyclomatic" || id === "cognitive" ? id : null;
}

function keys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
	if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
	const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
	if (unexpected.length) throw new Error(`${label} contains unsupported fields ${unexpected.join(", ")}`);
}

function identifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} requires a lowercase stable identifier`);
}

function policyEntry(value: unknown, label: string) {
	keys(value, ["mode", "threshold", "scope"], label);
	if (value.scope !== undefined) keys(value.scope, ["paths", "roles"], `${label}.scope`);
	const parsed = parseMetricPolicies({ entry: value });
	if (parsed.issues.length || !parsed.policies.entry) throw new Error(`${label} has invalid mode, threshold or scope`);
	return parsed.policies.entry;
}

function metricEntries(value: unknown): MetricPolicies {
	if (value === undefined) return {};
	keys(value, Object.keys(value ?? {}), "metrics");
	const metrics: MetricPolicies = {};
	for (const [inputId, entry] of Object.entries(value)) {
		if (inputId !== "function-tokens" && !METRIC_CATALOG.some(metric => metric.id === inputId)) throw new Error(`Unknown metric ${inputId}`);
		metrics[inputId] = policyEntry(entry, `metrics.${inputId}`);
	}
	return metrics;
}

function ruleEntries(value: unknown): Record<string, ProfileRule> {
	if (value === undefined) return {};
	keys(value, Object.keys(value ?? {}), "rules");
	const rules: Record<string, ProfileRule> = {};
	for (const [id, entry] of Object.entries(value)) {
		identifier(id, "Rule ID");
		keys(entry, ["check", "mode", "scope"], `rules.${id}`);
		if (typeof entry.check !== "string" || !CHECK_REGISTRY.some(check => check.id === entry.check)) throw new Error(`Unknown detector for rules.${id}`);
		const selected: Record<string, unknown> = {};
		if (entry.mode !== undefined) selected.mode = entry.mode;
		if (entry.scope !== undefined) selected.scope = entry.scope;
		const policy = policyEntry(selected, `rules.${id}`);
		if (policy.mode === "block") throw new Error(`rules.${id} supports report, warn or off`);
		rules[id] = { check: entry.check, mode: policy.mode ?? "report", ...(policy.scope ? { scope: policy.scope } : {}) };
	}
	return rules;
}

/** Profiles select installed contracts as data. They supply no plugin execution path. */
export function parsePolicyProfile(value: unknown): PolicyProfile {
	keys(value, ["schemaVersion", "id", "description", "metrics", "rules"], "Profile");
	if (value.schemaVersion !== 1) throw new Error("Profile requires schemaVersion 1");
	identifier(value.id, "Profile ID");
	if (value.description !== undefined && typeof value.description !== "string") throw new Error("Profile description must be text");
	return { schemaVersion: 1, id: value.id, ...(typeof value.description === "string" ? { description: value.description } : {}),
		metrics: metricEntries(value.metrics), rules: ruleEntries(value.rules) };
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (isJsonObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
}

export function policyProfileHash(profile: PolicyProfile): string { return hashBytes(JSON.stringify(canonical(profile))); }
