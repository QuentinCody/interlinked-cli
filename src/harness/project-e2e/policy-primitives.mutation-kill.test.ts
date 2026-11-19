import { describe, expect, it } from "vitest";
import { globList, relativePath } from "./policy-primitives.js";

// Census fault: the `..` segment check became a `startsWith("..")` and survived the
// companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("relativePath — a parent segment anywhere in the path escapes confinement", () => {
    // test-contract: boundary — `src/../../etc/x` leaves the project root just as `../x` does; the refusal must inspect every segment, not the first characters
    it("refuses a path whose interior segment climbs out of the project", () => {
        expect(() => relativePath("src/../../etc/passwd", "p")).toThrow(/confined project-relative path/);
        expect(() => globList(["dist/**", "a/b/../../../x"], "g")).toThrow(/confined project-relative path/);
    });
    // test-contract: public-api — a dotted directory name is not a parent segment
    it("keeps a path with a dotted directory name", () => {
        expect(relativePath("src/..hidden/x.ts", "p")).toBe("src/..hidden/x.ts");
        expect(relativePath("src\\..foo\\x.ts", "p")).toBe("src/..foo/x.ts");
    });
});
