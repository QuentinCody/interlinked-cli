import { readFileSync } from "node:fs";
import { join } from "node:path";
import { corpusRecords, readCorpusEvidence, scanCorpus, verifyCorpus } from "./corpus.js";
import { searchLegacyIndex } from "./legacy.js";
import { searchBoundedIndex, searchCompactIndex } from "./sqlite.js";
import { DirectoryEvidenceStore } from "./object-store.js";
import { parseSegmentManifest, searchSegments } from "./segments.js";
import { emptyCoverage, type EvidenceAnswer, type EvidenceQuery } from "./types.js";
import type { EvidenceEngine } from "./benchmark-worker.js";

export async function executeLabQuery(corpus: string, engine: EvidenceEngine, index: string | undefined, query: EvidenceQuery): Promise<EvidenceAnswer> {
    await verifyCorpus(corpus);
    if (engine === "scan" || engine === "gzip") return scanCorpus(corpus, query);
    if (!index) throw new Error("--index is required for this engine");
    if (engine === "legacy") return searchLegacyIndex(index, query);
    if (engine === "compact") return searchCompactIndex(index, query);
    if (engine === "bounded") return searchBoundedIndex(index, corpus, query);
    if (engine === "segments") return searchSegments(parseSegmentManifest(JSON.parse(readFileSync(join(index, "segments.json"), "utf8"))), new DirectoryEvidenceStore(join(index, "objects")), query);
    throw new Error("use the cloud query API or benchmark command with --endpoint");
}
export async function showLabEvidence(corpus: string, id: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid evidence ID");
    await verifyCorpus(corpus);
    for await (const record of corpusRecords(corpus, emptyCoverage())) {
        if (record.id === id) return readCorpusEvidence(corpus, record);
    }
    throw new Error("evidence ID not found in this corpus");
}
