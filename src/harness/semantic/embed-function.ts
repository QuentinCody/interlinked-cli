export function normalizeVector(vector: Float32Array): Float32Array {
    let sum = 0;
    for (const value of vector) {
        if (!Number.isFinite(value)) throw new Error("embedding contains a non-finite value");
        sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || norm === 0) throw new Error("embedding has zero or invalid norm");
    return Float32Array.from(vector, (value) => value / norm);
}

export function aggregateFunctionVectors(
    vectors: Float32Array[],
    chunks: { weightTokens: number }[],
    dimension: number,
): Float32Array {
    if (vectors.length !== chunks.length) throw new Error("embedding runtime omitted a function chunk");
    const centroid = new Float32Array(dimension);
    let totalWeight = 0;
    for (let index = 0; index < vectors.length; index++) {
        const candidate = vectors[index];
        if (candidate === undefined) throw new Error("embedding runtime omitted a function chunk");
        const normalized = normalizeVector(candidate);
        if (normalized.length !== dimension) throw new Error("embedding dimension does not match the model manifest");
        const chunk = chunks[index];
        if (chunk === undefined) throw new Error("embedding runtime returned an unexpected function chunk");
        const weight = chunk.weightTokens;
        totalWeight += weight;
        for (let dimension = 0; dimension < centroid.length; dimension++) {
            centroid[dimension] = (centroid[dimension] ?? 0) + (normalized[dimension] ?? 0) * weight;
        }
    }
    if (totalWeight <= 0) throw new Error("function chunks have no aggregation weight");
    return normalizeVector(centroid);
}
