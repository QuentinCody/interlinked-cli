import { describe, expect, it } from "vitest";
import { e2eCheckOptions } from "./coverage-e2e.js";

describe("e2e command policy", () => {
    it("rejects scoped checks and unsupported lanes", () => {
        expect(() => e2eCheckOptions({ lane: "e2e", changedFiles: "src/a.ts" })).toThrow("--changed-files");
        expect(() => e2eCheckOptions({ lane: "unit" })).toThrow("e2e");
    });
    it("passes the explicit event base and mappings into one transaction", () => {
        expect(e2eCheckOptions({ lane: "e2e", base: "abc", map: ["A=B"], updateBaseline: true })).toMatchObject({ base: "abc", mappings: ["A=B"], update: true });
    });
});
