import { expect, it } from "vitest";
import { meaningVariants } from "./study.js";
import { selectEvidence, CATALOG } from "./contracts.js";
import type { EvidenceRecord } from "./types.js";

it("constructs meaning controls without pretending that missing bodies are passing code", () => {
    const row: EvidenceRecord = {
        id: "f",
        repository: "r",
        revision: "a",
        timestamp: "2026-01-01",
        unit: "function",
        file: "a.ts",
        line: 1,
        evidence: { signature: "f", body: "function f() { return 1; }" },
        provenance: { extractor: "fixture", sourceHash: "s", metricsVersion: "m" },
    };
    const variants = meaningVariants(row);
    const irrelevant = variants.find((v) => v.name === "irrelevant-context")!;
    expect(selectEvidence(irrelevant.record.evidence, CATALOG.name_matches!.on)).toEqual(
        selectEvidence(row.evidence, CATALOG.name_matches!.on),
    );
    const missing = variants.find((v) => v.name === "missing-body")!;
    expect(() => selectEvidence(missing.record.evidence, CATALOG.name_matches!.on)).toThrow();
    expect(row.evidence.body).not.toContain("fully tested");
});
