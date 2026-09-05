import { createHash } from "node:crypto";

/** Experimental structural burden only; no authorship, model or local-cap input. */
export const STRUCTURE_PROFILE = {
    id: "interlinked-structure-js-ts-v1",
    scope: "authored-product-functions-v1",
    tokenizer: "interlinked-ts-ast-v1",
    documentation: "exclude-ast-jsdoc-v1",
    meanShare: .75,
    tailShare: .25,
    tailExposure: .10,
    halsteadVolumeFloor: 200,
    metrics: {
        cyclomatic: { weight: .25, knots: [[1, 0], [5, 0], [15, .25], [25, .60], [50, 1]] },
        cognitive: { weight: .25, knots: [[0, 0], [5, 0], [15, .25], [30, .65], [60, 1]] },
        tokens: { weight: 5 / 18, knots: [[0, 0], [150, 0], [300, .20], [500, .50], [1000, 1]] },
        difficulty: { weight: 2 / 9, knots: [[0, 0], [20, 0], [40, .25], [80, .65], [160, 1]] },
    },
} as const;

export type StructuralMetric = keyof typeof STRUCTURE_PROFILE.metrics;
export interface BurdenEntity { burden: number; exposure: number; }
export interface BurdenAggregate { score: number; mean: number; tail: number; exposure: number; }

export function scoreProfileHash(typescriptVersion: string | null): string {
    return createHash("sha256").update(JSON.stringify({ profile: STRUCTURE_PROFILE, typescriptVersion })).digest("hex");
}

export function interpolateBurden(value: number, knots: readonly (readonly [number, number])[]): number {
    if (!Number.isFinite(value)) throw new Error("A metric requires a finite measurement");
    const first = knots[0];
    if (!first) throw new Error("A metric requires normalization knots");
    if (value <= first[0]) return first[1];
    let previous = first;
    for (const next of knots.slice(1)) {
        if (value <= next[0]) return previous[1] + (next[1] - previous[1]) * (value - previous[0]) / (next[0] - previous[0]);
        previous = next;
    }
    return previous[1];
}

function validateEntity(entity: BurdenEntity): void {
    if (!Number.isFinite(entity.burden) || entity.burden < 0 || entity.burden > 1) throw new Error("Normalized burden must be between zero and one");
    if (!Number.isFinite(entity.exposure) || entity.exposure <= 0) throw new Error("An entity requires positive finite exposure");
}

/** Fractional exposure at the decile boundary prevents a tiny hotspot dominating. */
export function aggregateBurden(entities: readonly BurdenEntity[]): BurdenAggregate | null {
    for (const entity of entities) validateEntity(entity);
    const exposure = entities.reduce((sum, entity) => sum + entity.exposure, 0);
    if (exposure === 0) return null;
    const mean = entities.reduce((sum, entity) => sum + entity.burden * entity.exposure, 0) / exposure;
    const tailExposure = exposure * STRUCTURE_PROFILE.tailExposure;
    let remaining = tailExposure;
    let tailSum = 0;
    for (const entity of [...entities].sort((a, b) => b.burden - a.burden)) {
        const take = Math.min(remaining, entity.exposure);
        tailSum += take * entity.burden;
        remaining -= take;
        if (remaining <= 0) break;
    }
    const tail = tailSum / tailExposure;
    return { score: 100 * (STRUCTURE_PROFILE.meanShare * mean + STRUCTURE_PROFILE.tailShare * tail), mean: 100 * mean, tail: 100 * tail, exposure };
}
