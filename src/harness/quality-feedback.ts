import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";

const sessions = new WeakMap<object, Map<string, string>>();
const MAX_FEEDBACK_KEYS = 256;

function checkIdentity(result: QualityCheckResult): string {
    if (result.name === "external_check_deferred") return result.message.match(/\(([^()]+)\)\s*$/)?.[1] ?? result.name;
    return result.name.replace(/_deferred$/, "");
}

/** Delivery only: raw results and missing evidence must be retained by callers. */
export function novelQualityFeedback(session: object, scope: string, results: QualityCheckResult[], completed: readonly string[]): QualityCheckResult[] {
    let seen = sessions.get(session);
    if (!seen) { seen = new Map(); sessions.set(session, seen); }
    const deferred = new Set(results.filter(result => isOperationalCheckDeferral(result.name)).map(checkIdentity));
    for (const check of completed) if (!deferred.has(check)) seen.delete(`${scope}\0${check}`);
    return results.filter(result => {
        if (!isOperationalCheckDeferral(result.name)) return true;
        const key = `${scope}\0${checkIdentity(result)}`;
        const reason = (result.detail ?? result.message).replace(/\d+\.\d+s\b/g, "<duration>").trim();
        if (seen.get(key) === reason) return false;
        if (seen.size >= MAX_FEEDBACK_KEYS) seen.delete(seen.keys().next().value!);
        seen.set(key, reason);
        return true;
    });
}
