import { createHash } from "node:crypto";
import type { CorpusRecord } from "./corpus.js";

/** Detect accidental/manual result edits. A local checksum is not an authority signature. */
export function corpusResultDigest(record: CorpusRecord): string {
    const occurrences = Object.entries(record.occurrences ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const payload = [record.provenance, record.files_scanned, [...record.hits].sort(), occurrences];
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
export function corpusResultIntact(record: CorpusRecord): boolean {
    if (!record.result_digest || !record.occurrences) return false;
    const keys = Object.keys(record.occurrences).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...record.hits].sort())) return false;
    return record.result_digest === corpusResultDigest(record);
}
