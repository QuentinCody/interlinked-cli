import { QUERY_DIMENSIONS, type EvidenceAnswer, type EvidenceQuery, type EvidenceRecord, type SearchCoverage } from "./types.js";

/** ASCII folding agrees with SQLite lower(); non-ASCII characters remain literal. */
export function foldEvidenceText(value: string): string {
    return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
export function queryTerms(query: EvidenceQuery): string[] {
    return foldEvidenceText(query.text ?? "").trim().split(/\s+/u).filter(Boolean);
}
function validatePagination(query: EvidenceQuery): void {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1..1000");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("offset must be 0..100000");
}
export function validateEvidenceQuery(query: EvidenceQuery): void {
    const allowed: readonly string[] = [...QUERY_DIMENSIONS, "text", "file", "check", "since", "until", "limit", "offset"];
    for (const key of Object.keys(query)) if (!allowed.includes(key)) throw new Error(`unknown query field: ${key}`);
    for (const key of [...QUERY_DIMENSIONS, "text", "file", "check"] as const) {
        if (query[key] !== undefined && typeof query[key] !== "string") throw new Error(`${key} must be a string`);
    }
    for (const key of ["since", "until"] as const) {
        if (query[key] !== undefined && !Number.isFinite(query[key])) throw new Error(`${key} must be finite`);
    }
    if (query.since !== undefined && query.until !== undefined && query.since > query.until) throw new Error("since exceeds until");
    validatePagination(query);
}
export function matchesEvidence(record: EvidenceRecord, query: EvidenceQuery): boolean {
    for (const key of QUERY_DIMENSIONS) if (query[key] !== undefined && record[key] !== query[key]) return false;
    if (query.file !== undefined && !record.files.includes(query.file)) return false;
    if (query.check !== undefined && !record.checks.includes(query.check)) return false;
    if (query.since !== undefined && (record.time === null || record.time < query.since)) return false;
    if (query.until !== undefined && (record.time === null || record.time > query.until)) return false;
    const text = foldEvidenceText(record.text);
    return queryTerms(query).every((term) => text.includes(term));
}
export function compareEvidence(left: Pick<EvidenceRecord, "id" | "time">, right: Pick<EvidenceRecord, "id" | "time">): number {
    const date = (right.time ?? -Infinity) - (left.time ?? -Infinity);
    return (Number.isNaN(date) ? 0 : date) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
/** Full ID sets are intentional in evaluation mode; returned payload rows stay bounded. */
export class EvidenceResults {
    private readonly seen = new Set<string>();
    private readonly selected: EvidenceRecord[] = [];
    constructor(private readonly query: EvidenceQuery) { validateEvidenceQuery(query); }
    add(record: EvidenceRecord, searchText?: string): void {
        const candidate = searchText === undefined ? record : { ...record, text: searchText };
        if (!matchesEvidence(candidate, this.query) || this.seen.has(record.id)) return;
        this.seen.add(record.id);
        this.selected.push(record);
        this.selected.sort(compareEvidence);
        if (this.selected.length > (this.query.offset ?? 0) + (this.query.limit ?? 20)) this.selected.pop();
    }
    answer(engine: string, coverage: SearchCoverage): EvidenceAnswer {
        return { engine, total: this.seen.size, ids: [...this.seen].sort(), rows: this.selected.slice(this.query.offset ?? 0), coverage };
    }
}
