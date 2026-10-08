import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckRegistration } from "../check-registry/types.js";
import { EMPTY_CORPUS } from "./corpus.js";
import * as identity from "./corpus-provenance.js";
import { currentCorpusBinding, recordCorpusScan, scanCorpus } from "./corpus-scan.js";

let root: string;
const check: CheckRegistration = {
    id: "eval_usage", name: "Eval", description: "Eval", tier: 1,
    determinism: "fully_deterministic", severity: "error", pipeline: "agent_safety",
    phase: "pre_block", fix_instruction: "Remove eval", resultsPropName: "evalUsage", fn: () => [],
};

beforeEach(() => {
    vi.spyOn(identity, "currentCorpusDetectorIdentity").mockReturnValue(identity.CORPUS_DETECTOR_IDENTITY);
    root = mkdtempSync(join(tmpdir(), "checkers-corpus-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const value = 1;");
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

describe("corpus scan freshness", () => {
    it("reports input changes during detector execution instead of certifying a complete scan", () => {
        const result = scanCorpus({ ...check, fn: () => {
            writeFileSync(join(root, "src/a.ts"), "export const value = 2;");
            return [{ line: 1, text: "original finding" }];
        } }, join(root, "src"), root);
        expect(result.hits).toEqual([{ file: join("src", "a.ts"), line: 1, text: "original finding" }]);
        expect(result.failures).toEqual([{ file: join(root, "src"), message: "input changed during scan" }]);
        expect(result.provenance.complete).toBe(false);
        expect(result.provenance.executed).toBe(1);
    });

    it("rejects an on-disk detector identity different from the imported runtime", () => {
        vi.spyOn(identity, "currentCorpusDetectorIdentity").mockReturnValue("changed-detector");
        const result = scanCorpus(check, join(root, "src"), root);
        expect(result.failures).toEqual([{ file: "detector", message: "detector changed after runtime import" }]);
        expect(result.provenance.detector).toBe(identity.CORPUS_DETECTOR_IDENTITY);
        expect(result.provenance.complete).toBe(false);
    });

    it("recomputes bindings and rejects historical, mismatched and unreadable scopes", () => {
        const { record } = recordCorpusScan(EMPTY_CORPUS, check, join(root, "src"), root);
        const provenance = record.provenance!;
        const binding = currentCorpusBinding(record, root, check.id);
        expect(binding).toEqual({ detector: provenance.detector, configuration: provenance.configuration,
            input: provenance.input, scope: "source-and-tests", search_root: "src" });
        expect(currentCorpusBinding({ files_scanned: 1, hits: [], adjudications: {} }, root, check.id)).toBeUndefined();
        expect(currentCorpusBinding(record, root, "unawaited_async_assertion")).toBeUndefined();
        expect(currentCorpusBinding({ ...record, provenance: { ...provenance, search_root: "other" } }, root, check.id)).toBeUndefined();
        writeFileSync(join(root, "src/a.ts"), "export const value = 3;");
        const updated = currentCorpusBinding(record, root, check.id);
        expect(updated).toBeDefined();
        expect(updated!.input).not.toBe(binding!.input);
        // Oversized eligible inputs are explicitly incomplete, independent of OS permissions.
        writeFileSync(join(root, "src/a.ts"), "x".repeat(2_000_001));
        expect(currentCorpusBinding(record, root, check.id)).toBeUndefined();
    });
});
