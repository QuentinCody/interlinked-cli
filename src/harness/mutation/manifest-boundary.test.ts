import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispositionOf } from "./disposition.js";
import { clearManifestCache, loadManifestState, mutationManifestPath } from "./manifest.js";
import type { MutantRecord, SymbolRecord } from "./types.js";

let dir: string;
const mutant: MutantRecord = {
    mutantId: "m1", siteId: "site1", mutator: "EqualityOperator", originalLexeme: "===",
    replacement: "!==", ordinalWithinSymbol: 0, status: "equivalent", firstSeen: "2026-01-01",
    accepted_reason: "historical review text",
};
const symbol: SymbolRecord = {
    symbolId: "s1", qualifiedName: "example", symbolHash: "hash",
    mutants: { m1: mutant },
    instability: { events: [], consecutiveStableRuns: 1, quarantined: false },
};

beforeEach(() => {
    clearManifestCache();
    dir = mkdtempSync(join(tmpdir(), "manifest-boundary-"));
});
afterEach(() => {
    clearManifestCache();
    rmSync(dir, { recursive: true, force: true });
});

describe("manifest persisted value boundary", () => {
    it.each([
        { files: { "src/bad.ts": false } },
        { files: { "src/bad.ts": { s1: { ...symbol, symbolHash: 4 } } } },
        { files: { "src/bad.ts": { s1: { ...symbol, mutants: null } } } },
        { files: { "src/bad.ts": { s1: { ...symbol, mutants: { m1: { ...mutant, status: "pending" } } } } } },
        { files: { "src/bad.ts": { s1: { ...symbol, instability: { ...symbol.instability, events: [{ at: "t", kind: "unknown" }] } } } } },
        { fileProvenance: { "src/good.ts": { at: "t", scope: "unknown", testCount: "1", surface: "measure" } } },
    ])("marks malformed nested data corrupt without losing existing bytes: %j", (invalid) => {
        const contents = JSON.stringify({ version: 1, files: { "src/good.ts": { s1: symbol } }, ...invalid });
        const path = mutationManifestPath(dir);
        writeFileSync(path, contents);
        expect(loadManifestState(dir)).toMatchObject({ kind: "corrupt", detail: expect.any(String) });
        expect(readFileSync(path, "utf8")).toBe(contents);
    });

    it.each([undefined, "legacy-unrecognized", { kind: "newer_build", evidence: [1, 2] }, { kind: "proved_equivalent" }])(
        "preserves unknown/partial disposition and legacy prose without accepting a new proof: %j", (disposition) => {
            const recorded = { ...mutant, disposition };
            const contents = JSON.stringify({ version: 1, files: { "src/good.ts": { s1: { ...symbol, mutants: { m1: recorded } } } } });
            const path = mutationManifestPath(dir);
            writeFileSync(path, contents);
            const state = loadManifestState(dir);
            expect(state.kind).toBe("valid");
            if (state.kind !== "valid") throw new Error(state.kind);
            const retained = state.manifest.files["src/good.ts"]?.s1?.mutants.m1;
            expect(retained).toEqual(JSON.parse(JSON.stringify(recorded)));
            if (!retained) throw new Error("missing retained mutant");
            expect(dispositionOf(retained)).toMatchObject({
                source: "legacy_prose", legacyReason: "historical review text", disposition: { kind: "unresolved" },
            });
            expect(readFileSync(path, "utf8")).toBe(contents);
        },
    );
});
