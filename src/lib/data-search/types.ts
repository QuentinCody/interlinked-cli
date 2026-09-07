/** Portable evidence contract. Payloads remain in original JSONL segments. */
export interface EvidenceRecord {
    id: string; hash: string; source: string; category: string;
    tenant: string; project: string; session: string | null; actor: string | null;
    provider: string | null; model: string | null; call: string | null;
    kind: string | null; decision: string | null; origin: string; time: number | null;
    files: string[]; checks: string[]; text: string; truncated: boolean;
    path: string; offset: number; end: number;
    object?: string;
    raw?: string;
}
export interface EvidenceQuery {
    text?: string; tenant?: string; project?: string; source?: string;
    category?: string; session?: string; actor?: string; provider?: string;
    model?: string; call?: string; kind?: string; decision?: string; origin?: string;
    file?: string; check?: string; since?: number; until?: number; limit?: number; offset?: number;
}
export interface SearchCoverage {
    complete: boolean; records: number; bytes: number; files: number;
    malformed: number; oversized: number; incomplete: number; truncated: number; errors: string[];
}
export interface EvidenceAnswer {
    ids: string[]; total: number; rows: EvidenceRecord[]; coverage: SearchCoverage; engine: string;
}
export interface CorpusFile {
    path: string; source: string; bytes: number; sha256: string; records: number; native: boolean;
}
export interface EvidenceCorpus {
    version: 1; tenant: string; project: string; created: string;
    kind: "synthetic" | "interlinked-snapshot" | "claude-snapshot";
    files: CorpusFile[]; complete: boolean; sampling: string;
}
export const QUERY_DIMENSIONS = ["tenant", "project", "source", "category", "session", "actor", "provider", "model", "call", "kind", "decision", "origin"] as const;
export function emptyCoverage(): SearchCoverage {
    return { complete: true, records: 0, bytes: 0, files: 0, malformed: 0, oversized: 0, incomplete: 0, truncated: 0, errors: [] };
}
