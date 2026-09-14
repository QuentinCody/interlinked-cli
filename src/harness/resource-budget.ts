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
    const maxRssBytes = Math.min(policy.ceiling, memory.totalBytes / 4, memory.availableBytes - reserveBytes);
    return maxRssBytes >= policy.required ? { reserveBytes, maxRssBytes } : null;
}
