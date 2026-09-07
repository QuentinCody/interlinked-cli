import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { joinDeletionEvidence } from "./deletion-evidence.js";
import { collectStaticMeasurements } from "./static-measurements.js";
import type { BehavioralObservations } from "./behavioral-types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("joins dead-store and coverage observations without claiming proof", () => {
    const root = mkdtempSync(join(tmpdir(), "metrics-deletion-")); roots.push(root);
    writeFileSync(join(root, "index.js"), "export function value() {\nlet x = 1;\nx = 2;\nreturn x;\n}\n");
    const measured = collectStaticMeasurements(root);
    const coverage: BehavioralObservations = { kind: "coverage", state: "measured", evidenceId: "coverage-fixture", issues: [], mutants: [], coveredFiles: ["index.js"],
        coverage: [{ path: "index.js", lines: { covered: 0, total: 3 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 1 }, spans: [], uncoveredLines: [2, 3, 4] }] };
    const candidates = joinDeletionEvidence(measured, coverage);
    expect(candidates.some(row => row.signals.length > 1 && row.evidenceIds.includes("coverage-fixture"))).toBe(true);
    expect(candidates.every(row => row.verdict === "candidate" && row.reviewRequired)).toBe(true);
});
