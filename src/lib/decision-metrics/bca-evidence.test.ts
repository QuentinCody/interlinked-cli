import { expect, it, vi } from "vitest";
vi.mock("./bca.js", () => ({ measureBca: vi.fn(async () => ({ functions: [] })) }));
vi.mock("./git-evidence.js", () => ({
    workingFile: () => "changed source",
    resolveRevision: () => "pinned",
    revisionFile: () => "changed source",
}));
import { enrichBca } from "./bca-evidence.js";
import type { EvidenceRecord } from "./types.js";

it("rejects structural metrics computed on a different source version", async () => {
    const record: EvidenceRecord = {
        id: "f",
        unit: "function",
        repository: "r",
        revision: "a",
        timestamp: "2026-01-01",
        file: "f.ts",
        line: 1,
        evidence: {},
        provenance: { extractor: "test", sourceHash: "not-current", metricsVersion: "native" },
    };
    await expect(
        enrichBca("/tmp", [record], { command: "bca", version: "pinned", deadline: 100 }),
    ).rejects.toThrow(/source changed/);
});
