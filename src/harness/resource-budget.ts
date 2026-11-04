import { readResourceMemory } from "./resource-memory.js";
import { darwinMemoryDiagnostics } from "./resource-memory-darwin.js";

const GIB = 1024 ** 3;
const PROFILES = {
    heavy: { reserveFloor: GIB, reserveFraction: 1 / 8, ceiling: 4 * GIB, required: 2 * GIB },
    light: { reserveFloor: 2 * GIB, reserveFraction: 0, ceiling: GIB, required: GIB },
};
export interface ResourceBudget { reserveBytes: number; maxRssBytes: number; }

/** One heavy runner is a bounded tenant, even on a large model-development host. */
export function readResourceBudget(profile: "heavy" | "light" = "heavy"): ResourceBudget | null {
    return resourceBudgetSnapshot(profile).budget;
}

/** Explain refusal using the same sample and unchanged policy used for admission. */
export function resourceBudgetSnapshot(profile: "heavy" | "light" = "heavy") {
    const memory = readResourceMemory();
    const policy = PROFILES[profile];
    const reserveBytes = Math.max(policy.reserveFloor, memory.totalBytes * policy.reserveFraction);
    // Linux guests report less usable RAM than their nominal allocation. A
    // proportional ceiling must not fall below the profile's admission floor.
    const proportionalCeiling = Math.max(policy.required, memory.totalBytes / 4);
    const maxRssBytes = Math.min(policy.ceiling, proportionalCeiling, memory.availableBytes - reserveBytes);
    const valid = Number.isFinite(memory.totalBytes) && Number.isFinite(memory.availableBytes) && memory.totalBytes > 0 && memory.availableBytes >= 0;
    const budget = valid && maxRssBytes >= policy.required ? { reserveBytes, maxRssBytes } : null;
    return { ...memory, profile, reserveBytes, requiredBytes: policy.required, ceilingBytes: policy.ceiling,
        budget, reason: !valid ? "memory_telemetry_unavailable" : budget ? "admitted" : "insufficient_effective_headroom",
        native: darwinMemoryDiagnostics() };
}
