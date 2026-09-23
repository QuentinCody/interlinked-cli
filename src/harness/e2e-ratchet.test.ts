import { describe, expect, it } from "vitest";
import { compareE2e, moveE2e, parseE2eBaseline, parseE2eReport, retireE2e, type E2eEntry } from "./e2e-ratchet.js";

function entry(covered: number, total = 100): E2eEntry {
    const pct = Math.floor(covered / total * 10_000 + 1e-8) / 100;
    return { lines_pct: pct, branches_pct: pct, statements_pct: pct, functions_pct: pct, lines_covered: covered, lines_total: total };
}
const context = (before: Record<string, E2eEntry>, report: Record<string, E2eEntry>, extra = {}) => ({ before, report, inventory: Object.keys(report), base: {}, mappings: [], ...extra });

describe("strict e2e ratchet counterexamples", () => {
    it("rejects every surviving percentage decrease with zero tolerance", () => {
        expect(() => compareE2e(context({ A: entry(90) }, { A: entry(89) }))).toThrow("A");
    });
    it("permits deletion of a covered file but never excuses a remaining drop", () => {
        expect(compareE2e(context({ A: entry(90), B: entry(50) }, { B: entry(50) }))).toEqual({ B: entry(50) });
        expect(() => compareE2e(context({ A: entry(90), B: entry(50) }, { B: entry(49) }))).toThrow("B");
    });
    it("requires an explicit decision for a deletion plus a new path", () => {
        expect(() => compareE2e(context({ A: entry(90) }, { C: entry(10) }))).toThrow("UNRESOLVED");
    });
    it("preserves a dirty-tree or rewritten rename floor without any commit anchor", () => {
        expect(() => compareE2e(context({ B: entry(90) }, { C: entry(10) }, { mappings: ["B=C"] }))).toThrow("C");
        expect(compareE2e(context({ B: entry(90) }, { C: entry(95) }, { mappings: ["B=C"] }))).toEqual({ C: entry(95) });
    });
    it("recovers a chain in one measured transaction", () => {
        const before = { A: entry(50), B: entry(90) };
        const ctx = context(before, { B: entry(95), C: entry(95) }, { mappings: ["A=B", "B=C"], base: before });
        expect(() => moveE2e(ctx)).toThrow("B");
        expect(compareE2e(ctx)).toEqual(ctx.report);
        expect(() => compareE2e({ ...ctx, report: { B: entry(85), C: entry(95) } })).toThrow("B");
    });
    it("cannot swap floors even for paths added since the base", () => {
        const ctx = context({ A: entry(90), B: entry(10) }, { A: entry(10), B: entry(90) }, { mappings: ["A=B", "B=A"] });
        expect(() => moveE2e(ctx)).toThrow("A");
        expect(() => compareE2e(ctx)).toThrow("A");
    });
    it("checks base floors even if the working baseline was lowered", () => {
        expect(() => compareE2e(context({ A: entry(10) }, { A: entry(10) }, { base: { A: entry(90) } }))).toThrow("A");
    });
    it("treats counts as measurements, allowing 50/100 to become 50/50", () => {
        expect(compareE2e(context({ A: entry(50) }, { A: entry(50, 50) }))).toEqual({ A: entry(50, 50) });
    });
    it("enforces touched share when an untouched new file dilutes it", () => {
        expect(() => compareE2e(context({ A: entry(50) }, { A: entry(50), B: entry(0) }))).toThrow("touched_share");
        expect(compareE2e(context({ A: entry(50), B: entry(0) }, { A: entry(50), B: entry(50), C: entry(0) }))).toEqual({ A: entry(50), B: entry(50), C: entry(0) });
    });
    it("enforces weighted lines even when every percentage and touched share is unchanged", () => {
        expect(() => compareE2e(context({ A: entry(100), B: entry(1, 10) }, { A: entry(1, 1), B: entry(1, 10) }))).toThrow("weighted_lines");
    });
    it("requires exact membership, refusing partial and unexpected report files", () => {
        expect(() => compareE2e({ ...context({ A: entry(50) }, {}), inventory: ["A"] })).toThrow("inventory");
        expect(() => compareE2e({ ...context({}, { A: entry(50) }), inventory: [] })).toThrow("inventory");
    });
    it("refuses mapping collisions, surviving sources and occupied destinations", () => {
        const before = { A: entry(50), B: entry(90) };
        for (const mappings of [["A=C", "B=C"], ["A=C", "A=D"], ["A=B"]])
            expect(() => moveE2e({ before, base: {}, inventory: ["B", "C", "D"], mappings })).toThrow();
        expect(() => moveE2e({ before, base: {}, inventory: ["A", "C"], mappings: ["A=C"] })).toThrow();
        expect(() => retireE2e(before, "A", ["A"])).toThrow();
        expect(retireE2e(before, "A", ["B"])).toEqual({ B: entry(90) });
    });
});

describe("strict baseline loading", () => {
    it("preserves every JSON key so unexpected names cannot evade membership checks", () => {
        const files = Object.fromEntries([["__proto__", entry(50)]]);
        expect(Object.keys(parseE2eBaseline({ version: 1, updated_at: "now", files }).files)).toEqual(["__proto__"]);
        const metric = { total: 100, covered: 50, pct: 50 };
        const report = parseE2eReport(Object.fromEntries([["__proto__", { lines: metric, statements: metric, branches: metric, functions: metric }]]));
        expect(() => compareE2e({ ...context({}, report), inventory: [] })).toThrow("inventory");
    });
    it("validates integer counts and the report's two-decimal rounding", () => {
        const files = { A: entry(1, 3) };
        expect(parseE2eBaseline({ version: 1, updated_at: "now", files }).files).toEqual(files);
        for (const bad of [null, {}, { version: 1, files: {} }, { version: 1, updated_at: "now", files: { A: { ...entry(1), lines_total: 0 } } }, { version: 1, updated_at: "now", files: { A: { ...entry(1), lines_covered: 2 } } }])
            expect(() => parseE2eBaseline(bad)).toThrow();
    });
});
