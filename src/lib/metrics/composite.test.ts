import { describe, expect, it } from "vitest";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { COMPOSITE_GROUPS } from "./composite-profile.js";
import { composeScore } from "./composite.js";
import { valueReading } from "./adapter-values.js";
import type { MetricReading } from "./measurement-types.js";

function readings(score: number): MetricReading[] { return METRIC_CATALOG.map(metric => ({ ...valueReading(metric.id, 1, 1), score })); }
describe("composite score contract", () => {
    it("has a fixed 100-point budget and bounded monotonic scores", () => {
        expect(COMPOSITE_GROUPS.reduce((sum, group) => sum + group.weight, 0)).toBe(100);
        expect(composeScore(readings(0)).slopScore).toBe(0);
        expect(composeScore(readings(100)).slopScore).toBe(100);
        expect(composeScore(readings(40)).slopScore).toBe(40);
    });
    it("exposes a missing-evidence interval and withholds a full ranking", () => {
        const rows = readings(20).map(row => row.id === "mutation.survivors" ? { ...row, state: "missing" as const, score: null } : row);
        const result = composeScore(rows);
        expect(result.observedScore).toBe(20);
        expect(result.slopScore).toBeNull();
        expect(result.range).toEqual({ lower: 17, upper: 32 });
        expect(result.evidenceCompleteness).toBe(85);
    });
    it("does not add CRAP or untested-mutant penalties twice", () => {
        const rows = readings(0).map(row => ["coverage.crap", "mutation.uncovered"].includes(row.id) ? { ...row, score: 100 } : row);
        expect(composeScore(rows).slopScore).toBe(0);
    });
    it("caps overlapping reachability findings at the group maximum", () => {
        const one = readings(0).map(row => row.id === "redundancy.unused" ? { ...row, score: 100 } : row);
        const both = one.map(row => row.id === "redundancy.disconnected" ? { ...row, score: 100 } : row);
        expect(composeScore(one).slopScore).toBe(5);
        expect(composeScore(both).slopScore).toBe(5);
    });
    it("cannot hide stale evidence or registry review failures", () => {
        const stale = readings(0).map(row => row.id === "coverage.lines" ? { ...row, state: "stale" as const } : row);
        expect(composeScore(stale).rankingEligible).toBe(false);
        expect(composeScore(readings(0), ["unreviewed registry"]).slopScore).toBeNull();
        expect(() => composeScore([...readings(0), valueReading("tokens", 1, 1)])).toThrow("Duplicate");
    });
});
