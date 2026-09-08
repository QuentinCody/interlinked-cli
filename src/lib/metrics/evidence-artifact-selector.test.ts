import { expect, it } from "vitest";
import { normalizeEvidenceArtifact } from "./evidence-artifact-selector.js";

it("canonicalizes equivalent relative output paths", () => {
    expect(normalizeEvidenceArtifact("./reports/../a.json")).toBe("a.json");
    expect(normalizeEvidenceArtifact("reports\\a.json")).toBe("reports/a.json");
    expect(normalizeEvidenceArtifact("..summary.json")).toBe("..summary.json");
});

it.each(["", ".", "..", "../report.json", "a/../../report.json", "/tmp/report.json", "C:\\report.json", "reports/", "report\0.json"])("rejects artifact selector outside the relative-file contract: %j", value => {
    expect(() => normalizeEvidenceArtifact(value)).toThrow("relative file inside the workspace");
});
