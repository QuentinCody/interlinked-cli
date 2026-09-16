import { readResourceMemory } from "./resource-memory.js";

const GIB = 1024 ** 3;
const PROFILES = {
    heavy: { reserveFloor: GIB, reserveFraction: 1 / 8, ceiling: 4 * GIB, required: 2 * GIB },
    light: { reserveFloor: 2 * GIB, reserveFraction: 0, ceiling: GIB, required: GIB },
};
export interface ResourceBudget { reserveBytes: number; maxRssBytes: number; }

/** One heavy runner is a bounded tenant, even on a large model-development host. */
export function readResourceBudget(profile: "heavy" | "light" = "heavy"): ResourceBudget | null {
    const memory = readResourceMemory();
    if (!Number.isFinite(memory.totalBytes) || !Number.isFinite(memory.availableBytes) || memory.totalBytes <= 0) return null;
    const policy = PROFILES[profile];
    const reserveBytes = Math.max(policy.reserveFloor, memory.totalBytes * policy.reserveFraction);
    // Linux guests report less usable RAM than their nominal allocation. A
    // proportional ceiling must not fall below the profile's admission floor.
    const proportionalCeiling = Math.max(policy.required, memory.totalBytes / 4);
    const maxRssBytes = Math.min(policy.ceiling, proportionalCeiling, memory.availableBytes - reserveBytes);
    return maxRssBytes >= policy.required ? { reserveBytes, maxRssBytes } : null;
}
