import { expect, it } from "vitest";
import { corpusProvenanceMatches, corpusRuntimeRoot, type CorpusProvenance } from "./corpus-provenance.js";
const bound: CorpusProvenance = {
    schema: "corpus-scan.v2", detector: "build", configuration: "config", input: "tree", scope: "tests",
    search_root: "src", run: "r", timestamp: "2026-10-04T00:00:00.000Z", discovered: 2,
    eligible: 2, read: 2, executed: 2, complete: true, exclusions: [], failures: [],
};
it("requires complete positive scope and every current binding", () => {
    expect(corpusProvenanceMatches(bound, bound)).toBe(true);
    for (const key of ["detector", "configuration", "input", "scope", "search_root"] as const) {
        expect(corpusProvenanceMatches(bound, { ...bound, [key]: "changed" })).toBe(false);
    }
    for (const patch of [{ complete: false }, { eligible: 0 }, { executed: 1 }, { read: 1 },
        { failures: [{ file: "a.ts", message: "throw" }] }]) {
        expect(corpusProvenanceMatches({ ...bound, ...patch }, bound)).toBe(false);
    }
    expect(corpusProvenanceMatches(bound, undefined)).toBe(false);
});
it("locates source and bundled runtime bytes without climbing out of the package", () => {
    expect(corpusRuntimeRoot("/repo/src/harness/check-evidence/corpus-provenance.ts")).toEqual({ root: "/repo", code: "src" });
    expect(corpusRuntimeRoot("/repo/dist/chunk-ABC.js")).toEqual({ root: "/repo", code: "dist" });
});
