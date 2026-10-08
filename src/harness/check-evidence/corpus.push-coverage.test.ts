import { describe, expect, it } from "vitest";
import { corpusSatisfied, parseCorpusStore } from "./corpus.js";
import { corpusResultDigest } from "./corpus-integrity.js";
import type { CorpusProvenance } from "./corpus-provenance.js";
import { buildBoundCorpusRecord } from "./corpus-v2.js";

const provenance: CorpusProvenance = {
    schema: "corpus-scan.v2", detector: "detector", configuration: "raw", input: "input",
    scope: "source-and-tests", search_root: "src", run: "run", timestamp: "now",
    discovered: 1, eligible: 1, read: 1, executed: 1, complete: true, exclusions: [], failures: [],
};

describe("persisted corpus validation", () => {
    it("discards malformed occurrence rows and history without discarding valid evidence", () => {
        const historical = { files_scanned: 1, hits: [], adjudications: {} };
        const store = parseCorpusStore({ version: 2, checks: { check: {
            ...historical,
            occurrences: {
                valid: { file: "src/a.ts", line: 2, text: "finding" },
                nullRow: null, invalidFile: { file: 1, line: 2, text: "finding" },
                invalidText: { file: "a.ts", line: 2, text: false },
                invalidLine: { file: "a.ts", line: "2", text: "finding" },
            },
            history: [null, { hits: [false] }, { ...historical, history: [historical] }],
        } } });
        expect(store.checks.check).toEqual({ ...historical,
            occurrences: { valid: { file: "src/a.ts", line: 2, text: "finding" } }, history: [historical] });
    });

    it.each([0, -1, 1.5, Number.NaN])("rejects intact records with invalid scanned count %s", (files_scanned) => {
        const record = { ...buildBoundCorpusRecord([], provenance), files_scanned };
        record.result_digest = corpusResultDigest(record);
        expect(corpusSatisfied(record, provenance)).toBe(false);
    });

    it("rejects a checksummed record whose scan count contradicts its provenance", () => {
        const record = { ...buildBoundCorpusRecord([], provenance), files_scanned: 2 };
        record.result_digest = corpusResultDigest(record);
        expect(corpusSatisfied(record, provenance)).toBe(false);
    });
});
