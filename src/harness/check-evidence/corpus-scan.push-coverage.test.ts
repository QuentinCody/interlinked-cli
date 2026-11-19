import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CheckRegistration } from "../check-registry/types.js";
import { EMPTY_CORPUS } from "./corpus.js";
import { currentCorpusBinding, recordCorpusScan, scanCorpus } from "./corpus-scan.js";
import type { DetectorIdentitySource } from "./detector-closure.js";

let root: string;
const check: CheckRegistration = {
    id: "eval_usage", name: "Eval", description: "Eval", tier: 1,
    determinism: "fully_deterministic", severity: "error", pipeline: "agent_safety",
    phase: "pre_block", fix_instruction: "Remove eval", resultsPropName: "evalUsage", fn: () => [],
};
const stable: DetectorIdentitySource = () => ({ loaded: "detector-a", current: "detector-a" });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "checkers-corpus-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const value = 1;");
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("corpus scan freshness", () => {
    it("N1: an input edit during detector execution does not void a scan of the bytes already captured", () => {
        const result = scanCorpus({ ...check, fn: () => {
            writeFileSync(join(root, "src/a.ts"), "export const value = 2;");
            return [{ line: 1, text: "original finding" }];
        } }, join(root, "src"), root, stable);
        expect(result.hits).toEqual([{ file: join("src", "a.ts"), line: 1, text: "original finding" }]);
        expect(result.failures).toEqual([]);
        expect(result.provenance.complete).toBe(true);
        expect(result.provenance.executed).toBe(1);
        // The binding describes the capture the detector read, not the edited disk.
        expect(result.binding.input).toBe(result.provenance.input);
    });

    it("P1: rejects an on-disk detector identity different from the imported runtime", () => {
        const changed: DetectorIdentitySource = () => ({ loaded: "detector-a", current: "detector-b" });
        const result = scanCorpus(check, join(root, "src"), root, changed);
        expect(result.failures).toEqual([{ file: "detector", message: "detector changed after runtime import" }]);
        expect(result.provenance.detector).toBe("detector-a");
        expect(result.binding.detector).toBe("detector-b");
        expect(result.provenance.complete).toBe(false);
    });

    it("recomputes bindings and rejects historical, mismatched and unreadable scopes", () => {
        const { record } = recordCorpusScan(EMPTY_CORPUS, check, join(root, "src"), root, stable);
        const provenance = record.provenance!;
        const binding = currentCorpusBinding(record, root, check, stable);
        expect(binding).toEqual({ detector: provenance.detector, configuration: provenance.configuration,
            input: provenance.input, scope: "source-and-tests", search_root: "src" });
        expect(currentCorpusBinding({ files_scanned: 1, hits: [], adjudications: {} }, root, check, stable)).toBeUndefined();
        expect(currentCorpusBinding(record, root, { ...check, id: "unawaited_async_assertion" }, stable)).toBeUndefined();
        expect(currentCorpusBinding({ ...record, provenance: { ...provenance, search_root: "other" } }, root, check, stable)).toBeUndefined();
        writeFileSync(join(root, "src/a.ts"), "export const value = 3;");
        const updated = currentCorpusBinding(record, root, check, stable);
        expect(updated).toBeDefined();
        expect(updated!.input).not.toBe(binding!.input);
        // Oversized eligible inputs are explicitly incomplete, independent of OS permissions.
        writeFileSync(join(root, "src/a.ts"), "x".repeat(2_000_001));
        expect(currentCorpusBinding(record, root, check, stable)).toBeUndefined();
    });
});
