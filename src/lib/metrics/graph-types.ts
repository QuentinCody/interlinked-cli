import type { AnalyzedFile } from "./analysis.js";
export interface ScoringEdge { from: string; to: string; line: number; names: string[]; typeOnly: boolean; }
export interface ScoringGraph {
    files: AnalyzedFile[]; edges: ScoringEdge[]; entries: string[]; publicEntries: string[];
    unresolved: { file: string; line: number; specifier: string | null }[]; dynamic: boolean;
}
