import { expect, it } from "vitest";
import { buildBoundCorpusRecord } from "./corpus-v2.js";
import { corpusSatisfied, parseCorpusStore } from "./corpus.js";
import type { CorpusProvenance } from "./corpus-provenance.js";
const provenance: CorpusProvenance = { schema: "corpus-scan.v2", detector: "d", configuration: "c", input: "i",
    scope: "source", search_root: "src", run: "r", timestamp: "now", discovered: 1, eligible: 1, read: 1,
    executed: 1, complete: true, exclusions: [], failures: [] };
it("distinguishes identical occurrences and preserves historical verdicts without reusing stale ones", () => {
    const hits = [{ file: "a.ts", text: "bad", line: 1 }, { file: "a.ts", text: "bad", line: 2 }];
    const first = buildBoundCorpusRecord(hits, provenance);
    expect(first.hits).toHaveLength(2);
    for (const id of first.hits) first.adjudications[id] = { verdict: "true_positive", note: "reviewed" };
    expect(corpusSatisfied(first, provenance)).toBe(true);
    const next = buildBoundCorpusRecord(hits, { ...provenance, detector: "new" }, first);
    expect(next.adjudications).toEqual({});
    expect(next.history?.[0]?.adjudications).toEqual(first.adjudications);
    expect(parseCorpusStore({ version: 2, checks: { c: next } }).checks.c).toEqual(next);
});
it("does not let an always-throwing scan or a legacy zero-hit scan qualify", () => {
    const record = buildBoundCorpusRecord([], { ...provenance, executed: 0, complete: false,
        failures: [{ file: "a.ts", message: "detector threw" }] });
    expect(corpusSatisfied(record, provenance)).toBe(false);
    expect(corpusSatisfied({ files_scanned: 100, hits: [], adjudications: {} }, provenance)).toBe(false);
});
it("rejects contradictory file counts and duplicate occurrence IDs", () => {
    const record = buildBoundCorpusRecord([{ file: "a.ts", text: "bad", line: 1 }], provenance);
    record.adjudications[record.hits[0]!] = { verdict: "true_positive" };
    expect(corpusSatisfied({ ...record, files_scanned: 2 }, provenance)).toBe(false);
    expect(corpusSatisfied({ ...record, hits: [record.hits[0]!, record.hits[0]!] }, provenance)).toBe(false);
});
