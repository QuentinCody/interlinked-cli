import type { AnalyzedFile } from "./analysis.js";
export interface ScoringEdge { from: string; to: string; line: number; names: string[]; typeOnly: boolean; }
export interface ScoringGraph {
    files: AnalyzedFile[]; edges: ScoringEdge[]; entries: string[]; publicEntries: string[];
    /** `reason` is set for an import that names a file; a computed (dynamic) specifier has `specifier: null` and no reason. */
    unresolved: { file: string; line: number; specifier: string | null; reason?: string }[]; dynamic: boolean;
    /** Single-file components (`.svelte`, `.vue`, `.astro`) that join the graph as importers; they are not measured. */
    components?: string[];
}
