import { describe, expect, it } from "vitest";
import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import { BUILTIN_RULES } from "../../harness/rules/builtin-rules.js";
import { buildMetricCatalog } from "./catalog.js";
import { SCORED_CHECKS } from "./catalog-policy.js";
import { REVIEWED_REGISTRY_HASH } from "./catalog-review.js";

describe("complete metric catalog", () => {
    it("requires review when a check is added, removed, or reclassified", () => {
        expect(buildMetricCatalog().registryHash).toBe(REVIEWED_REGISTRY_HASH);
    });
    it("accounts for every inline check and command guard without mixing their score authority", () => {
        const catalog = buildMetricCatalog();
        expect(catalog.checks.filter(check => check.family === "inline").map(check => check.id).sort())
            .toEqual(CHECK_REGISTRY.map(check => check.id).sort());
        expect(catalog.checks.filter(check => check.family === "guard").map(check => check.id).sort())
            .toEqual(BUILTIN_RULES.map(rule => rule.id).sort());
        expect(catalog.checks.filter(check => check.family === "guard").every(check => check.disposition === "enforcement")).toBe(true);
    });
    it("requires reviewed scored adapters to exist in the live registry", () => {
        const ids = new Set(CHECK_REGISTRY.map(check => check.id));
        expect(Object.keys(SCORED_CHECKS).filter(id => !ids.has(id))).toEqual([]);
        const metrics = buildMetricCatalog().metrics;
        expect(new Set(metrics.map(metric => metric.id)).size).toBe(metrics.length);
        expect(metrics.find(metric => metric.id === "coverage.crap")?.denominator).toBe("functions with matching coverage spans");
    });
});
