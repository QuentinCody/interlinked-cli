import type { BaselineGamingFinding } from "./baseline-integrity-gate.js";
import { isJsonObject } from "../../lib/json-types.js";

function object(value: unknown): Record<string, unknown> {
    return isJsonObject(value) ? value : {};
}

/** Existing scopes may only shrink; first adoption of another scope retains prior history. */
export function detectLintBaselineGaming(file: string, before: unknown, after: unknown): BaselineGamingFinding[] {
    const previous = object(object(before).entries);
    const next = object(object(after).entries);
    const findings: BaselineGamingFinding[] = [];
    for (const scope of Object.keys(previous)) {
        if (!Object.hasOwn(next, scope)) findings.push({ file, rule: "lint-scope-removed", before: scope, after: undefined, message: `Removing lint scope ${scope} permits debt to be reseeded; retain its baseline history.` });
    }
    for (const [scope, raw] of Object.entries(next)) {
        if (!Object.hasOwn(previous, scope)) continue;
        const oldCounts = object(previous[scope]);
        for (const [fingerprint, value] of Object.entries(object(raw))) {
            const old = typeof oldCounts[fingerprint] === "number" ? oldCounts[fingerprint] : 0;
            if (typeof value !== "number" || value <= old) continue;
            findings.push({ file, rule: "lint-allowance-increased", before: old, after: value, message: `Lint allowance increased for adopted scope ${scope}. Fix new findings; existing allowances may only decrease.` });
        }
    }
    return findings;
}
