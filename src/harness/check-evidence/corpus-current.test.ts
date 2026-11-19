import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import type { CheckRegistration } from "../check-registry/types.js";
import { qualifyCurrentCorpus } from "./corpus-current.js";
import { corpusSatisfied } from "./corpus.js";
import { captureDetectorSources } from "./detector-closure.js";

// Regression for the 2026-11-05 race: a concurrent edit to a src file the
// detector does not import used to void the cohort's corpus evidence (the
// identity hashed all of src/, and the scanned tree was read a second time).
describe("qualifyCurrentCorpus — concurrent edits during the scan", () => {
    let runtime: string;
    let scanned: string;
    const write = (root: string, rel: string, content: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content, "utf8");
    };
    const nan = nonNull(CHECK_REGISTRY.find(row => row.id === "nan_comparison"));
    /** The real nan detector under the runtime tree's exported name, with one edit on its first call. */
    function editingCheck(edit: () => void): CheckRegistration[] {
        let edited = false;
        const detectFake: CheckRegistration["fn"] = (content, filePath) => {
            if (!edited) { edited = true; edit(); }
            return nan.fn(content, filePath);
        };
        return [{ ...nan, fn: detectFake }];
    }
    beforeEach(() => {
        runtime = mkdtempSync(join(tmpdir(), "corpus-runtime-"));
        scanned = mkdtempSync(join(tmpdir(), "corpus-scanned-"));
        write(runtime, "package-lock.json", "{}");
        write(runtime, "src/checks/detector.ts", 'import { helper } from "./helper.js";\nexport const detectFake = helper;');
        write(runtime, "src/checks/helper.ts", "export function helper() { return []; }");
        write(runtime, "src/unrelated.ts", "export const unrelated = 1;");
        write(scanned, "src/a.ts", "export const x = 1;");
        write(scanned, "src/b.ts", "export const y = 2;");
    });
    afterEach(() => {
        rmSync(runtime, { recursive: true, force: true });
        rmSync(scanned, { recursive: true, force: true });
    });

    it("N1: an edit to an unrelated src file during the scan does not void the evidence", () => {
        const identity = captureDetectorSources(runtime);
        const registry = editingCheck(() => write(runtime, "src/unrelated.ts", "export const unrelated = 2;"));
        const result = qualifyCurrentCorpus(scanned, ["nan_comparison"], registry, identity);
        expect(result.records.nan_comparison?.provenance?.failures).toEqual([]);
        expect(corpusSatisfied(result.records.nan_comparison, result.bindings.nan_comparison)).toBe(true);
    });

    it("N2: an edit to a scanned input after the capture does not void the evidence of the bytes read", () => {
        const identity = captureDetectorSources(runtime);
        const registry = editingCheck(() => write(scanned, "src/b.ts", "export const y = 3;"));
        const result = qualifyCurrentCorpus(scanned, ["nan_comparison"], registry, identity);
        expect(corpusSatisfied(result.records.nan_comparison, result.bindings.nan_comparison)).toBe(true);
    });

    it("P1: an edit to a file the detector imports during the scan voids the evidence", () => {
        const identity = captureDetectorSources(runtime);
        const registry = editingCheck(() => write(runtime, "src/checks/helper.ts", "export function helper() { return [1]; }"));
        const result = qualifyCurrentCorpus(scanned, ["nan_comparison"], registry, identity);
        expect(result.records.nan_comparison?.provenance?.failures).toEqual([
            { file: "detector", message: "detector changed after runtime import" },
        ]);
        expect(corpusSatisfied(result.records.nan_comparison, result.bindings.nan_comparison)).toBe(false);
    });

    it("P2: an edit to the detector module itself during the scan voids the evidence", () => {
        const identity = captureDetectorSources(runtime);
        const registry = editingCheck(() => write(runtime, "src/checks/detector.ts", "export const detectFake = () => [];"));
        const result = qualifyCurrentCorpus(scanned, ["nan_comparison"], registry, identity);
        expect(corpusSatisfied(result.records.nan_comparison, result.bindings.nan_comparison)).toBe(false);
    });
});

it("qualifies clean edits without changing stored evidence and detects a hit even if the stored list was erased", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-current-"));
    const id = "nan_comparison";
    try {
        mkdirSync(join(root, "src")); mkdirSync(join(root, ".interlinked"));
        const store = join(root, ".interlinked/check-corpus.json");
        const original = JSON.stringify({ version: 1, checks: { [id]: { files_scanned: 999, hits: [], adjudications: {} } } });
        writeFileSync(store, original);
        for (const source of ["export const x = 1;", "export const x = 2;"]) {
            writeFileSync(join(root, "src/a.ts"), source);
            const result = qualifyCurrentCorpus(root, [id], CHECK_REGISTRY);
            expect(corpusSatisfied(result.records[id], result.bindings[id])).toBe(true);
        }
        writeFileSync(join(root, "src/a.ts"), "export const bad = value === NaN;");
        const result = qualifyCurrentCorpus(root, [id], CHECK_REGISTRY);
        expect(result.records[id]?.hits).toHaveLength(1);
        expect(corpusSatisfied(result.records[id], result.bindings[id])).toBe(false);
        expect(readFileSync(store, "utf8")).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
