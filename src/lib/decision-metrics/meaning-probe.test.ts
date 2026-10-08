import { expect, it, vi } from "vitest";
vi.mock("./pipeline.js", () => ({ measurePopulation: vi.fn(async () => ({ measurements: [] })) }));
import { probeMeaning } from "./meaning-probe.js";
import { measurePopulation } from "./pipeline.js";
import { parseConfig } from "./config.js";
import type { EvidenceRecord } from "./types.js";

it("uses fresh inference and a shared deadline for all perturbations", async () => {
    const row: EvidenceRecord = {
        id: "f",
        repository: "r",
        revision: "a",
        timestamp: "2026-01-01",
        unit: "function",
        file: "a.ts",
        line: 1,
        evidence: { body: "function f() {}" },
        provenance: { extractor: "test", sourceHash: "s", metricsVersion: "m" },
    };
    const report = await probeMeaning(
        "/tmp",
        row,
        parseConfig({ version: 1, metrics: ["name_matches"] }),
    );
    expect(report.observations.map((row) => row.name)).toContain("singleton:name_matches");
    const calls = vi.mocked(measurePopulation).mock.calls;
    expect(calls.every((call) => call[3]?.fresh === true)).toBe(true);
    expect(new Set(calls.map((call) => call[3]?.deadline)).size).toBe(1);
});
