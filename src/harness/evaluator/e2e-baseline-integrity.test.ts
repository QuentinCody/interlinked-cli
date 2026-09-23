import { describe, expect, it, vi } from "vitest";
import { assertE2eTransition, detectE2eBaselineGaming } from "./e2e-baseline-integrity.js";
import type { E2eEntry } from "../e2e-ratchet.js";

const entry = (pct: number): E2eEntry => ({ lines_pct: pct, statements_pct: pct, branches_pct: pct, functions_pct: pct, lines_covered: pct, lines_total: 100 });
describe("e2e baseline value preservation", () => {
    it("refuses a removal when git evidence is unavailable", () => {
        const before = JSON.stringify({ version: 1, updated_at: "fixture", files: { A: entry(90) } });
        const after = JSON.stringify({ version: 1, updated_at: "fixture", files: {} });
        vi.stubEnv("PATH", "");
        try {
            const findings = detectE2eBaselineGaming(".interlinked/coverage-e2e-baseline.json", before, after, { root: process.cwd(), base: "HEAD" });
            expect(findings).toHaveLength(1);
            expect(findings[0]).toMatchObject({ rule: "coverage-e2e-loosening", message: expect.stringContaining("ENOENT") });
        } finally { vi.unstubAllEnvs(); }
    });
    it("permits proven deletion and unchanged transfer", () => {
        expect(() => assertE2eTransition({ A: entry(90), B: entry(50) }, { B: entry(50) }, ["B"], {})).not.toThrow();
        expect(() => assertE2eTransition({ A: entry(90) }, { C: entry(90) }, ["C"], {})).not.toThrow();
    });
    it("refuses removal of a surviving floor and a lowered persistent destination", () => {
        expect(() => assertE2eTransition({ A: entry(90) }, {}, ["A"], {})).toThrow("A");
        expect(() => assertE2eTransition({ A: entry(90), B: entry(10) }, { A: entry(10), B: entry(90) }, ["A", "B"], {})).toThrow("A");
        expect(() => assertE2eTransition({ A: entry(10) }, { A: entry(10) }, ["A"], { A: entry(90) })).toThrow("A");
    });
    it("checks both aggregates on ordinary updates", () => {
        expect(() => assertE2eTransition({ A: entry(50) }, { A: entry(50), B: entry(0) }, ["A", "B"], {})).toThrow("touched_share");
    });
});
