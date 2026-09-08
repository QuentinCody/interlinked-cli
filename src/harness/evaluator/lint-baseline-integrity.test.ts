import { describe, expect, it } from "vitest";
import { detectBaselineGaming } from "./baseline-integrity-gate.js";
import { isWaterLinePath } from "./water-line-files.js";

const file = "/repo/.interlinked/lint-baseline.json";
function baseline(count: number): string { return JSON.stringify({ version: 1, entries: { "ruff:.": { fingerprint: count } } }); }

describe("lint baseline integrity", () => {
    it("joins the shared guard surface and blocks additional allowances", () => {
        expect(isWaterLinePath(file)).toBe(true);
        expect(detectBaselineGaming(file, baseline(1), baseline(2))).toEqual([expect.objectContaining({ rule: "lint-allowance-increased", before: 1, after: 2 })]);
    });
    it("allows tightening and blocks removal of scope history", () => {
        expect(detectBaselineGaming(file, baseline(2), baseline(1))).toEqual([]);
        expect(detectBaselineGaming(file, baseline(1), '{"version":1,"entries":{}}')).toEqual([expect.objectContaining({ rule: "lint-scope-removed" })]);
    });
    it("permits first adoption of another language without resetting existing scopes", () => {
        const next = JSON.stringify({ version: 1, entries: { "ruff:.": { fingerprint: 1 }, "eslint:ui": { another: 2 } } });
        expect(detectBaselineGaming(file, baseline(1), next)).toEqual([]);
    });
});
