export interface HistoryDocument {
    id: string;
    text: string;
    timestamp: string;
    fixCommit: string;
    sourceHash: string;
    vector?: number[];
    file?: string;
    labelSource?: string;
}

export function cosine(a: number[], b: number[]): number {
    if (!a.length || a.length !== b.length) throw new Error("incompatible vector dimensions");
    let dot = 0,
        aa = 0,
        bb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i]!,
            y = b[i]!;
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("non-finite embedding");
        dot += x * y;
        aa += x * x;
        bb += y * y;
    }
    if (aa === 0 || bb === 0) throw new Error("zero embedding");
    return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

function words(text: string): string[] {
    return (
        text
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .match(/[a-z0-9]+/g) ?? []
    );
}

export function bm25Scores(query: string, documents: { text: string }[]): number[] {
    const terms = [...new Set(words(query))];
    const bags = documents.map((doc) => words(doc.text));
    const average = bags.reduce((sum, bag) => sum + bag.length, 0) / Math.max(1, bags.length);
    return bags.map((bag) =>
        terms.reduce((score, term) => {
            const frequency = bag.filter((word) => word === term).length;
            if (!frequency) return score;
            const df = bags.filter((other) => other.includes(term)).length;
            const idf = Math.log(1 + (bags.length - df + 0.5) / (df + 0.5));
            return (
                score +
                (idf * frequency * 2.2) /
                    (frequency + 1.2 * (0.25 + (0.75 * bag.length) / Math.max(1, average)))
            );
        }, 0),
    );
}

function ranks(scores: number[]): Map<number, number> {
    return new Map(
        scores
            .map((score, index) => ({ score, index }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map((item, rank) => [item.index, rank + 1]),
    );
}

export function retrieve(
    query: { text: string; timestamp: string; vector?: number[]; sourceHash?: string },
    documents: HistoryDocument[],
    options: { method: "lexical" | "embedding" | "hybrid"; top: number },
) {
    const at = Date.parse(query.timestamp);
    if (!Number.isFinite(at)) throw new Error("retrieval query requires a valid timestamp");
    if (!Number.isSafeInteger(options.top) || options.top < 1 || options.top > 100)
        throw new Error("retrieval top must be 1..100");
    const eligible = documents.filter(
        (doc) =>
            Number.isFinite(Date.parse(doc.timestamp)) &&
            Date.parse(doc.timestamp) < at &&
            doc.sourceHash !== query.sourceHash,
    );
    const lexical = bm25Scores(query.text, eligible);
    const semantic =
        options.method === "lexical"
            ? []
            : eligible.map((doc) => {
                  if (!query.vector || !doc.vector)
                      throw new Error(
                          "embedding retrieval requires complete vectors from one pinned model",
                      );
                  return cosine(query.vector, doc.vector);
              });
    const lexRanks = ranks(lexical),
        semRanks = ranks(semantic);
    const results = eligible
        .map((document, i) => {
            let score = lexical[i] ?? 0;
            if (options.method === "embedding") score = semantic[i]!;
            if (options.method === "hybrid")
                score = 1 / (60 + lexRanks.get(i)!) + 1 / (60 + semRanks.get(i)!);
            return { document, score };
        })
        .filter((item) => options.method !== "lexical" || item.score > 0)
        .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
        .slice(0, options.top);
    return {
        method: options.method,
        eligible: eligible.length,
        excludedFuture: documents.filter((doc) => Date.parse(doc.timestamp) >= at).length,
        results,
        assessedFraction: eligible.length ? results.length / eligible.length : 0,
        coverageMeaning:
            "fraction of supplied eligible corpus retrieved; not recall over unknown consumers",
    };
}

export function embeddingGeometry(vectors: number[][]): {
    meanCosineDistance: number | null;
    distances: number[];
    calibrated: false;
} {
    if (!vectors.length) return { meanCosineDistance: null, distances: [], calibrated: false };
    const dimension = vectors[0]!.length;
    const center = Array<number>(dimension).fill(0);
    for (const vector of vectors) {
        if (vector.length !== dimension) throw new Error("incompatible geometry dimensions");
        for (let i = 0; i < dimension; i++) center[i]! += vector[i]! / vectors.length;
    }
    if (center.every((n) => n === 0))
        return { meanCosineDistance: null, distances: [], calibrated: false };
    const distances = vectors.map((vector) => 1 - cosine(vector, center));
    return {
        meanCosineDistance: distances.reduce((a, b) => a + b, 0) / distances.length,
        distances,
        calibrated: false,
    };
}
