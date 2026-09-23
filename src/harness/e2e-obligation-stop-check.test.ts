import { describe, expect, it } from "vitest";
import { formatE2eObligationWarning } from "./e2e-obligation-stop-check.js";

describe("session e2e obligation", () => {
    const input = { cwd: "/repo", files: new Set(["/repo/src/hook-entry.ts"]), lanes: ["unit", "base"] };
    it("warns for a boundary edit despite unit or base test evidence", () => {
        expect(formatE2eObligationWarning(input)).toContain("npm run test:e2e");
    });
    it("credits only the current session's lane evidence", () => {
        expect(formatE2eObligationWarning({ ...input, lanes: ["e2e"] })).toBeNull();
        expect(formatE2eObligationWarning(input)).toContain("e2e");
    });
    it("does not warn for ordinary files or tests", () => {
        expect(formatE2eObligationWarning({ ...input, files: ["src/lib/format.ts", "src/hook-entry.test.ts"] })).toBeNull();
    });
});
