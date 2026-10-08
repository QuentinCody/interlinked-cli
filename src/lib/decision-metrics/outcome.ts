import type { MeasurementStatus } from "./types.js";

const RESULT_FIELDS = [
    "measurements",
    "judgments",
    "claims",
    "behavior",
    "omissions",
    "forward",
    "reverse",
    "rows",
    "obligation",
    "satisfaction",
    "observations",
    "run",
];
function states(value: unknown): MeasurementStatus[] {
    if (Array.isArray(value)) return value.flatMap(states);
    if (!value || typeof value !== "object") return [];
    if ("mode" in value && value.mode === "plan") return [];
    if (
        "schemaVersion" in value &&
        value.schemaVersion === 1 &&
        "contract" in value &&
        "status" in value
    ) {
        const state = value.status;
        if (
            state === "answered" ||
            state === "insufficient_evidence" ||
            state === "abstained" ||
            state === "failed" ||
            state === "unassessed"
        )
            return [state];
    }
    return Object.entries(value)
        .filter(([key]) => RESULT_FIELDS.includes(key))
        .flatMap(([, field]) => states(field));
}

export function decisionExitCode(value: unknown): number {
    if (value && typeof value === "object" && "runtimeFailure" in value) return 4;
    const outcomes = states(value);
    if (outcomes.includes("failed")) return outcomes.every((state) => state === "failed") ? 4 : 6;
    if (outcomes.includes("unassessed")) return 7;
    if (outcomes.includes("abstained") || outcomes.includes("insufficient_evidence")) return 3;
    return 0;
}
