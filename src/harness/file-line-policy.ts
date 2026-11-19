import { relative, resolve } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { sourceRole } from "../lib/metrics/inventory-roles.js";
import { loadCheckPolicy } from "./check-policy.js";
import { maxLinesFor } from "./large-file-policy.js";
import { metricPolicyApplies, resolveMetricPolicy, type ResolvedMetricPolicy } from "./metric-policy.js";
import { recordHookObservations } from "./hook-observations.js";
import { checkLargeFileLineCountWrite } from "./pre-checks.js";
import type { HarnessEvent } from "./types.js";

function loadFileLinePolicy(root: string): ResolvedMetricPolicy {
	const policy = loadCheckPolicy(root), entry = policy.metrics?.["file.lines"];
	const resolved = resolveMetricPolicy(entry, { inheritedMode: "warn", canonicalThreshold: maxLinesFor(root), blockingSupported: false });
	return { ...resolved, configured: entry !== undefined,
		issues: [...resolved.issues, ...policy.metric_policy_issues?.filter(issue => issue.includes("file.lines")) ?? []] };
}

function configurationWarnings(policy: ResolvedMetricPolicy): string[] {
	return policy.issues.map(issue => `[interlinked:file-size] ${issue}`);
}

function applyFileLinePolicy(event: HarnessEvent, filePath: string, warning: string, policy: ResolvedMetricPolicy): string | null {
	const root = event.cwd || process.cwd(), path = relative(root, resolve(root, filePath)).replaceAll("\\", "/");
	if (policy.mode === "off" || !metricPolicyApplies(policy.scope, path, sourceRole(path))) return null;
	if (!policy.configured) return warning;
	const message = `${warning} (reporting target ${policy.threshold})`;
	recordHookObservations(event, [{ kind: "metric", check: "metric-policy:file.lines", file: path, message, delivered: policy.mode === "warn" }]);
	return policy.mode === "warn" ? message : null;
}

/** Existing projected growth comparison supplies the measurement before disposition. */
export function collectFileLineWriteAdvice(event: HarnessEvent, toolInput: JsonObject): string[] {
	const root = event.cwd || process.cwd(), policy = loadFileLinePolicy(root);
	const result = policy.configured
		? checkLargeFileLineCountWrite(toolInput, root, { threshold: policy.threshold ?? maxLinesFor(root),
			warningFor: (file, warning) => applyFileLinePolicy(event, file, warning, policy) })
		: checkLargeFileLineCountWrite(toolInput, root);
	const warnings = configurationWarnings(policy);
	if (result?.warning) warnings.push(result.warning);
	return warnings;
}

/** Post-write and read feedback share the same configured reporting target and scope. */
export function collectObservedFileLineAdvice(event: HarnessEvent, filePath: string, lineCount: number): string[] {
	const policy = loadFileLinePolicy(event.cwd || process.cwd()), target = policy.threshold;
	const warnings = configurationWarnings(policy);
	if (target === null || lineCount <= target) return warnings;
	const legacy = `[interlinked:file-size] advisory: ${filePath} is ${lineCount} lines — over the ${target}-line review preference. Review responsibilities; do not compress formatting to reduce this count.`;
	const advice = applyFileLinePolicy(event, filePath, legacy, policy);
	if (advice) warnings.push(advice);
	return warnings;
}
