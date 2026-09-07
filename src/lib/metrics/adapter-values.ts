import { METRIC_CATALOG } from "./catalog-metrics.js";
import { hashBytes } from "./inventory.js";
import type { InventoryFile, MeasurementState, MetricReading, QualityFinding } from "./measurement-types.js";
import { interpolateBurden } from "./score-profile.js";

export function emptyReading(id: string, state: MeasurementState, eligibleEntities: number, reason: string): MetricReading {
    return { id, state, value: null, numerator: null, denominator: null, score: null,
        measuredEntities: 0, eligibleEntities, evidenceIds: [], limitations: [reason] };
}

export function valueReading(id: string, value: number, entities: number): MetricReading {
    const definition = METRIC_CATALOG.find(metric => metric.id === id);
    if (!definition) throw new Error(`Unknown metric ${id}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid value for ${id}`);
    return { id, value, state: "measured", numerator: null, denominator: null,
        score: 100 * interpolateBurden(value, definition.knots), measuredEntities: entities,
        eligibleEntities: entities, evidenceIds: [], limitations: [] };
}

export function ratioReading(id: string, numerator: number, denominator: number): MetricReading {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator < 0 || denominator < numerator) {
        throw new Error(`Invalid numerator/denominator for ${id}`);
    }
    if (denominator === 0) return emptyReading(id, "not-applicable", 0, "No eligible opportunities in the measured scope");
    return { ...valueReading(id, 100 * numerator / denominator, denominator), numerator, denominator };
}

export interface FindingInput {
    metric: string; file: InventoryFile; line: number; endLine?: number; message: string;
    severity?: "error" | "warning"; evidence?: "proven" | "heuristic"; related?: string[];
}

export function qualityFinding(input: FindingInput): QualityFinding {
    const { file, metric, line, message } = input;
    return { id: hashBytes(JSON.stringify([metric, file.path, file.sha256, line, message])),
        metric, file: file.path, sourceSha256: file.sha256, line, endLine: input.endLine ?? line,
        message, severity: input.severity ?? "warning", evidence: input.evidence ?? "heuristic",
        related: input.related ?? [] };
}
