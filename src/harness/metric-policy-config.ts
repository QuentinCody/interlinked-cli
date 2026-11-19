import { readSharedConfig } from "../lib/config.js";
import { isJsonObject } from "../lib/json-types.js";
import { loadCheckPolicy, type CheckPolicy } from "./check-policy.js";
import { maxCognitiveFor, maxCyclomaticFor, maxFunctionTokensFor } from "./metric-caps.js";
import { metricPolicyWeakening, resolveMetricPolicy, type MetricPolicyMode, type ResolvedMetricPolicy } from "./metric-policy.js";

export const STRUCTURAL_METRIC_KEYS = ["cyclomatic", "cognitive", "function-tokens"] as const;
export type StructuralMetricKey = (typeof STRUCTURAL_METRIC_KEYS)[number];
export type StructuralMetricThresholds = Record<StructuralMetricKey, number>;

/** Legacy absence is advisory, while malformed explicit posture retains existing enforcement. */
export function inheritedStructuralMetricPolicy(value: unknown): { mode: MetricPolicyMode; issues: string[] } {
	if (value === undefined || isJsonObject(value) && value.mode === "advisory") return { mode: "warn", issues: [] };
	if (isJsonObject(value) && value.mode === "enforced") return { mode: "block", issues: [] };
	return { mode: "block", issues: ["Invalid edit_metrics policy; retaining enforcement. Use mode advisory or enforced."] };
}

function structuralMetricThresholds(cwd: string): StructuralMetricThresholds {
	return { cyclomatic: maxCyclomaticFor(cwd), cognitive: maxCognitiveFor(cwd), "function-tokens": maxFunctionTokensFor(cwd) };
}

/** Resolve layered policy without letting personal overrides weaken the team/inherited block. */
export function resolveStructuralMetricPolicy(
	policy: CheckPolicy,
	metric: StructuralMetricKey,
	inheritedMode: MetricPolicyMode,
	threshold: number,
): ResolvedMetricPolicy {
	const context = { inheritedMode, canonicalThreshold: threshold, blockingSupported: true };
	const team = policy.metric_policy_layers?.team?.[metric];
	const base = resolveMetricPolicy(team, context);
	const resolved = resolveMetricPolicy(policy.metrics?.[metric], context);
	const local = policy.metric_policy_layers?.local?.[metric];
	if (local && metricPolicyWeakening(base, resolved).length > 0) {
		return { ...base, issues: [...policy.metric_policy_issues ?? [], ...base.issues,
			`local: ${metric} override cannot weaken inherited or team blocking enforcement`] };
	}
	return { ...resolved, issues: [...policy.metric_policy_issues ?? [], ...resolved.issues] };
}

export function loadStructuralMetricPolicy(cwd: string, metric: StructuralMetricKey): ResolvedMetricPolicy {
	return loadStructuralMetricPolicies(cwd)[metric];
}

export function loadStructuralMetricPolicies(cwd: string): Record<StructuralMetricKey, ResolvedMetricPolicy> {
	const inherited = inheritedStructuralMetricPolicy(readSharedConfig(cwd)?.harness?.edit_metrics);
	const policy = loadCheckPolicy(cwd), thresholds = structuralMetricThresholds(cwd);
	const unsupported = Object.keys(policy.metrics ?? {}).filter(id => id !== "file.lines" && !STRUCTURAL_METRIC_KEYS.some(key => key === id))
		.map(id => `${id} policy is not applied by structural edit hooks`);
	const resolve = (metric: StructuralMetricKey): ResolvedMetricPolicy => {
		const resolved = resolveStructuralMetricPolicy(policy, metric, inherited.mode, thresholds[metric]);
		return { ...resolved, configured: policy.metrics?.[metric] !== undefined, issues: [...inherited.issues, ...unsupported, ...resolved.issues] };
	};
	return { cyclomatic: resolve("cyclomatic"), cognitive: resolve("cognitive"), "function-tokens": resolve("function-tokens") };
}
