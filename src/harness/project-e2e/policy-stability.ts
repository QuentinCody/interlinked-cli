// ===========================================
// Scenario `stability` block — plan §9.5 / §14 (Unit E1)
// ===========================================
// Sibling of policy.ts (kept out of it by the line cap). `stability {}` adopts
// the default of three independent qualification runs; a fixed clock must be
// an ISO instant so it can be handed to every owned process verbatim.

import type { E2eStability } from "./policy.js";

const MAX_QUALIFICATION_RUNS = 5;
const DEFAULT_QUALIFICATION_RUNS = 3;
const SEED = /^[A-Za-z0-9_.:-]{1,64}$/;
const KEYS = ["qualificationRuns", "seed", "clock"];

function fail(message: string): never { throw new Error(`e2e policy: ${message}`); }
function runsOf(row: Record<string, unknown>, where: string): number {
    const runs = row.qualificationRuns === undefined ? DEFAULT_QUALIFICATION_RUNS : row.qualificationRuns;
    if (!Number.isInteger(runs) || Number(runs) < 1 || Number(runs) > MAX_QUALIFICATION_RUNS) fail(`${where}.qualificationRuns must be an integer from 1 to ${MAX_QUALIFICATION_RUNS}`);
    return Number(runs);
}
function seedOf(value: unknown, where: string): string {
    if (typeof value !== "string" || !SEED.test(value)) fail(`${where}.seed must match ${SEED}`);
    return value;
}
function clockOf(value: unknown, where: string): string {
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${where}.clock must be an ISO-8601 instant`);
    return value;
}
export function parseStability(value: unknown, where: string): E2eStability {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
    // SAFETY: the guard above proves a non-null, non-array object.
    const row = value as Record<string, unknown>;
    for (const key of Object.keys(row)) if (!KEYS.includes(key)) fail(`${where} has unknown key "${key}"`);
    const result: E2eStability = { qualificationRuns: runsOf(row, where) };
    if (row.seed !== undefined) result.seed = seedOf(row.seed, where);
    if (row.clock !== undefined) result.clock = clockOf(row.clock, where);
    return result;
}
