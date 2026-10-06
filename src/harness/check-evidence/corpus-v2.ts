import { evidenceDigest } from "../finding-outcomes.js";
import type { CorpusHit, CorpusRecord } from "./corpus.js";
import { corpusProvenanceMatches, type CorpusProvenance } from "./corpus-provenance.js";
import { corpusResultDigest, corpusResultIntact } from "./corpus-integrity.js";

/** Exact snapshot + occurrence identity; moving a hit requires fresh review. */
export function buildBoundCorpusRecord(hits: readonly CorpusHit[], provenance: CorpusProvenance, previous?: CorpusRecord): CorpusRecord {
    const occurrences: Record<string, CorpusHit> = {};
    hits.forEach((hit, ordinal) => {
        const signature = evidenceDigest(JSON.stringify([provenance.detector, provenance.configuration,
            provenance.input, provenance.scope, hit.file, hit.line, hit.text, ordinal]));
        occurrences[signature] = hit;
    });
    const adjudications: CorpusRecord["adjudications"] = {};
    if (previous && corpusResultIntact(previous) && corpusProvenanceMatches(previous.provenance, provenance)) {
        for (const sig of Object.keys(occurrences)) {
            const prior = previous?.adjudications[sig];
            if (prior) adjudications[sig] = prior;
        }
    }
    const history = [...(previous?.history ?? [])];
    if (previous) {
        const { history: _history, ...snapshot } = previous;
        history.push(snapshot);
    }
    const record = { files_scanned: provenance.read, hits: Object.keys(occurrences).sort(), adjudications,
        occurrences, provenance, history };
    return { ...record, result_digest: corpusResultDigest(record) };
}
