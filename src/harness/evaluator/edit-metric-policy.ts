import { readSharedConfig } from "../../lib/config.js";
import { isJsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";

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
