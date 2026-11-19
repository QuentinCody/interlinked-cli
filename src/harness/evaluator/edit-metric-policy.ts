import { readSharedConfig } from "../../lib/config.js";
import { isJsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import type { HarnessEvent } from "../types.js";
import type { ResolvedMetricPolicy } from "../metric-policy.js";
import { recordHookObservations } from "../hook-observations.js";

/** Apply disposition after measurement and eligibility comparison have completed. */
export function applyStructuralMetricPolicy(event: HarnessEvent, metric: string, result: { block: string } | null, policy: ResolvedMetricPolicy, warnings: string[]): string | null {
	for (const issue of policy.issues) {
		const warning = `[interlinked:edit-metrics] ${issue}`;
		if (!warnings.includes(warning)) warnings.push(warning);
	}
	if (!result || policy.mode === "off") return null;
	if (policy.mode === "block") return result.block;
	const details = result.block.split("\n").map(line => line.trim()).filter(line => line.startsWith("•")).slice(0, 3).join(" | ");
	const target = policy.thresholdKind === "reporting-target" ? `reporting target ${policy.threshold}` : `canonical cap ${policy.threshold}`;
	const message = `${metric} projected edit comparison exceeds ${target}. ${details}`;
	if (policy.mode === "warn") warnings.push(`[interlinked:edit-metrics] Advisory ${message} Review cohesive responsibilities and preserved behavior.`);
	recordHookObservations(event, [{ kind: "metric", check: `metric-policy:${metric}`, message, delivered: policy.mode === "warn" }]);
	return null;
}

/** Counts are deterministic; a size/complexity threshold is a design policy.
 * Keep measurements and baselines intact while making edit interruptions opt-in. */
export function applyEditMetricPolicy(result: HarnessDecision | null, cwd: string, warnings: string[]): HarnessDecision | null {
    if (!result) return null;
    const policy = readSharedConfig(cwd)?.harness?.edit_metrics;
    if (isJsonObject(policy) && policy.mode === "enforced") return result;
    if (policy !== undefined && (!isJsonObject(policy) || policy.mode !== "advisory")) {
        warnings.push("[interlinked:edit-metrics] Invalid edit_metrics policy; retaining enforcement. Use mode advisory or enforced.");
        return result;
    }
    const findings = (result.reason ?? "").split("\n").map(line => line.trim()).filter(line => line.startsWith("•"));
    const measured = findings.map(line => line.replace(/, over the.*$/, ")"));
    const details = measured.length ? measured.slice(0, 3).join("; ") : `Configured ${result.rule_id ?? "structural metric"} exceeded`;
    warnings.push(`[interlinked:edit-metrics] Advisory: ${details}. Review whether decomposition improves clarity; do not add helpers solely to satisfy a count. Full metric limits and baselines remain available through interlinked caps status.`);
    return null;
}
