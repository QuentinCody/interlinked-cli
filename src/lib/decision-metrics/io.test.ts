import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readEvidenceRecords } from "./io.js";
it("accepts index envelopes but rejects data without provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-io-"));
    try {
        const path = join(root, "input.json");
        writeFileSync(path, JSON.stringify({ modelIdentity: "pinned", records: [] }));
        expect(readEvidenceRecords(path)).toEqual([]);
        writeFileSync(path, JSON.stringify([{ id: "f", evidence: {} }]));
        expect(() => readEvidenceRecords(path)).toThrow(/requires/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
