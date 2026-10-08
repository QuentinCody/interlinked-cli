import { cosine, embeddingGeometry } from "./retrieval.js";
import { validateVectors } from "./runtime.js";
import type { EvidenceRecord, Json } from "./types.js";

export interface GeometryReport {
    version: 1;
    calibrated: false;
    modelIdentity: string;
    records: EvidenceRecord[];
}

function priorDistance(record: EvidenceRecord, vector: number[], identity: string): number | null {
    if (record.evidence.previousEmbedding === undefined) return null;
    if (record.evidence.previousEmbeddingModelIdentity !== identity)
        throw new Error("semantic churn requires the same pinned embedding model");
    const before = validateVectors([record.evidence.previousEmbedding], 1)[0]!;
    return 1 - cosine(before, vector);
}

function metricsWithGeometry(
    record: EvidenceRecord,
    geometry: Record<string, Json>,
): Record<string, Json> {
    const value = record.evidence.metrics;
    const metrics =
        value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    return { ...metrics, embeddingGeometry: geometry };
}

export function measureGeometry(records: EvidenceRecord[]): GeometryReport {
    if (!records.length || records.length > 200)
        throw new Error(
            "exact geometry requires 1..200 records; partition the population explicitly",
        );
    const identity = records[0]!.evidence.embeddingModelIdentity;
    if (
        typeof identity !== "string" ||
        !identity ||
        records.some((row) => row.evidence.embeddingModelIdentity !== identity)
    )
        throw new Error("geometry requires one pinned embedding model identity");
    if (new Set(records.map((row) => row.id)).size !== records.length)
        throw new Error("duplicate geometry unit IDs");
    const vectors = validateVectors(
        records.map((row) => row.evidence.embedding),
        records.length,
    );
    const groups = records.map((row) => String(row.evidence.cohesionGroup ?? row.file));
    const dispersion = new Map<string, number | null>();
    for (const group of new Set(groups))
        dispersion.set(
            group,
            embeddingGeometry(vectors.filter((_, i) => groups[i] === group)).meanCosineDistance,
        );
    const measured = records.map((row, i) => {
        const neighbors = records
            .map((candidate, j) => ({
                id: candidate.id,
                distance: 1 - cosine(vectors[i]!, vectors[j]!),
            }))
            .filter((candidate) => candidate.id !== row.id)
            .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
            .slice(0, 3);
        const geometry = {
            version: "embedding-geometry-v1",
            calibrated: false,
            modelIdentity: identity,
            semanticChurn: priorDistance(row, vectors[i]!, identity),
            group: groups[i]!,
            groupDispersion: dispersion.get(groups[i]!) ?? null,
            nearest: neighbors,
            outlierMeanDistance: neighbors.length
                ? neighbors.reduce((sum, neighbor) => sum + neighbor.distance, 0) / neighbors.length
                : null,
        };
        return {
            ...row,
            evidence: { ...row.evidence, metrics: metricsWithGeometry(row, geometry) },
            provenance: {
                ...row.provenance,
                metricsVersion: `${row.provenance.metricsVersion}|embedding-geometry-v1:${identity}`,
            },
        };
    });
    return { version: 1, calibrated: false, modelIdentity: identity, records: measured };
}
