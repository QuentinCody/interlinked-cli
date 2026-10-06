import { expect, it } from "vitest";
import { buildBoundCorpusRecord } from "./corpus-v2.js";
import { corpusSatisfied } from "./corpus.js";
import type { CorpusProvenance } from "./corpus-provenance.js";
const binding: CorpusProvenance = { schema: "corpus-scan.v2", detector: "d", configuration: "c", input: "i",
    scope: "source", search_root: "src", run: "r", timestamp: "2026-10-05T00:00:00Z", discovered: 1,
    eligible: 1, read: 1, executed: 1, complete: true, exclusions: [], failures: [] };
it("rejects removal of recorded hits, including removing their occurrence map", () => {
    const row = buildBoundCorpusRecord([{ file: "a.ts", line: 1, text: "bad" }], binding);
    expect(corpusSatisfied({ ...row, hits: [] }, binding)).toBe(false);
    expect(corpusSatisfied({ ...row, hits: [], occurrences: {} }, binding)).toBe(false);
    row.adjudications[row.hits[0]!] = { verdict: "false_positive", note: "reviewed" };
    expect(corpusSatisfied(row, binding)).toBe(true);
});
