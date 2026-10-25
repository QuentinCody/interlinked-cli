import type { Block } from "./selection.mjs";
export type Category = "mixed" | "file_reads" | "search" | "test_build" | "structured_data" | "history" | "diffs_status";
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z_0-9]{2,}/g) ?? []);
export function codeScores(category: Category, blocks: Block[], question: string): Record<string, number> {
    const query = words(question);
    return Object.fromEntries(blocks.map(block => {
        const terms = words(block.text);
        let value = [...query].filter(word => terms.has(word)).length / Math.max(1, query.size);
        if (category === "test_build" && /\b(?:tests?|suites?)\s*[: ]|exit(?: code)?|failed|error|timeout/i.test(block.text)) value += 0.5;
        if (category === "file_reads" && /^\s*(?:export |async )*(?:function|class|interface|type)\b/m.test(block.text)) value += 0.1;
        if (category === "search" && /^[^:\n]+\.[a-z]+:\d+/m.test(block.text)) value += 0.1;
        if (category === "history" && /receipt|source.version|exit.code|timestamp/i.test(block.text)) value += 0.1;
        if (category === "structured_data" && /"(?:errors?|status|total|count|next_cursor)"\s*:/i.test(block.text)) value += 0.1;
        return [block.id, Math.min(1, value)];
    }));
}
/** Caller-supplied real embeddings. Never generate substitute "semantic" vectors. */
export function vectorShortlist(query: number[], vectors: Record<string, number[]>, count: number, pins: string[]): string[] {
    if (!query.length || !query.every(Number.isFinite) || Math.hypot(...query) === 0) throw new Error("Invalid query vector");
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid shortlist size");
    const norm = Math.hypot(...query);
    const scored = Object.entries(vectors).map(([id, vector]) => {
        if (vector.length !== query.length || !vector.every(Number.isFinite) || Math.hypot(...vector) === 0) throw new Error("Invalid candidate vector");
        const similarity = vector.reduce((sum, value, i) => sum + value * (query[i] ?? 0), 0) / (Math.hypot(...vector) * norm);
        return { id, similarity };
    });
    return [...new Set([...scored.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, count).map(row => row.id), ...pins])];
}
/** Named field projection is exact; omitted field count stays explicit. */
export function projectJson(text: string, fields: string[]): { value: Record<string, unknown>; omittedFields: number } {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Projection requires an object");
    const entries = Object.entries(value); const requested = new Set(fields);
    return { value: Object.fromEntries(entries.filter(([key]) => requested.has(key))), omittedFields: entries.filter(([key]) => !requested.has(key)).length };
}

