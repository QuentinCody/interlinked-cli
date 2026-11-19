import { describe, expect, it } from "vitest";
import { structuredCase } from "./browser-stage.js";

// Census fault: `STRUCTURED_STATE.skipped` "unavailable" → "passed" survived the
// companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("structuredCase — a skipped or todo native case is never a pass", () => {
    // test-contract: invariant — plan §11: a skipped case produced no observation, so its receipt state is unavailable with the reason recorded, never passed
    it("maps a skipped report case to an unavailable receipt case that says so", () => {
        const row = structuredCase("json", { id: "orders/create", status: "skipped" });
        expect(row.state).toBe("unavailable");
        expect(row.details).toContain("skipped: not a required pass");
    });
    // test-contract: invariant — an expected-failure (todo) case is likewise not a pass; only passed maps to passed
    it("maps todo to unavailable and passed to passed", () => {
        expect(structuredCase("junit", { id: "orders/todo", status: "todo" }).state).toBe("unavailable");
        expect(structuredCase("junit", { id: "orders/ok", status: "passed" }).state).toBe("passed");
    });
});
