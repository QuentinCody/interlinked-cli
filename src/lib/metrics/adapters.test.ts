import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectStaticMeasurements } from "./static-measurements.js";
import { measureCoverageEvidence, measureMutationEvidence } from "./adapter-behavioral.js";
import type { BehavioralObservations } from "./behavioral-types.js";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "metrics-adapters-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("scoring adapters", () => {
    it("finds public-entry cycles and keeps unreferenced public exports", () => {
        const root = fixture({ "package.json": '{"exports":"./index.js"}', "index.js": 'export { b } from "./b.js"; export function publicApi() { return 1; }',
            "b.js": 'import { publicApi } from "./index.js"; export function b() { return publicApi(); }' });
        const result = collectStaticMeasurements(root);
        expect(result.metrics.find(row => row.id === "architecture.cycles")?.value).toBe(100);
        expect(result.findings.filter(row => row.metric === "redundancy.unused")).toEqual([]);
    });
    it("detects renamed exact bodies and distinguishes regex literals", () => {
        const body = '{ const match = /a+/.test(text); if (match) { return text.trim().toLowerCase(); } return text.trim().toUpperCase(); }';
        const result = collectStaticMeasurements(fixture({ "index.js": `export function one(text) ${body}\nexport function two(text) ${body}\nexport function three(text) ${body.replace('/a+/', '/b+/')}` }));
        expect(result.findings.filter(row => row.metric === "redundancy.clones")).toHaveLength(1);
    });
    it("penalizes unsafe receivers but permits narrowed unknown", () => {
        const result = collectStaticMeasurements(fixture({ "index.ts": 'export function safe(x: unknown) { return typeof x === "string" ? x.trim() : ""; }\nexport function unsafe(x: any) { return x.trim(); }' }));
        const findings = result.findings.filter(row => row.metric === "types.unsafe");
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.every(row => row.line === 2)).toBe(true);
    });
    it("evaluates declared contracts and records missing behavior", () => {
        const result = collectStaticMeasurements(fixture({ "index.js": 'export function api() { return 1; }',
            "interlinked.metrics.json": JSON.stringify({ schemaVersion: 1, contracts: [{ kind: "export", path: "index.js", name: "absent" }] }) }));
        expect(result.metrics.find(row => row.id === "contracts.findings")?.value).toBe(100);
        expect(measureCoverageEvidence(result.analysis).every(row => row.state === "missing")).toBe(true);
        expect(measureMutationEvidence(result.analysis).every(row => row.score === null)).toBe(true);
    });
    it("never treats partial evidence or timed-out mutants as a pass", () => {
        const result = collectStaticMeasurements(fixture({ "index.js": 'export const one = 1;', "absent.js": 'export const two = 2;' }));
        const evidence: BehavioralObservations = { kind: "mutation", state: "measured", evidenceId: "fixture", issues: [], coveredFiles: ["index.js"], coverage: [],
            mutants: [{ id: "1", path: "index.js", line: 1, column: 0, endLine: 1, endColumn: 1, operator: "Literal", replacement: "2", outcome: "timeout" }] };
        expect(measureMutationEvidence(result.analysis, evidence).every(row => row.state === "inconclusive")).toBe(true);
    });
});
