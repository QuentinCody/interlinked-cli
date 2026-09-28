import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import { resolve } from "node:path";
import type { QualityCheckResult } from "./quality-checks/result-types.js";

const sessions = new WeakMap<object, Map<string, string>>();
const MAX_FEEDBACK_KEYS = 256;

function checkIdentity(result: QualityCheckResult): string {
    if (result.name === "external_check_deferred") return result.message.match(/\(([^()]+)\)\s*$/)?.[1] ?? result.name;
    return result.name.replace(/_deferred$/, "");
}

/** Delivery only: raw results and missing evidence must be retained by callers. */
export function novelQualityFeedback(session: object, scope: string, results: QualityCheckResult[], completed: readonly string[], checkedFile?: string): QualityCheckResult[] {
    let seen = sessions.get(session);
    if (!seen) { seen = new Map(); sessions.set(session, seen); }
    const deferred = new Set(results.filter(result => isOperationalCheckDeferral(result.name)).map(checkIdentity));
    for (const check of completed) if (!deferred.has(check)) seen.delete(`${scope}\0${check}`);
    if (checkedFile) clearResolvedFeedback(seen, scope, checkedFile, results, completed);
    return results.filter(result => {
        if (result.severity === "error" && result.writeAttribution !== "observed-workspace") return true;
        const key = isOperationalCheckDeferral(result.name)
            ? `${scope}\0${checkIdentity(result)}` : findingKey(scope, result);
        const reason = normalizeDiagnostic(result.detail ?? result.message);
        if (seen.get(key) === reason) return false;
        if (seen.size >= MAX_FEEDBACK_KEYS) seen.delete(seen.keys().next().value!);
        seen.set(key, reason);
        return true;
    });
}

function normalizeDiagnostic(text: string): string {
    return text.replace(/\d+\.\d+s\b/g, "<duration>")
        .replace(/\(\d+(?:,\d+)*\)(?=:)/g, "(<line>)")
        .replace(/\bL\d+\b/g, "L<line>").trim();
}

function findingKey(scope: string, result: QualityCheckResult): string {
    const root = scope.split("\0")[0] || process.cwd();
    return `${scope}\0${result.name}\0${resolve(root, result.file || ".")}\0${normalizeDiagnostic(result.message)}`;
}

function clearResolvedFeedback(seen: Map<string, string>, scope: string, file: string, results: QualityCheckResult[], completed: readonly string[]): void {
    const root = scope.split("\0")[0] || process.cwd();
    for (const check of completed) {
        if (results.some(result => checkIdentity(result) === check)) continue;
        const prefix = `${scope}\0${check}\0${resolve(root, file)}\0`;
        for (const key of seen.keys()) if (key.startsWith(prefix)) seen.delete(key);
    }
}

/** Presentation copies only; full diagnostics stay in captured check results. */
export function compactQualityResults(results: readonly QualityCheckResult[], detailPath = ".interlinked/check-results.jsonl"): QualityCheckResult[] {
    return results.map(result => {
        const { detail, ...copy } = result;
        if (result.novelty === "pre-existing") return {
            ...copy, message: `${result.name}: ${result.findingCount ?? 1} pre-existing issue(s)${result.file ? ` for ${result.file}` : ""}; full details in ${detailPath}`,
        };
        const observed = result.writeAttribution === "observed-workspace" ? "Observed workspace state (writer unknown): " : "";
        const lines = detail?.split("\n") ?? [];
        const abbreviated = lines.slice(0, 3).join("\n").slice(0, 1200);
        const tail = lines.length > 3 || (detail?.length ?? 0) > 1200
            ? `\n… full details in ${detailPath}` : "";
        return { ...copy, message: observed + copy.message, ...(detail ? { detail: abbreviated + tail } : {}) };
    });
}
