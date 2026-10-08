import { join } from "node:path";
import { candidateConsumers } from "./corpus.js";
import { bm25Scores, cosine } from "./retrieval.js";
import { embedInputs } from "./runtime.js";
import type { DecisionConfig, EvidenceRecord } from "./types.js";

type Method = "lexical" | "embedding" | "hybrid";
function rank(scores: number[]): number[] {
    const positions: number[] = [];
    scores
        .map((score, i) => ({ score, i }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .forEach((item, i) => {
            positions[item.i] = i + 1;
        });
    return positions;
}

function nearestIds(
    query: { text: string; vector?: number[] },
    consumers: EvidenceRecord[],
    vectors: number[][],
    method: Method,
): string[] {
    const lexical = bm25Scores(
        query.text,
        consumers.map((row) => ({ text: String(row.evidence.body ?? "") })),
    );
    const semantic = query.vector ? vectors.map((vector) => cosine(query.vector!, vector)) : [];
    const lexRank = rank(lexical),
        semRank = rank(semantic);
    const scores = consumers.map((row, i) => {
        let score = lexical[i]!;
        if (method === "embedding") score = semantic[i]!;
        if (method === "hybrid") score = 1 / (60 + lexRank[i]!) + 1 / (60 + semRank[i]!);
        return { id: row.id, score };
    });
    return scores
        .filter((row) => method !== "lexical" || row.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 3)
        .map((row) => row.id);
}

export async function discoverCandidates(
    root: string,
    changes: EvidenceRecord[],
    consumers: EvidenceRecord[],
    config: DecisionConfig,
    method: Method,
): Promise<EvidenceRecord[]> {
    // Candidate selection unloads the embedding model before the decision stage.
    const texts = [...changes, ...consumers].map((row) =>
        String(row.evidence.body ?? row.evidence.hunk ?? ""),
    );
    const embedded =
        method === "lexical"
            ? null
            : await embedInputs(
                  config,
                  [...changes, ...consumers].map((row, i) => ({
                      text: texts[i]!,
                      title: row.file,
                      role: i < changes.length ? "query" : "document",
                  })),
                  Date.now() + config.deadlineMs,
                  join(root, ".interlinked", "decision-metrics", "embeddings"),
              );
    const augmented = changes.map((change, i) => {
        const eligible = consumers
            .map((row, index) => ({ row, index }))
            .filter((item) => Date.parse(item.row.timestamp) <= Date.parse(change.timestamp));
        const vectors = embedded
            ? eligible.map((item) => embedded.vectors[changes.length + item.index]!)
            : [];
        const query: { text: string; vector?: number[] } = { text: texts[i]! };
        if (embedded) query.vector = embedded.vectors[i]!;
        const candidateIds = nearestIds(
            query,
            eligible.map((item) => item.row),
            vectors,
            method,
        );
        return {
            ...change,
            evidence: {
                ...change.evidence,
                candidateIds,
                candidateRetrieval: { method, modelIdentity: embedded?.identity ?? null, top: 3 },
            },
        };
    });
    return candidateConsumers(augmented, consumers);
}
