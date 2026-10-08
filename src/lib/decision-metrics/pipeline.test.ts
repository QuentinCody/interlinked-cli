import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { measurePopulation, measureWithBackend, reinterpretRun } from "./pipeline.js";
import { parseConfig } from "./config.js";
import type { EvidenceRecord } from "./types.js";

it("reports the entire population and reuses probabilities across thresholds", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-pipeline-"));
    const record: EvidenceRecord = {
        id: "f",
        repository: "repo",
        revision: "a",
        timestamp: "2026-01-01",
        unit: "function",
        file: "a.ts",
        line: 1,
        evidence: { signature: "f()", body: "return 1" },
        provenance: { extractor: "test", sourceHash: "abc", metricsVersion: "test" },
    };
    const config = parseConfig({
        version: 1,
        metrics: ["name_matches", "behavior_change"],
        maxRecords: 1,
    });
    let calls = 0;
    const backend = async () => {
        calls++;
        return [
            {
                metric: "name_matches",
                raw: { kind: "yes_no" as const, probability: 0.7 },
                servedModel: "pinned",
                adapterVersion: "test",
                requestHash: "hash",
            },
        ];
    };
    try {
        const first = await measureWithBackend(
            root,
            [record, { ...record, id: "outside-budget" }],
            config,
            { identity: "pinned", backend },
        );
        expect(first.summary).toMatchObject({
            abstained: 1,
            insufficient_evidence: 1,
            unassessed: 2,
        });
        expect(first.population).toBe(4);
        expect(first.completion).toBe(0.25);
        const second = await measureWithBackend(
            root,
            [record],
            { ...config, band: [0.4, 0.6] },
            { identity: "pinned", backend },
        );
        expect(calls).toBe(1);
        expect(second.measurements[0]).toMatchObject({ value: true, provenance: { cached: true } });
        expect(reinterpretRun(first, [0.4, 0.6]).measurements[0]?.value).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

it("records unavailable executables as failed assessments for the full population", async () => {
    const root = mkdtempSync(join(tmpdir(), "decision-failed-"));
    try {
        const record: EvidenceRecord = {
            id: "f",
            repository: "repo",
            revision: "a",
            timestamp: "2026-01-01",
            unit: "function",
            file: "a.ts",
            line: 1,
            evidence: { signature: "f", body: "function f() {}" },
            provenance: { extractor: "test", sourceHash: "s", metricsVersion: "m" },
        };
        const run = await measurePopulation(
            root,
            [record],
            parseConfig({
                version: 1,
                metrics: ["name_matches"],
                command: join(root, "missing-engine"),
            }),
        );
        expect(run.summary.failed).toBe(1);
        expect(run.population).toBe(1);
        expect(run.completion).toBe(0);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
